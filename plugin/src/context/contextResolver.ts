import { App, TFile } from 'obsidian';
import type { ContextItem } from '../agent/types';
import type { ChatThread, ContextMode } from '../chat/chatStore';
import { llmRerankSearchResults, type LlmCallFn } from '../retrieval/reranker';
import { getVaultIndex } from '../retrieval/vaultIndex';
import { FileReferenceResolver } from './fileReferenceResolver';
import { AGENT_MEMORY_PATH, ObsidianVaultTools, USER_PREFERENCES_PATH } from '../tools/obsidianVaultTools';

const CHUNK_THRESHOLD = 20_000;
const DEFAULT_ACTIVE_FILE_MAX = CHUNK_THRESHOLD;

type QueryIntent =
	| 'navigation'
	| 'fact_lookup'
	| 'edit'
	| 'vault_research';

type RetrievalPolicy = {
	intent: QueryIntent;
	activeFileMaxChars: number;
	manualFileMaxChars: number;
	inputReferenceMaxChars: number;
	retrievedChunkCount: number;
	retrievedChunkMaxChars: number;
	vaultMapLimit: number;
	linkContextLimit: number;
	includeVaultMap: boolean;
	includeLinkedContext: boolean;
	retrievalMode: 'none' | 'fallback' | 'primary';
};

type ParsedMentions = {
	noteRefs: string[];
	folders: string[];
	tags: string[];
	vault: boolean;
};

type ParsedFrontmatterFilters = {
	type?: string;
	status?: string;
	tag?: string[];
	project?: string;
	topic?: string;
};

export function shouldUseLlmRerankForIntent(
	intent: QueryIntent,
	hasStrongFileContext: boolean,
	normalizedQuery: string,
	hasRerankFn: boolean,
	hitCount: number,
): boolean {
	const likelyBroadFactLookup =
		intent === 'fact_lookup'
		&& !hasStrongFileContext
		&& normalizedQuery.split(/\s+/).length >= 5;
	return hasRerankFn
		&& hitCount > 1
		&& (intent === 'vault_research' || likelyBroadFactLookup);
}

export function diversifyRetrievedHitsByPath<T extends { path: string }>(
	hits: T[],
	intent: QueryIntent,
	limit: number,
): T[] {
	const diversified: T[] = [];
	const perPathLimit = intent === 'vault_research' ? 2 : 1;
	const pathCounts = new Map<string, number>();
	for (const hit of hits) {
		const count = pathCounts.get(hit.path) ?? 0;
		if (count >= perPathLimit) continue;
		diversified.push(hit);
		pathCounts.set(hit.path, count + 1);
		if (diversified.length >= limit) break;
	}
	return diversified;
}

export class ContextResolver {
	private tools: ObsidianVaultTools;
	private fileRefResolver: FileReferenceResolver;
	private recentPaths: string[] = [];
	private llmRerankFn: LlmCallFn | null = null;
	private _lastIntent: QueryIntent = 'fact_lookup';

	constructor(private app: App) {
		this.tools = new ObsidianVaultTools(app);
		this.fileRefResolver = new FileReferenceResolver(app);
	}

	setLlmRerankFn(fn: LlmCallFn | null) {
		this.llmRerankFn = fn;
	}

	getLastIntent(): QueryIntent {
		return this._lastIntent;
	}

	private getActivePath(): string | undefined {
		return this.app.workspace.getActiveFile()?.path;
	}

	async resolveContext(thread: ChatThread, userMessage: string): Promise<ContextItem[]> {
		const context: ContextItem[] = [];
		this.rememberRecentContextPaths(thread);
		const intent = this.detectIntent(thread, userMessage);
		this._lastIntent = intent;
		const policy = this.buildPolicy(intent, thread);
		const mentions = this.parseMentions(userMessage);

		if (thread.includeAgentMd !== false) {
			const agentMd = await this.collectAgentMd();
			if (agentMd) context.push(agentMd);
		}

		const preferenceContext = await this.collectUserPreferences();
		if (preferenceContext) context.push(preferenceContext);

		const agentMemory = await this.collectAgentMemory(userMessage);
		if (agentMemory) context.push(agentMemory);

		const modeItems = await this.collectByMode(
			thread.contextMode ?? 'active_file',
			thread.manualFilePaths ?? [],
			thread.folderPath,
			userMessage,
			policy,
		);
		context.push(...modeItems);

		const refItems = await this.collectInputRefs(userMessage, context, policy);
		context.push(...refItems);

		const mentionItems = await this.collectMentionContext(mentions, context, policy);
		context.push(...mentionItems);
		const hasExplicitFolderContext = mentionItems.some(item => item.type === 'folder');

		const retrievedItems = await this.collectRetrievedChunks(
			thread,
			userMessage,
			context,
			hasExplicitFolderContext
				? { ...policy, retrievalMode: 'none', includeVaultMap: false, includeLinkedContext: false }
				: policy,
		);
		context.push(...retrievedItems);

		const frontmatterContext = await this.collectFrontmatterContext(thread, userMessage, context, mentions);
		if (frontmatterContext) context.push(frontmatterContext);

		if (policy.includeLinkedContext && !hasExplicitFolderContext) {
			const linkedItems = await this.collectLinkedContexts(context, policy);
			context.push(...linkedItems);
		}

		if (policy.includeVaultMap && !hasExplicitFolderContext) {
			const vaultMap = await this.collectVaultMap(userMessage, context, policy);
			if (vaultMap) context.push(vaultMap);
		}

		return context;
	}

	getReferencedFilePaths(userMessage: string): string[] {
		const mentions = this.parseMentions(userMessage);
		const activePath = this.getActivePath();
		return Array.from(new Set(
			[
				...this.fileRefResolver.findFileReferences(userMessage),
				...mentions.noteRefs,
			]
				.map(ref => this.fileRefResolver.resolveToFile(ref, activePath))
				.filter((file): file is TFile => file instanceof TFile)
				.map(file => file.path),
		));
	}

	private shouldAutoIncludeAgentMemory(userMessage: string): boolean {
		return /\b(remember|memory|erinner|frueher|früher|zuvor|vorher|bereits entschieden|entscheidung|projektkontext|kontext aus frueher|kontext aus früher)\b/i.test(userMessage);
	}

	private async collectAgentMemory(userMessage: string): Promise<ContextItem | null> {
		if (!this.shouldAutoIncludeAgentMemory(userMessage)) return null;
		const file = this.app.vault.getAbstractFileByPath(AGENT_MEMORY_PATH);
		if (!(file instanceof TFile)) return null;
		try {
			const recalled = await this.tools.recallAgentMemory(3000, userMessage);
			const content = typeof recalled.content === 'string' ? recalled.content : '';
			if (!content.trim()) return null;
			return {
				type: 'agent_memory',
				label: 'Agent Memory (.ai/agent_memory.md)',
				path: AGENT_MEMORY_PATH,
				content,
				summary: 'Relevante gespeicherte Langzeitnotizen fuer diese Anfrage',
			};
		} catch {
			return null;
		}
	}

	private async collectAgentMd(): Promise<ContextItem | null> {
		const file = this.app.vault.getAbstractFileByPath('agent.md');
		if (!(file instanceof TFile)) return null;
		const content = await this.app.vault.cachedRead(file);
		return { type: 'agent_md', label: 'agent.md', path: 'agent.md', content };
	}

	private async collectUserPreferences(): Promise<ContextItem | null> {
		const file = this.app.vault.getAbstractFileByPath(USER_PREFERENCES_PATH);
		if (!(file instanceof TFile)) return null;
		try {
			const content = await this.app.vault.cachedRead(file);
			if (!content.trim()) return null;
			return {
				type: 'user_preferences',
				label: 'Persistente Nutzerpraeferenzen',
				path: USER_PREFERENCES_PATH,
				content,
			};
		} catch {
			return null;
		}
	}

	private async collectByMode(
		mode: ContextMode,
		manualPaths: string[],
		folderPath: string | undefined,
		userMessage: string,
		policy: RetrievalPolicy,
	): Promise<ContextItem[]> {
		switch (mode) {
			case 'active_file': {
				const file = await this.tools.readActiveFile();
				if (!file) return [];
				const content = await this.getPromptContent(
					file.path,
					file.content,
					userMessage,
					policy.activeFileMaxChars,
				);
				return [{ type: 'active_file', label: file.name, path: file.path, content }];
			}

			case 'selected_text': {
				const selected = this.tools.readSelectedText();
				if (!selected) {
					return [{ type: 'selected_text', label: 'Kein Text markiert', content: 'No text is currently selected.' }];
				}
				return [{
					type: 'selected_text',
					label: 'Ausgewaehlter Text',
					path: selected.path ?? undefined,
					content: selected.content,
				}];
			}

			case 'manual_files': {
				const items: ContextItem[] = [];
				for (const path of manualPaths) {
					try {
						const file = await this.tools.readFile(path);
						const content = await this.getPromptContent(
							file.path,
							file.content,
							userMessage,
							policy.manualFileMaxChars,
						);
						items.push({ type: 'manual_file', label: file.name, path: file.path, content });
					} catch {
						// Skip missing files.
					}
				}
				return items;
			}

			case 'folder': {
				if (!folderPath) return [];
				try {
					const result = await this.tools.readFolder(folderPath);
					return [{ type: 'folder', label: folderPath, path: folderPath, files: result.files }];
				} catch {
					return [];
				}
			}

			case 'vault': {
				const files = await this.tools.buildVaultManifest();
				return [{
					type: 'vault_index',
					label: `Vault (${files.length} Dateien)`,
					files,
				}];
			}

			case 'none':
			default:
				return [];
		}
	}

	private async collectInputRefs(
		userMessage: string,
		existing: ContextItem[],
		policy: RetrievalPolicy,
	): Promise<ContextItem[]> {
		const refs = this.fileRefResolver.findFileReferences(userMessage);
		const items: ContextItem[] = [];
		const seenPaths = new Set(
			existing
				.map(item => item.path)
				.filter((path): path is string => Boolean(path)),
		);

		for (const ref of refs) {
			const file = this.fileRefResolver.resolveToFile(ref, this.getActivePath());
			if (!file || seenPaths.has(file.path)) continue;

			try {
				const raw = await this.app.vault.cachedRead(file);
				const content = await this.getPromptContent(file.path, raw, userMessage, policy.inputReferenceMaxChars);
				items.push({ type: 'input_reference', label: file.name, path: file.path, content });
				seenPaths.add(file.path);
			} catch {
				// Skip unreadable files.
			}
		}

		return items;
	}

	private async collectMentionContext(
		mentions: ParsedMentions,
		existing: ContextItem[],
		policy: RetrievalPolicy,
	): Promise<ContextItem[]> {
		const items: ContextItem[] = [];
		const seenPaths = new Set(
			existing.map(item => item.path).filter((path): path is string => Boolean(path)),
		);

		for (const ref of mentions.noteRefs) {
			const file = this.fileRefResolver.resolveToFile(ref, this.getActivePath());
			if (!file || seenPaths.has(file.path)) continue;
			try {
				const raw = await this.app.vault.cachedRead(file);
				const content = await this.getPromptContent(file.path, raw, ref, policy.inputReferenceMaxChars);
				items.push({
					type: 'input_reference',
					label: `Mention: ${file.name}`,
					path: file.path,
					content,
				});
				seenPaths.add(file.path);
			} catch {
				// ignore
			}
		}

		for (const folder of mentions.folders.slice(0, 2)) {
			try {
				const result = await this.tools.readFolder(folder, 12, 6000);
				items.push({
					type: 'folder',
					label: `Mention: Ordner ${folder}`,
					path: folder,
					files: result.files,
				});
			} catch {
				// ignore
			}
		}

		if (mentions.vault && !existing.some(item => item.type === 'vault_index')) {
			const files = await this.tools.buildVaultManifest();
			items.push({
				type: 'vault_index',
				label: `Vault (${files.length} Dateien)`,
				files,
			});
		}

		return items;
	}

	private async collectVaultMap(
		userMessage: string,
		existing: ContextItem[],
		policy: RetrievalPolicy,
	): Promise<ContextItem | null> {
		const activePath = this.getActivePath();
		const referencedPaths = this.getReferencedFilePaths(userMessage);
		const hasBroadQuestion = userMessage.trim().split(/\s+/).length >= 4;
		const hasVaultManifest = existing.some(item => item.type === 'vault_index');
		if (!hasBroadQuestion && !hasVaultManifest) return null;

		const content = await getVaultIndex(this.app).buildVaultMap({
			activePath,
			referencedPaths,
			recentPaths: this.recentPaths,
			limit: policy.vaultMapLimit,
		});
		if (!content) return null;

		return {
			type: 'vault_map',
			label: 'Vault-Map',
			content,
			summary: 'Globale Priorisierung des Vaults anhand von Links, Ordnern und aktueller Relevanz',
			stats: { limit: policy.vaultMapLimit },
		};
	}

	private async collectRetrievedChunks(
		thread: ChatThread,
		userMessage: string,
		existing: ContextItem[],
		policy: RetrievalPolicy,
	): Promise<ContextItem[]> {
		const normalizedQuery = userMessage.trim();
		if (!normalizedQuery) return [];
		if (policy.retrievalMode === 'none') return [];

		const hasStrongFileContext = existing.some(item =>
			item.type === 'active_file' ||
			item.type === 'manual_file' ||
			item.type === 'input_reference' ||
			item.type === 'selected_text',
		);
		if (policy.retrievalMode === 'fallback' && hasStrongFileContext) return [];

		const activePath = this.getActivePath();
		const excludePaths = existing
			.map(item => item.path)
			.filter((path): path is string => Boolean(path));
		let hits = await getVaultIndex(this.app).search(normalizedQuery, {
			limit: policy.retrievedChunkCount,
			activePath,
			referencedPaths: this.getReferencedFilePaths(userMessage),
			recentPaths: this.recentPaths,
			folderPath: thread.folderPath,
			excludePaths,
		});
		// LLM-rerank only for broad research queries and wide fact-lookups.
		const shouldRerank = shouldUseLlmRerankForIntent(
			policy.intent,
			hasStrongFileContext,
			normalizedQuery,
			this.llmRerankFn !== null,
			hits.length,
		);
		if (shouldRerank) {
			hits = await llmRerankSearchResults(normalizedQuery, hits, this.llmRerankFn!, Math.min(policy.retrievedChunkCount, 8));
		}

		// Diversify: limit repeated chunks from the same file before moving on.
		hits = diversifyRetrievedHitsByPath(hits, policy.intent, policy.retrievedChunkCount);

		const items: ContextItem[] = [];
		for (const hit of hits) {
			const content = hit.chunk_id
				? await getVaultIndex(this.app).buildPromptContentForChunk(
					hit.path,
					hit.chunk_id,
					normalizedQuery,
					policy.retrievedChunkMaxChars,
				)
				: await getVaultIndex(this.app).buildPromptContent(
					hit.path,
					normalizedQuery,
					policy.retrievedChunkMaxChars,
				);
			if (!content) continue;
			items.push({
				type: 'retrieved_chunk',
				label: [
					hit.heading ? `${hit.name} - ${hit.heading}` : hit.name,
					hit.reasons?.length ? `[${hit.reasons.join(', ')}]` : '',
				].filter(Boolean).join(' '),
				path: hit.path,
				content,
				summary: hit.snippet.slice(0, 180),
				reasons: hit.reasons,
				stats: {
					chunk_id: hit.chunk_id,
					block_type: hit.block_type,
					heading: hit.heading,
					section_path: hit.sectionPath?.join(' > '),
					line_start: hit.line_range?.[0],
					line_end: hit.line_range?.[1],
					score_final: hit.retrieval_scores?.final !== undefined ? Number(hit.retrieval_scores.final.toFixed(3)) : undefined,
					score_chunk: hit.retrieval_scores?.chunk !== undefined ? Number(hit.retrieval_scores.chunk.toFixed(3)) : undefined,
					score_dense: hit.retrieval_scores?.dense !== undefined ? Number(hit.retrieval_scores.dense.toFixed(3)) : undefined,
					score_graph: hit.retrieval_scores?.graph !== undefined ? Number(hit.retrieval_scores.graph.toFixed(3)) : undefined,
					score_rerank: hit.retrieval_scores?.rerank !== undefined ? Number(hit.retrieval_scores.rerank.toFixed(3)) : undefined,
				},
			});
		}

		return items;
	}

	private async collectFrontmatterContext(
		thread: ChatThread,
		userMessage: string,
		existing: ContextItem[],
		mentions: ParsedMentions,
	): Promise<ContextItem | null> {
		const wantsStructuredQuery =
			/\b(dataview|bases|table|liste|tasks?|auflisten|gruppier|status|type|frontmatter|alias|projekt|project|topic|tag|template|schema|templater)\b/u.test(userMessage.toLowerCase())
			|| mentions.tags.length > 0
			|| mentions.vault;
		if (!wantsStructuredQuery) return null;

		const filters = this.parseFrontmatterFilters(userMessage, mentions);
		const focusedPaths = existing
			.filter(item => item.type === 'active_file' || item.type === 'manual_file' || item.type === 'input_reference')
			.map(item => item.path)
			.filter((path): path is string => Boolean(path))
			.slice(0, 12);
		const useScopedPaths = focusedPaths.length > 0 && !mentions.vault;

		const content = await getVaultIndex(this.app).buildFrontmatterContext({
			type: filters.type,
			status: filters.status,
			tag: filters.tag,
			project: filters.project,
			topic: filters.topic,
			paths: useScopedPaths ? focusedPaths : undefined,
			limit: thread.contextMode === 'vault' || mentions.vault ? 18 : 10,
		});
		if (!content) return null;
		const schema = await getVaultIndex(this.app).buildFrontmatterSchemaSummary(
			useScopedPaths ? focusedPaths : undefined,
			12,
		);
		const templateSchema = await getVaultIndex(this.app).buildTemplateSchemaSummary(
			useScopedPaths ? focusedPaths : undefined,
			5,
		);

		return {
			type: 'frontmatter_context',
			label: 'Strukturierter Frontmatter-Kontext',
			content: [schema, templateSchema, content].filter(Boolean).join('\n\n'),
			summary: 'Strukturierte Sicht auf Typen, Status, Tags, Projekte und Template-Schemas',
			stats: {
				scoped_paths: useScopedPaths ? focusedPaths.length : 0,
				tag_filters: filters.tag?.length ?? 0,
			},
		};
	}

	private async collectLinkedContexts(existing: ContextItem[], policy: RetrievalPolicy): Promise<ContextItem[]> {
		const focusPaths = Array.from(new Set(
			existing
				.filter(item =>
					item.type === 'active_file' ||
					item.type === 'manual_file' ||
					item.type === 'input_reference',
				)
				.map(item => item.path)
				.filter((path): path is string => Boolean(path)),
		)).slice(0, policy.intent === 'navigation' ? 2 : 1);

		if (!focusPaths.length) return [];

		const items: ContextItem[] = [];
		for (const focusPath of focusPaths) {
			const backlinkContent = await this.buildBacklinkContext(focusPath, policy.linkContextLimit);
			if (backlinkContent) {
				items.push({
					type: 'backlink_context',
					label: `Backlinks zu ${focusPath.split('/').pop() ?? focusPath}`,
					path: focusPath,
					content: backlinkContent,
					summary: 'Kurze Übersicht verlinkender Notizen',
				});
			}

			const forwardLinkContent = await this.buildForwardLinkContext(focusPath, policy.linkContextLimit);
			if (forwardLinkContent) {
				items.push({
					type: 'forward_link_context',
					label: `Verlinkte Notizen aus ${focusPath.split('/').pop() ?? focusPath}`,
					path: focusPath,
					content: forwardLinkContent,
					summary: 'Kurze Übersicht ausgehender Verlinkungen',
				});
			}
		}

		return items;
	}

	private async buildBacklinkContext(path: string, limit: number): Promise<string | null> {
		const backlinks = await getVaultIndex(this.app).getBacklinkSummaries(path, limit);
		if (!backlinks.length) return null;

		return [
			'Kurzer Backlink-Kontext zu dieser Notiz:',
			...backlinks.map(link => `- ${link.title} (${link.path})${link.tags.length ? ` [tags: ${link.tags.slice(0, 4).join(', ')}]` : ''} - ${link.summary}`),
		].join('\n');
	}

	private async buildForwardLinkContext(path: string, limit: number): Promise<string | null> {
		const forwardLinks = await getVaultIndex(this.app).getForwardLinkSummaries(path, limit);
		if (!forwardLinks.length) return null;

		return [
			'Kurzer Forward-Link-Kontext aus dieser Notiz:',
			...forwardLinks.map(link => `- ${link.title} (${link.path})${link.tags.length ? ` [tags: ${link.tags.slice(0, 4).join(', ')}]` : ''} - ${link.summary}`),
		].join('\n');
	}

	private async getPromptContent(
		path: string,
		rawContent: string,
		userMessage: string,
		maxChars = DEFAULT_ACTIVE_FILE_MAX,
	): Promise<string> {
		if (rawContent.length <= maxChars) return rawContent;
		return (await getVaultIndex(this.app).buildPromptContent(path, userMessage, maxChars)) ?? rawContent;
	}

	private parseMentions(userMessage: string): ParsedMentions {
		const noteRefs = new Set<string>();
		const folders = new Set<string>();
		const tags = new Set<string>();
		const text = userMessage;

		for (const match of text.matchAll(/@note(?:\(([^)]+)\)|:([^\n@]+)|\s+([^\n@]+))/gi)) {
			const value = match[1] ?? match[2] ?? match[3];
			if (value?.trim()) noteRefs.add(value.trim().replace(/^["'`]|["'`]$/g, ''));
		}
		for (const match of text.matchAll(/@folder(?:\(([^)]+)\)|:([^\n@]+)|\s+([^\n@]+))/gi)) {
			const value = match[1] ?? match[2] ?? match[3];
			if (value?.trim()) folders.add(value.trim().replace(/^["'`]|["'`]$/g, ''));
		}
		for (const match of text.matchAll(/@tag(?:\(([^)]+)\)|:([#\w/-]+)|\s+([#\w/-]+))/gi)) {
			const value = match[1] ?? match[2] ?? match[3];
			if (value?.trim()) tags.add(value.trim().replace(/^#/, ''));
		}

		return {
			noteRefs: Array.from(noteRefs).slice(0, 6),
			folders: Array.from(folders).slice(0, 3),
			tags: Array.from(tags).slice(0, 8),
			vault: /@vault\b/i.test(text),
		};
	}

	private parseFrontmatterFilters(userMessage: string, mentions: ParsedMentions): ParsedFrontmatterFilters {
		const filters: ParsedFrontmatterFilters = {};
		const typeMatch = userMessage.match(/\btype[:=\s]+([A-Za-z0-9_-]+)/i);
		const statusMatch = userMessage.match(/\bstatus[:=\s]+([A-Za-z0-9_-]+)/i);
		const projectMatch = userMessage.match(/\bproject[:=\s]+([A-Za-z0-9_-]+)/i);
		const topicMatch = userMessage.match(/\btopic[:=\s]+([A-Za-z0-9_-]+)/i);
		if (typeMatch?.[1]) filters.type = typeMatch[1];
		if (statusMatch?.[1]) filters.status = statusMatch[1];
		if (projectMatch?.[1]) filters.project = projectMatch[1];
		if (topicMatch?.[1]) filters.topic = topicMatch[1];
		if (mentions.tags.length > 0) filters.tag = mentions.tags;
		return filters;
	}

	private rememberRecentContextPaths(thread: ChatThread) {
		const recent = thread.messages
			.slice(-8)
			.flatMap(message => this.getReferencedFilePaths(message.content))
			.slice(-8);
		this.recentPaths = Array.from(new Set(recent)).slice(-6);
	}

	private detectIntent(thread: ChatThread, userMessage: string): QueryIntent {
		const text = userMessage.toLowerCase();
		const contextMode = thread.contextMode ?? 'active_file';
		const referencedPaths = this.getReferencedFilePaths(userMessage);
		const mentions = this.parseMentions(userMessage);

		if (/\b(aendere|bearbeite|ueberarbeite|schreibe|ergaenze|aktualisiere|loesche|ersetze|patch)\b/u.test(text)) {
			return 'edit';
		}

		if (mentions.noteRefs.length > 0 || mentions.folders.length > 0 || /\b(wo\b|welche datei|welcher ordner|finde|suche|zeige mir|oeffne|navigiere|verweist|backlink|backlinks|verlinkt)\b/u.test(text)) {
			return 'navigation';
		}

		if (
			mentions.vault ||
			contextMode === 'vault' ||
			/\b(vault|ueberblick|gesamt|projektweit|vergleich|recherche|analysiere den vault|quer ueber)\b/u.test(text)
		) {
			return 'vault_research';
		}

		if (
			referencedPaths.length > 0 ||
			/\b(was|warum|wie|wieviel|wie viele|fasse|zusammen|erklaere|inhalt|chars|zeichen|daten|rate limits?)\b/u.test(text)
		) {
			return 'fact_lookup';
		}

		return 'fact_lookup';
	}

	private buildPolicy(intent: QueryIntent, _thread: ChatThread): RetrievalPolicy {
		const base: RetrievalPolicy = {
			intent,
			activeFileMaxChars: DEFAULT_ACTIVE_FILE_MAX,
			manualFileMaxChars: 15_000,
			inputReferenceMaxChars: 15_000,
			retrievedChunkCount: 3,
			retrievedChunkMaxChars: 8_000,
			vaultMapLimit: 10,
			linkContextLimit: 4,
			includeVaultMap: false,
			includeLinkedContext: false,
			retrievalMode: 'fallback',
		};

		switch (intent) {
			case 'edit':
				return {
					...base,
					activeFileMaxChars: 18_000,
					manualFileMaxChars: 18_000,
					inputReferenceMaxChars: 18_000,
					retrievedChunkCount: 1,
					retrievedChunkMaxChars: 4_000,
					linkContextLimit: 2,
					includeVaultMap: false,
					includeLinkedContext: false,
					retrievalMode: 'fallback',
				};
			case 'navigation':
				return {
					...base,
					activeFileMaxChars: 10_000,
					manualFileMaxChars: 10_000,
					inputReferenceMaxChars: 10_000,
					retrievedChunkCount: 2,
					retrievedChunkMaxChars: 4_500,
					vaultMapLimit: 8,
					linkContextLimit: 6,
					includeVaultMap: true,
					includeLinkedContext: true,
					retrievalMode: 'fallback',
				};
			case 'vault_research':
				return {
					...base,
					activeFileMaxChars: 8_000,
					manualFileMaxChars: 10_000,
					inputReferenceMaxChars: 10_000,
					retrievedChunkCount: 5,
					retrievedChunkMaxChars: 9_000,
					vaultMapLimit: 14,
					linkContextLimit: 3,
					includeVaultMap: true,
					includeLinkedContext: false,
					retrievalMode: 'primary',
				};
			case 'fact_lookup':
			default:
				return {
					...base,
					activeFileMaxChars: 12_000,
					manualFileMaxChars: 12_000,
					inputReferenceMaxChars: 12_000,
					retrievedChunkCount: 3,
					retrievedChunkMaxChars: 7_000,
					vaultMapLimit: 8,
					linkContextLimit: 3,
					includeVaultMap: false,
					includeLinkedContext: false,
					retrievalMode: 'primary',
				};
		}
	}

	getContextLabel(thread: ChatThread): string {
		const mode = thread.contextMode ?? 'active_file';
		switch (mode) {
			case 'active_file': {
				const file = this.app.workspace.getActiveFile();
				return file ? file.basename : 'keine aktive Datei';
			}
			case 'selected_text':
				return 'Markierter Text';
			case 'manual_files': {
				const count = (thread.manualFilePaths ?? []).length;
				return `${count} Datei${count === 1 ? '' : 'en'}`;
			}
			case 'folder':
				return thread.folderPath ?? 'kein Ordner';
			case 'vault':
				return `Vault (${this.app.vault.getMarkdownFiles().length})`;
			case 'none':
				return 'kein Kontext';
		}
	}
}
