import { App, MarkdownView, TFile, TFolder, normalizePath } from 'obsidian';
import { getVaultIndex } from '../retrieval/vaultIndex';
import { normalizeDataviewResult } from '../retrieval/dataviewHelpers';
import type { VaultSearchFilters } from '../retrieval/types';
import { llmRerankSearchResults } from '../retrieval/reranker';
import type { LlmCallFn } from '../retrieval/reranker';

export const USER_PREFERENCES_PATH = 'user_preferences.md';
export const AGENT_MEMORY_PATH = '.ai/agent_memory.md';

type DataviewQueryResult = {
	successful: boolean;
	value: unknown;
	error?: string;
};

type DataviewApi = {
	query: (dql: string) => Promise<DataviewQueryResult>;
};

function tokenizeMemoryQuery(text: string): string[] {
	return Array.from(new Set(
		text.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [],
	));
}

function selectRelevantMemory(content: string, query?: string, maxChars = 12000): string {
	if (!content.trim()) return content;
	if (!query?.trim()) return content.length > maxChars ? content.slice(0, maxChars) + '\n\n[... truncated ...]' : content;

	const tokens = tokenizeMemoryQuery(query);
	if (!tokens.length) return content.length > maxChars ? content.slice(0, maxChars) + '\n\n[... truncated ...]' : content;

	const sections = content.split(/\n(?=##\s+)/g);
	const header = sections.shift() ?? '';
	const scored = sections.map((section, index) => {
		const lower = section.toLowerCase();
		const score = tokens.reduce((sum, token) => sum + (lower.includes(token) ? 1 : 0), 0);
		return { section, index, score };
	});
	const relevant = scored
		.filter(item => item.score > 0)
		.sort((a, b) => b.score - a.score || b.index - a.index)
		.slice(0, 3)
		.sort((a, b) => a.index - b.index)
		.map(item => item.section);

	const selected = relevant.length > 0
		? [header.trim(), ...relevant].filter(Boolean).join('\n\n')
		: [header.trim(), ...sections.slice(-2)].filter(Boolean).join('\n\n');
	return selected.length > maxChars ? selected.slice(0, maxChars) + '\n\n[... truncated ...]' : selected;
}

function stringifyFrontmatterValue(value: unknown): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return '';
}

function getDataviewApi(app: App): DataviewApi | null {
	const pluginHost = app as App & {
		plugins?: {
			plugins?: Record<string, unknown>;
		};
	};
	const maybePlugin = pluginHost.plugins?.plugins?.['dataview'];
	if (!maybePlugin || typeof maybePlugin !== 'object') return null;
	const maybeApi = (maybePlugin as { api?: unknown }).api;
	if (!maybeApi || typeof maybeApi !== 'object') return null;
	const query = (maybeApi as { query?: unknown }).query;
	if (typeof query !== 'function') return null;
	return maybeApi as DataviewApi;
}

export class ObsidianVaultTools {
	private app: App;

	constructor(app: App) {
		this.app = app;
	}

	private safePath(path: string): string {
		const normalized = normalizePath(path.trim());
		if (!normalized) throw new Error('Path is empty.');
		const configDir = normalizePath(this.app.vault.configDir);
		if (normalized === configDir || normalized.startsWith(`${configDir}/`)) {
			throw new Error(`Access to ${configDir} is blocked.`);
		}
		if (normalized.includes('..')) {
			throw new Error('Parent path traversal is blocked.');
		}
		return normalized;
	}

	listFiles() {
		return this.app.vault.getMarkdownFiles().map(file => ({
			path: file.path,
			name: file.name,
			basename: file.basename,
			extension: file.extension,
		}));
	}

	async readFile(path: string, maxChars = 60000) {
		const safePath = this.safePath(path);
		const file = this.app.vault.getAbstractFileByPath(safePath);
		if (!(file instanceof TFile)) throw new Error(`File not found: ${safePath}`);
		const content = await this.app.vault.cachedRead(file);
		return {
			path: file.path,
			name: file.name,
			content: content.length > maxChars ? content.slice(0, maxChars) + '\n\n[... truncated ...]' : content,
		};
	}

	async readActiveFile(maxChars = 60000) {
		const file = this.app.workspace.getActiveFile();
		if (!file) return null;
		const content = await this.app.vault.cachedRead(file);
		return {
			path: file.path,
			name: file.name,
			content: content.length > maxChars ? content.slice(0, maxChars) + '\n\n[... truncated ...]' : content,
		};
	}

	readSelectedText() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return null;
		const selectedText = view.editor.getSelection();
		if (!selectedText?.trim()) return null;
		return { path: view.file?.path ?? null, content: selectedText };
	}

	async searchVault(query: string, limit = 20, filters?: VaultSearchFilters, llmRerankFn?: LlmCallFn | null) {
		const normalizedQuery = query.toLowerCase().trim();
		const hasFilter = Boolean(
			filters?.type ||
			filters?.status ||
			filters?.tag ||
			filters?.alias ||
			filters?.folder ||
			filters?.path ||
			filters?.after ||
			filters?.before,
		);
		if (!normalizedQuery && !hasFilter) return [];

		const activePath = this.app.workspace.getActiveFile()?.path;
		let results = await getVaultIndex(this.app).search(query, {
			limit,
			activePath,
			filters,
		});

		if (llmRerankFn && results.length > 1) {
			results = await llmRerankSearchResults(query, results, llmRerankFn);
		}

		return results.map(result => ({
			path: result.path,
			name: result.name,
			chunk_id: result.chunk_id,
			block_type: result.block_type,
			line_range: result.line_range,
			heading: result.heading,
			section_path: result.sectionPath,
			retrieval_reasons: result.reasons,
			retrieval_scores: result.retrieval_scores,
			frontmatter: result.frontmatter,
			snippet: [
				(() => {
					const meta = [
						result.frontmatter['type'] ? `type: ${stringifyFrontmatterValue(result.frontmatter['type'])}` : '',
						result.frontmatter['status'] ? `status: ${stringifyFrontmatterValue(result.frontmatter['status'])}` : '',
						result.tags.length ? `tags: ${result.tags.slice(0, 6).join(',')}` : '',
					].filter(Boolean);
					return meta.length ? `[${meta.join(', ')}]` : '';
				})(),
				result.reasons?.length ? `Why: ${result.reasons.join(' | ')}` : '',
				result.heading ? `Section: ${result.heading}` : '',
				result.aliases.length ? `Aliases: ${result.aliases.slice(0, 4).join(' | ')}` : '',
				result.snippet,
			].filter(Boolean).join('\n'),
		}));
	}

	async expandChunk(chunkId: string, maxChars = 12000) {
		const expanded = await getVaultIndex(this.app).expandChunk(chunkId, maxChars);
		if (!expanded) throw new Error(`Chunk not found: ${chunkId}`);
		return expanded;
	}

	async readFolder(path: string, maxFiles = 30, maxCharsPerFile = 12000) {
		const safePath = this.safePath(path);
		const folder = this.app.vault.getAbstractFileByPath(safePath);
		if (!(folder instanceof TFolder)) throw new Error(`Folder not found: ${safePath}`);

		const files = this.app.vault.getMarkdownFiles()
			.filter(file => file.path.startsWith(`${safePath}/`))
			.slice(0, maxFiles);

		const result = [];
		for (const file of files) {
			const content = await this.app.vault.cachedRead(file);
			result.push({
				path: file.path,
				name: file.name,
				content: content.length > maxCharsPerFile
					? content.slice(0, maxCharsPerFile) + '\n\n[... truncated ...]'
					: content,
			});
		}

		return { path: safePath, files: result };
	}

	async buildRelevantFileContent(path: string, query: string, maxChars: number) {
		const safePath = this.safePath(path);
		const content = await getVaultIndex(this.app).buildPromptContent(safePath, query, maxChars);
		if (!content) {
			return this.readFile(safePath, maxChars);
		}
		const file = this.app.vault.getAbstractFileByPath(safePath);
		if (!(file instanceof TFile)) throw new Error(`File not found: ${safePath}`);
		return {
			path: file.path,
			name: file.name,
			content,
		};
	}

	async buildVaultManifest(limit = 500) {
		return getVaultIndex(this.app).buildVaultManifest(limit);
	}

	async writeFile(path: string, content: string, overwrite = false) {
		const safePath = this.safePath(path);
		const sanitizedContent = this.sanitizeContentForObsidianTitle(safePath, content);
		const existing = this.app.vault.getAbstractFileByPath(safePath);
		if (existing instanceof TFile) {
			if (!overwrite) throw new Error(`File already exists: ${safePath}`);
			await this.app.vault.modify(existing, sanitizedContent);
			return { action: 'modified', path: existing.path };
		}

		await this.ensureParentFolders(safePath);
		const created = await this.app.vault.create(safePath, sanitizedContent);
		return { action: 'created', path: created.path };
	}

	async patchFile(path: string, oldText: string, newText: string) {
		const safePath = this.safePath(path);
		const file = this.app.vault.getAbstractFileByPath(safePath);
		if (!(file instanceof TFile)) throw new Error(`File not found: ${safePath}`);

		const current = await this.app.vault.cachedRead(file);

		const directPatched = this.tryReplace(current, oldText, newText);
		if (directPatched !== null) {
			await this.app.vault.modify(file, this.sanitizeContentForObsidianTitle(file.path, directPatched));
			return { action: 'patched', path: file.path };
		}

		const normalizedCurrent = current.replace(/\r\n/g, '\n');
		const normalizedOld = oldText.replace(/\r\n/g, '\n');
		const normalizedNew = newText.replace(/\r\n/g, '\n');

		const normalizedPatched = this.tryReplace(normalizedCurrent, normalizedOld, normalizedNew);
		if (normalizedPatched !== null) {
			await this.app.vault.modify(file, this.sanitizeContentForObsidianTitle(file.path, this.restoreLineEndings(current, normalizedPatched)));
			return { action: 'patched', path: file.path };
		}

		const trimmedOld = normalizedOld.trim();
		const trimmedNew = normalizedNew.trim();
		const trimmedPatched = trimmedOld
			? this.tryReplace(normalizedCurrent, trimmedOld, trimmedNew)
			: null;
		if (trimmedPatched !== null) {
			await this.app.vault.modify(file, this.sanitizeContentForObsidianTitle(file.path, this.restoreLineEndings(current, trimmedPatched)));
			return { action: 'patched', path: file.path };
		}

		const fuzzyPatched = this.tryFuzzyReplace(current, oldText, newText);
		if (fuzzyPatched.kind === 'patched') {
			await this.app.vault.modify(file, this.sanitizeContentForObsidianTitle(file.path, fuzzyPatched.value));
			return { action: 'patched', path: file.path, match: 'fuzzy' };
		}
		if (fuzzyPatched.kind === 'ambiguous') {
			throw new Error(`patch_file failed: ambiguous match in ${safePath}. Expand oldText with more surrounding context.`);
		}

		throw new Error(`patch_file failed: oldText not found in ${safePath}`);
	}

	async queryDataview(dql: string): Promise<unknown> {
		const dv = getDataviewApi(this.app);
		if (!dv) return this.queryStructuredVaultLocally(dql);
		const result = await dv.query(dql);
		if (!result.successful) throw new Error(`Dataview-Fehler: ${result.error ?? 'Unbekannt'}`);
		return normalizeDataviewResult(result.value);
	}

	async readUserPreferences(maxChars = 12000) {
		const file = this.app.vault.getAbstractFileByPath(USER_PREFERENCES_PATH);
		if (!(file instanceof TFile)) return null;
		const content = await this.app.vault.cachedRead(file);
		return {
			path: file.path,
			name: file.name,
			content: content.length > maxChars ? content.slice(0, maxChars) + '\n\n[... truncated ...]' : content,
		};
	}

	async updateUserPreferences(content: string, overwrite = true) {
		return this.writeFile(USER_PREFERENCES_PATH, content, overwrite);
	}

	async saveAgentMemory(content: string, label?: string) {
		await this.ensureParentFolders(AGENT_MEMORY_PATH);
		const file = this.app.vault.getAbstractFileByPath(AGENT_MEMORY_PATH);
		const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
		const header = label ? `\n## ${label} (${timestamp})\n` : `\n## Erinnerung ${timestamp}\n`;
		const entry = `${header}\n${content.trim()}\n`;

		if (file instanceof TFile) {
			const existing = await this.app.vault.cachedRead(file);
			await this.app.vault.modify(file, existing.trimEnd() + '\n' + entry);
		} else {
			await this.app.vault.create(AGENT_MEMORY_PATH, `# Agent Memory\n${entry}`);
		}
		return { action: 'saved', path: AGENT_MEMORY_PATH, label: label ?? null, timestamp };
	}

	async recallAgentMemory(maxChars = 12000, query?: string) {
		const file = this.app.vault.getAbstractFileByPath(AGENT_MEMORY_PATH);
		if (!(file instanceof TFile)) return { path: AGENT_MEMORY_PATH, content: null, note: 'Noch keine gespeicherten Erinnerungen.' };
		const content = await this.app.vault.cachedRead(file);
		return {
			path: file.path,
			content: selectRelevantMemory(content, query, maxChars),
			query: query ?? null,
		};
	}

	async deleteFile(path: string) {
		const safePath = this.safePath(path);
		const file = this.app.vault.getAbstractFileByPath(safePath);
		if (!(file instanceof TFile)) throw new Error(`File not found: ${safePath}`);
		await this.app.fileManager.trashFile(file);
		return { action: 'trashed', path: safePath };
	}

	private async ensureParentFolders(filePath: string) {
		const parts = filePath.split('/');
		parts.pop();
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(current)) {
				await this.app.vault.createFolder(current);
			}
		}
	}

	private tryReplace(haystack: string, needle: string, replacement: string): string | null {
		if (!needle) return null;
		if (!haystack.includes(needle)) return null;
		return haystack.replace(needle, replacement);
	}

	private restoreLineEndings(original: string, normalizedText: string): string {
		return original.includes('\r\n')
			? normalizedText.replace(/\n/g, '\r\n')
			: normalizedText;
	}

	private sanitizeContentForObsidianTitle(path: string, content: string): string {
		const lines = content.split(/\r?\n/);
		const firstLine = lines[0] ?? '';
		const match = firstLine.match(/^#\s+(.+?)\s*$/);
		if (!match?.[1]) return content;

		const fileTitle = this.normalizeTitle(path.split('/').pop()?.replace(/\.md$/i, '') ?? path);
		const headingTitle = this.normalizeTitle(match[1]);
		if (!fileTitle || !headingTitle) return content;

		const similar =
			fileTitle === headingTitle ||
			fileTitle.startsWith(headingTitle) ||
			headingTitle.startsWith(fileTitle) ||
			fileTitle.includes(headingTitle) ||
			headingTitle.includes(fileTitle);
		if (!similar) return content;

		return lines.slice(1).join('\n').replace(/^\s*\n/, '').trimStart();
	}

	private normalizeTitle(value: string): string {
		return value
			.toLowerCase()
			.normalize('NFKD')
			.replace(/[\u0300-\u036f]/g, '')
			.replace(/[^a-z0-9]+/g, '');
	}

	private async queryStructuredVaultLocally(input: string): Promise<unknown> {
		const notes = await getVaultIndex(this.app).getNotes();
		const lower = input.toLowerCase();
		if (/\b(template|templater|schema)\b/i.test(lower) && !/\b(tag|status|type|project|topic|group by|gruppiert nach|nach)\b/i.test(lower)) {
			const schema = await getVaultIndex(this.app).buildFrontmatterSchemaSummary(undefined, 18);
			const templateSchema = await getVaultIndex(this.app).buildTemplateSchemaSummary(undefined, 8);
			const rows = [
				{ category: 'frontmatter_schema', content: schema ?? '' },
				{ category: 'template_schema', content: templateSchema ?? '' },
			].filter(row => row.content);
			return {
				kind: 'table',
				columns: ['category', 'content'],
				rows,
				count: rows.length,
				raw: {
					source: 'local_schema_fallback',
					query: input,
					schema,
					templateSchema,
				},
			};
		}
		const tagMatch = lower.match(/(?:^|\s)#?tag[:=\s]+#?([a-z0-9_\-/]+)/i) ?? lower.match(/#([a-z0-9_\-/]+)/i);
		const statusMatch = lower.match(/\bstatus[:=\s]+([a-z0-9_\-/]+)/i);
		const typeMatch = lower.match(/\btype[:=\s]+([a-z0-9_\-/]+)/i);
		const projectMatch = lower.match(/\bproject[:=\s]+([a-z0-9_\-/]+)/i);
		const topicMatch = lower.match(/\btopic[:=\s]+([a-z0-9_\-/]+)/i);
		const groupBy =
			lower.match(/\b(?:nach|group by|gruppiert nach)\s+(status|type|project|topic|folder|tag)\b/i)?.[1]
			?? (lower.includes('status') ? 'status' : undefined);

		let filtered = notes;
		if (tagMatch?.[1]) {
			const needle = tagMatch[1].replace(/^#/, '');
			filtered = filtered.filter(note =>
				note.tags.map(tag => tag.toLowerCase().replace(/^#/, '')).includes(needle),
			);
		}
		if (statusMatch?.[1]) filtered = filtered.filter(note => stringifyFrontmatterValue(note.frontmatter['status']).toLowerCase() === statusMatch[1]);
		if (typeMatch?.[1]) filtered = filtered.filter(note => stringifyFrontmatterValue(note.frontmatter['type']).toLowerCase() === typeMatch[1]);
		if (projectMatch?.[1]) filtered = filtered.filter(note => stringifyFrontmatterValue(note.frontmatter['project']).toLowerCase() === projectMatch[1]);
		if (topicMatch?.[1]) filtered = filtered.filter(note => stringifyFrontmatterValue(note.frontmatter['topic']).toLowerCase() === topicMatch[1]);

		if (!groupBy) {
			return {
				kind: 'list',
				count: filtered.length,
				items: filtered.slice(0, 100).map(note => ({
					path: note.path,
					title: note.title,
					status: note.frontmatter['status'] ?? null,
					type: note.frontmatter['type'] ?? null,
					tags: note.tags,
				})),
				raw: { source: 'local_dataview_fallback', query: input },
			};
		}

		const rows = Array.from(filtered.reduce((map, note) => {
			const key =
				groupBy === 'folder' ? (note.folder || '(root)')
				: groupBy === 'tag' ? (note.tags[0] ?? '(none)')
				: (stringifyFrontmatterValue(note.frontmatter[groupBy]) || '(none)');
			const bucket = map.get(key) ?? [];
			bucket.push({
				path: note.path,
				title: note.title,
				status: note.frontmatter['status'] ?? null,
				type: note.frontmatter['type'] ?? null,
				tags: note.tags,
			});
			map.set(key, bucket);
			return map;
		}, new Map<string, Array<{ path: string; title: string; status: unknown; type: unknown; tags: string[] }>>()).entries())
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([group, items]) => ({
				group,
				count: items.length,
				paths: items.map(item => item.path),
				items,
			}));

		return {
			kind: 'table',
			columns: ['group', 'count', 'paths'],
			rows,
			count: filtered.length,
			raw: { source: 'local_dataview_fallback', query: input, groupBy },
		};
	}

	private tryFuzzyReplace(
		haystack: string,
		needle: string,
		replacement: string,
	): { kind: 'patched'; value: string } | { kind: 'ambiguous' } | { kind: 'none' } {
		if (!needle.trim()) return { kind: 'none' };
		const collapsed = this.findCanonicalMatches(haystack, needle, true);
		if (collapsed.length > 1) return { kind: 'ambiguous' };
		const collapsedMatch = collapsed[0];
		if (collapsedMatch) {
			return {
				kind: 'patched',
				value: haystack.slice(0, collapsedMatch.start) + replacement + haystack.slice(collapsedMatch.end),
			};
		}

		const normalized = this.findCanonicalMatches(haystack, needle, false);
		if (normalized.length > 1) return { kind: 'ambiguous' };
		const normalizedMatch = normalized[0];
		if (normalizedMatch) {
			return {
				kind: 'patched',
				value: haystack.slice(0, normalizedMatch.start) + replacement + haystack.slice(normalizedMatch.end),
			};
		}

		return { kind: 'none' };
	}

	private findCanonicalMatches(
		haystack: string,
		needle: string,
		collapseWhitespace: boolean,
	): Array<{ start: number; end: number }> {
		const hay = this.canonicalizeWithMap(haystack, collapseWhitespace);
		const nee = this.canonicalizeWithMap(needle, collapseWhitespace);
		if (!nee.text.trim()) return [];

		const matches: Array<{ start: number; end: number }> = [];
		let fromIndex = 0;
		while (fromIndex < hay.text.length) {
			const found = hay.text.indexOf(nee.text, fromIndex);
			if (found === -1) break;
			const start = hay.indexMap[found] ?? found;
			const endMapIndex = Math.min(found + nee.text.length - 1, hay.indexMap.length - 1);
			const end = (hay.indexMap[endMapIndex] ?? endMapIndex) + 1;
			matches.push({ start, end });
			fromIndex = found + 1;
		}
		return matches;
	}

	private canonicalizeWithMap(text: string, collapseWhitespace: boolean): { text: string; indexMap: number[] } {
		let normalized = '';
		const indexMap: number[] = [];
		let pendingSpace = false;
		let startOfLine = true;

		for (let i = 0; i < text.length; i++) {
			if (startOfLine) {
				const rest = text.slice(i);
				const orderedMatch = rest.match(/^\s*\d+\.\s+/);
				if (orderedMatch?.[0]) {
					normalized += '1. ';
					indexMap.push(i, i, i);
					i += orderedMatch[0].length - 1;
					pendingSpace = false;
					startOfLine = false;
					continue;
				}
				const bulletMatch = rest.match(/^\s*[-*+]\s+/);
				if (bulletMatch?.[0]) {
					normalized += '- ';
					indexMap.push(i, i);
					i += bulletMatch[0].length - 1;
					pendingSpace = false;
					startOfLine = false;
					continue;
				}
			}

			const raw = text[i] ?? '';
			const canonical = this.canonicalChar(raw);
			if (canonical === ' ' || canonical === '\n') {
				if (collapseWhitespace) {
					if (!pendingSpace) {
						normalized += ' ';
						indexMap.push(i);
						pendingSpace = true;
					}
				} else {
					normalized += canonical;
					indexMap.push(i);
				}
				startOfLine = canonical === '\n';
				continue;
			}
			pendingSpace = false;
			startOfLine = false;
			normalized += canonical;
			indexMap.push(i);
		}

		return { text: normalized, indexMap };
	}

	private canonicalChar(char: string): string {
		switch (char) {
			case '\r':
				return '\n';
			case '\t':
			case '\u00a0':
				return ' ';
			case '\u201c':
			case '\u201d':
				return '"';
			case '\u2018':
			case '\u2019':
				return '\'';
			case '\u2014':
			case '\u2013':
				return '-';
			default:
				return char;
		}
	}
}
