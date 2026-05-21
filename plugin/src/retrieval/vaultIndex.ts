import { App, TFile } from 'obsidian';
import { buildBm25Stats, type Bm25Stats } from './bm25';
import { buildNoteRecord, selectRelevantNoteContent } from './chunker';
import { buildFrontmatterContextText, buildFrontmatterSchemaText, buildFrontmatterSnapshot, buildTemplateSchemaText, type FrontmatterSnapshot } from './frontmatterIndex';
import { cosineSimilarity, embedText, getEmbeddingBackend, type EmbeddingConfig } from './embeddings';
import { computePersonalizedRanks } from './linkGraph';
import { rerankSearchResults } from './reranker';
import { searchVaultIndex } from './searchEngine';
import { getVectorStore } from './vectorStore';
import { buildVaultMapText } from './vaultMap';
import type { LinkedNoteSummary, VaultNoteRecord, VaultSearchFilters, VaultSearchResult } from './types';

const AIIGNORE_PATH = '.aiignore';
const GLOBSTAR_TOKEN = '__AI_AGENT_GLOBSTAR__';

const indexCache = new WeakMap<App, VaultIndex>();

type SerializedVaultIndex = {
	snapshotKey: string;
	notes: VaultNoteRecord[];
};

function parseIgnorePatterns(content: string): string[] {
	return content
		.split('\n')
		.map(line => line.trim())
		.filter(line => line.length > 0 && !line.startsWith('#'));
}

function globToRegexStr(glob: string): string {
	return glob
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*\*/g, GLOBSTAR_TOKEN)
		.replace(/\*/g, '[^/]*')
		.replace(/\?/g, '[^/]')
		.replace(new RegExp(GLOBSTAR_TOKEN, 'g'), '.*');
}

function stringifyFrontmatterValue(value: unknown): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return '';
}

function isIgnoredPath(filePath: string, patterns: string[]): boolean {
	for (const raw of patterns) {
		const rooted = raw.startsWith('/');
		const p = rooted ? raw.slice(1) : raw;
		const withoutTrailing = p.replace(/\/$/, '');
		// Treat as folder if ends with /, or has no dot and no wildcard
		const isFolder = p.endsWith('/') || (!withoutTrailing.includes('.') && !withoutTrailing.includes('*'));
		const re = globToRegexStr(withoutTrailing);

		if (rooted) {
			const regex = isFolder
				? new RegExp(`^${re}(/|$)`)
				: new RegExp(`^${re}$`);
			if (regex.test(filePath)) return true;
		} else {
			const regex = isFolder
				? new RegExp(`(^|/)${re}(/|$)`)
				: new RegExp(`(^|/)${re}$`);
			if (regex.test(filePath)) return true;
		}
	}
	return false;
}

function toStringArray(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map(item => String(item)).filter(Boolean);
	}
	if (typeof value === 'string' && value.trim()) return [value.trim()];
	return [];
}

function deriveSummary(note: VaultNoteRecord, maxChars = 220): string {
	const explicit = note.frontmatter['summary'] ?? note.frontmatter['description'] ?? note.frontmatter['abstract'];
	if (typeof explicit === 'string' && explicit.trim()) {
		const value = explicit.trim();
		return value.length > maxChars ? value.slice(0, maxChars) + '...' : value;
	}

	const bodyChunk = note.chunks.find(chunk => chunk.blockType !== 'frontmatter' && chunk.content.trim());
	if (!bodyChunk) return '';

	const plain = bodyChunk.content
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/\[\[([^\]]+)\]\]/g, '$1')
		.replace(/\s+/g, ' ')
		.trim();
	if (!plain) return '';
	return plain.length > maxChars ? plain.slice(0, maxChars) + '...' : plain;
}

export class VaultIndex {
	private snapshotKey = '';
	private notes = new Map<string, VaultNoteRecord>();
	private dirtyPaths = new Set<string>();
	private fullRebuildRequired = true;
	private ignorePatterns: string[] = [];
	private ignoreLoaded = false;
	private noteStats: Bm25Stats | null = null;    // BM25 corpus over full note texts
	private chunkStats: Bm25Stats | null = null;   // BM25 corpus over individual chunks
	private warmPromise: Promise<void> | null = null;
	private frontmatterSnapshot: FrontmatterSnapshot | null = null;
	private embeddingConfig: EmbeddingConfig = { backend: 'local' };

	constructor(private app: App) {}

	setEmbeddingConfig(config: EmbeddingConfig) {
		this.embeddingConfig = config;
	}

	/** Call when .aiignore is created/modified/deleted to force a full reindex. */
	invalidateIgnore() {
		this.ignoreLoaded = false;
		this.fullRebuildRequired = true;
		this.snapshotKey = '';
		this.noteStats = null;
		this.chunkStats = null;
		this.frontmatterSnapshot = null;
	}

	hydrate(data: SerializedVaultIndex | null | undefined) {
		if (!data?.notes?.length) return;
		this.snapshotKey = data.snapshotKey ?? '';
		this.notes = new Map(data.notes.map(note => [note.path, note]));
		this.fullRebuildRequired = false;
		// Corpus stats are not serialized — rebuild lazily on first search
		this.rebuildCorpora();
	}

	exportData(): SerializedVaultIndex {
		return {
			snapshotKey: this.snapshotKey,
			notes: Array.from(this.notes.values()),
		};
	}

	markDirty(path?: string) {
		if (!path?.toLowerCase().endsWith('.md')) return;
		this.dirtyPaths.add(path);
		this.noteStats = null;
		this.chunkStats = null;
		this.frontmatterSnapshot = null;
	}

	remove(path?: string) {
		if (!path?.toLowerCase().endsWith('.md')) return;
		this.notes.delete(path);
		this.dirtyPaths.delete(path);
		this.snapshotKey = '';
		this.noteStats = null;
		this.chunkStats = null;
		this.frontmatterSnapshot = null;
	}

	rename(oldPath?: string, newPath?: string) {
		if (oldPath) this.remove(oldPath);
		if (newPath) this.markDirty(newPath);
	}

	invalidateAll() {
		this.fullRebuildRequired = true;
		this.snapshotKey = '';
	}

	private async loadIgnorePatterns(): Promise<void> {
		const f = this.app.vault.getAbstractFileByPath(AIIGNORE_PATH);
		if (!(f instanceof TFile)) {
			this.ignorePatterns = [];
			return;
		}
		const content = await this.app.vault.read(f);
		this.ignorePatterns = parseIgnorePatterns(content);
		this.ignoreLoaded = true;
	}

	private isIgnored(filePath: string): boolean {
		return isIgnoredPath(filePath, this.ignorePatterns);
	}

	private buildSnapshotKey(): string {
		const files = this.app.vault.getMarkdownFiles().filter(f => !this.isIgnored(f.path));
		let latestMtime = 0;
		let totalSize = 0;
		for (const file of files) {
			if (file.stat.mtime > latestMtime) latestMtime = file.stat.mtime;
			totalSize += file.stat.size;
		}
		return `${files.length}:${latestMtime}:${totalSize}`;
	}

	private async ensureFresh(): Promise<void> {
		if (!this.ignoreLoaded) {
			await this.loadIgnorePatterns();
		}
		const nextKey = this.buildSnapshotKey();
		if (
			!this.fullRebuildRequired &&
			this.dirtyPaths.size === 0 &&
			nextKey === this.snapshotKey &&
			this.notes.size > 0
		) {
			return;
		}

		if (this.fullRebuildRequired || this.notes.size === 0) {
			await this.rebuildAll(nextKey);
			return;
		}

		await this.refreshDirtyPaths(nextKey);
	}

	private async rebuildAll(nextKey: string): Promise<void> {
		const nextNotes = new Map<string, VaultNoteRecord>();
		let count = 0;
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (this.isIgnored(file.path)) continue;
			const note = await this.buildRecordForFile(file);
			nextNotes.set(file.path, note);
			// Yield to the event loop every 50 files to keep the UI responsive
			if (++count % 50 === 0) {
				await new Promise<void>(r => setTimeout(r, 0));
			}
		}

		this.notes = nextNotes;
		this.snapshotKey = nextKey;
		this.fullRebuildRequired = false;
		this.dirtyPaths.clear();
		this.rebuildCorpora();
	}

	private async refreshDirtyPaths(nextKey: string): Promise<void> {
		for (const path of this.dirtyPaths) {
			if (this.isIgnored(path)) {
				this.notes.delete(path);
				continue;
			}
			const abstractFile = this.app.vault.getAbstractFileByPath(path);
			if (!(abstractFile instanceof TFile)) {
				this.notes.delete(path);
				continue;
			}

			const note = await this.buildRecordForFile(abstractFile);
			this.notes.set(path, note);
		}

		const livePaths = new Set(
			this.app.vault.getMarkdownFiles()
				.filter(f => !this.isIgnored(f.path))
				.map(f => f.path),
		);
		for (const path of this.notes.keys()) {
			if (!livePaths.has(path)) this.notes.delete(path);
		}

		this.snapshotKey = nextKey;
		this.dirtyPaths.clear();
		this.rebuildCorpora();
	}

	/** Build BM25 corpus stats from the current notes. Called after any index update. */
	private rebuildCorpora(): void {
		const noteList = Array.from(this.notes.values());
		const noteTexts = noteList.map(note => note.chunks.filter(chunk => chunk.blockType !== 'block').map(c => c.searchText).join(' '));
		const chunkTexts = noteList.flatMap(note => note.chunks.map(c => c.searchText));
		this.noteStats = buildBm25Stats(noteTexts);
		this.chunkStats = buildBm25Stats(chunkTexts);
		this.frontmatterSnapshot = buildFrontmatterSnapshot(noteList);
	}

	private async buildRecordForFile(file: TFile): Promise<VaultNoteRecord> {
		const content = await this.app.vault.cachedRead(file);
		const cache = this.app.metadataCache.getFileCache(file);
		const frontmatter = (cache?.frontmatter ?? {}) as Record<string, unknown>;
		const aliases = [
			...toStringArray(frontmatter['alias']),
			...toStringArray(frontmatter['aliases']),
		];
		const links = (cache?.links ?? [])
			.map(link => this.app.metadataCache.getFirstLinkpathDest(link.link, file.path)?.path ?? link.link)
			.filter(Boolean);
		const title = typeof frontmatter['title'] === 'string' && frontmatter['title'].trim()
			? frontmatter['title'].trim()
			: file.basename;
		return buildNoteRecord({
			path: file.path,
			name: file.name,
			basename: file.basename,
			title,
			folder: file.parent?.path ?? '',
			mtime: file.stat.mtime,
			size: file.stat.size,
			content,
			headings: (cache?.headings ?? []).map(heading => ({
				level: heading.level,
				text: heading.heading,
			})),
			tags: (cache?.tags ?? []).map(tag => tag.tag),
			aliases,
			links,
			frontmatter,
		});
	}

	async getNote(path: string): Promise<VaultNoteRecord | null> {
		await this.ensureFresh();
		return this.notes.get(path) ?? null;
	}

	async prewarm(): Promise<void> {
		if (this.warmPromise) {
			await this.warmPromise;
			return;
		}
		this.warmPromise = this.ensureFresh().finally(() => {
			this.warmPromise = null;
		});
		await this.warmPromise;
	}

	async getNotes(): Promise<VaultNoteRecord[]> {
		await this.ensureFresh();
		return Array.from(this.notes.values());
	}

	async buildPromptContent(path: string, query: string, maxChars: number): Promise<string | null> {
		const note = await this.getNote(path);
		if (!note) return null;
		return selectRelevantNoteContent(note, query, maxChars);
	}

	async buildPromptContentForChunk(path: string, chunkId: string, query: string, maxChars: number): Promise<string | null> {
		const note = await this.getNote(path);
		if (!note) return null;
		const chunk = note.chunks.find(item => item.id === chunkId);
		if (!chunk) return selectRelevantNoteContent(note, query, maxChars);

		const sectionLabel = chunk.sectionPath.length
			? chunk.sectionPath.join(' > ')
			: note.title;
		const prefix = `[${sectionLabel} | ${chunk.blockType}]\n`;
		const available = Math.max(0, maxChars - prefix.length);
		const body = chunk.content.length > available
			? `${chunk.content.slice(0, Math.max(0, available - 3))}...`
			: chunk.content;
		return prefix + body;
	}

	async expandChunk(chunkId: string, maxChars = 12000): Promise<{
		chunk_id: string;
		path: string;
		name: string;
		heading?: string;
		section_path: string[];
		block_type: string;
		line_range: [number, number];
		content: string;
	} | null> {
		await this.ensureFresh();
		for (const note of this.notes.values()) {
			const chunk = note.chunks.find(item => item.id === chunkId);
			if (!chunk) continue;
			return {
				chunk_id: chunk.id,
				path: note.path,
				name: note.name,
				heading: chunk.heading,
				section_path: chunk.sectionPath,
				block_type: chunk.blockType,
				line_range: [chunk.startLine, chunk.endLine],
				content: chunk.content.length > maxChars ? `${chunk.content.slice(0, maxChars)}\n\n[... truncated ...]` : chunk.content,
			};
		}
		return null;
	}

	async buildFrontmatterContext(options?: {
		type?: string;
		status?: string;
		tag?: string | string[];
		project?: string;
		topic?: string;
		paths?: string[];
		limit?: number;
	}): Promise<string | null> {
		const notes = await this.getNotes();
		let filtered = notes;
		if (options?.paths?.length) {
			const allowed = new Set(options.paths);
			filtered = filtered.filter(note => allowed.has(note.path));
		}
		const filterType = options?.type;
		const filterStatus = options?.status;
		const filterProject = options?.project;
		const filterTopic = options?.topic;
		if (filterType) filtered = filtered.filter(note => stringifyFrontmatterValue(note.frontmatter['type']).toLowerCase() === filterType.toLowerCase());
		if (filterStatus) filtered = filtered.filter(note => stringifyFrontmatterValue(note.frontmatter['status']).toLowerCase() === filterStatus.toLowerCase());
		if (options?.tag) {
			const tags = Array.isArray(options.tag) ? options.tag : [options.tag];
			const normalized = tags.map(tag => tag.toLowerCase().replace(/^#/, ''));
			filtered = filtered.filter(note => normalized.every(tag => note.tags.map(item => item.toLowerCase().replace(/^#/, '')).includes(tag)));
		}
		if (filterProject) filtered = filtered.filter(note => stringifyFrontmatterValue(note.frontmatter['project']).toLowerCase() === filterProject.toLowerCase());
		if (filterTopic) filtered = filtered.filter(note => stringifyFrontmatterValue(note.frontmatter['topic']).toLowerCase() === filterTopic.toLowerCase());
		return buildFrontmatterContextText(filtered, options?.limit ?? 12);
	}

	async buildFrontmatterSchemaSummary(paths?: string[], maxFields = 18): Promise<string | null> {
		const notes = await this.getNotes();
		const filtered = paths?.length
			? notes.filter(note => paths.includes(note.path))
			: notes;
		return buildFrontmatterSchemaText(filtered, maxFields);
	}

	async buildTemplateSchemaSummary(paths?: string[], maxTemplates = 6): Promise<string | null> {
		const notes = await this.getNotes();
		const filtered = paths?.length
			? notes.filter(note => paths.includes(note.path))
			: notes;
		return buildTemplateSchemaText(filtered, maxTemplates);
	}

	async buildVaultManifest(limit = 500): Promise<Array<{ path: string; name: string; snippet?: string }>> {
		const notes = await this.getNotes();
		return notes
			.sort((a, b) => a.path.localeCompare(b.path))
			.slice(0, limit)
			.map(note => {
				const summary = note.summary;
				const headings = note.headings.slice(0, 4).map(heading => heading.text);
				const parts = [
					note.tags.length ? `T: ${note.tags.slice(0, 6).join(' ')}` : '',
					headings.length ? `H: ${headings.join(' | ')}` : '',
					note.aliases.length ? `A: ${note.aliases.slice(0, 4).join(' | ')}` : '',
					summary ? `S: ${summary}` : '',
				].filter(Boolean);

				return {
					path: note.path,
					name: note.name,
					snippet: parts.join('  ') || undefined,
				};
			});
	}

	async buildVaultMap(options?: {
		activePath?: string;
		referencedPaths?: string[];
		recentPaths?: string[];
		limit?: number;
	}): Promise<string> {
		const notes = await this.getNotes();
		this.ensureSummariesForTopNotes(notes, options?.limit ?? 12, options);
		return buildVaultMapText(notes, options);
	}

	async getBacklinkSummaries(path: string, limit = 8): Promise<LinkedNoteSummary[]> {
		const notes = await this.getNotes();
		return notes
			.filter(note => note.path !== path && note.links.includes(path))
			.sort((a, b) => b.links.length - a.links.length || a.path.localeCompare(b.path))
			.slice(0, limit)
			.map(note => ({
				path: note.path,
				title: note.title,
				summary: this.ensureSummary(note),
				tags: note.tags,
				linkCount: note.links.filter(link => link === path).length,
			}));
	}

	async getForwardLinkSummaries(path: string, limit = 8): Promise<LinkedNoteSummary[]> {
		const note = await this.getNote(path);
		if (!note) return [];

		const notes = await this.getNotes();
		const byPath = new Map(notes.map(item => [item.path, item] as const));
		const uniqueTargets = Array.from(new Set(note.links)).filter(link => byPath.has(link));

		return uniqueTargets
			.slice(0, limit)
			.map(linkPath => {
				const target = byPath.get(linkPath)!;
				return {
					path: target.path,
					title: target.title,
					summary: this.ensureSummary(target),
					tags: target.tags,
					linkCount: target.links.length,
				};
			});
	}

	async search(
		query: string,
		options?: {
			limit?: number;
			activePath?: string;
			referencedPaths?: string[];
			recentPaths?: string[];
			folderPath?: string;
			excludePaths?: string[];
			filters?: VaultSearchFilters;
		},
	): Promise<VaultSearchResult[]> {
		const notes = await this.getNotes();
		let hits = searchVaultIndex(notes, query, {
			...options,
			noteStats: this.noteStats ?? undefined,
			chunkStats: this.chunkStats ?? undefined,
		});
		if (hits.length === 0 || !query.trim()) return hits;

		const noteMap = new Map(notes.map(note => [note.path, note] as const));

		try {
			const queryVector = await embedText(query, {
				...this.embeddingConfig,
				backend: getEmbeddingBackend(this.embeddingConfig.backend),
			});
			const vectorStore = getVectorStore(this.app);
			hits = await Promise.all(hits.map(async hit => {
				const note = noteMap.get(hit.path);
				const chunk = note?.chunks.find(item => item.id === hit.chunk_id);
				const hash = chunk?.hash ?? chunk?.id;
				if (!hash) return hit;
				const stored = await vectorStore.get(hash);
				if (!stored?.vector?.length) return hit;
				const denseScore = cosineSimilarity(queryVector, stored.vector);
				return {
					...hit,
					score: hit.score + Math.max(0, denseScore) * 0.12,
					reasons: Array.from(new Set([...(hit.reasons ?? []), denseScore > 0.35 ? 'dense' : 'vector'])),
					retrieval_scores: {
						...(hit.retrieval_scores ?? {}),
						final: hit.score + Math.max(0, denseScore) * 0.12,
						dense: denseScore,
					},
				};
			}));
			hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
		} catch {
			// Dense pass is optional. Fallback remains BM25 + graph + semantic sketch.
		}
		hits = rerankSearchResults(query, hits, noteMap, 20);
		return hits;
	}

	private ensureSummary(note: VaultNoteRecord): string {
		if (note.summary) return note.summary;
		note.summary = deriveSummary(note);
		return note.summary;
	}

	private ensureSummariesForTopNotes(
		notes: VaultNoteRecord[],
		limit: number,
		options?: {
			activePath?: string;
			referencedPaths?: string[];
			recentPaths?: string[];
		},
	) {
		const ranks = computePersonalizedRanks(notes, options);
		const byPriority = notes
			.map(note => {
				let score = (ranks.get(note.path) ?? 0) * 100;
				if (options?.activePath && note.path === options.activePath) score += 20;
				if (options?.referencedPaths?.includes(note.path)) score += 12;
				if (options?.recentPaths?.includes(note.path)) score += 8;
				score += note.links.length;
				return { note, score };
			})
			.sort((a, b) => b.score - a.score || a.note.path.localeCompare(b.note.path))
			.slice(0, limit);

		for (const item of byPriority) {
			this.ensureSummary(item.note);
		}
	}
}

export function getVaultIndex(app: App): VaultIndex {
	let index = indexCache.get(app);
	if (!index) {
		index = new VaultIndex(app);
		indexCache.set(app, index);
	}
	return index;
}
