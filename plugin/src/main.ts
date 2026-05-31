/* eslint-disable obsidianmd/ui/sentence-case */

import { Notice, Plugin, TFile } from 'obsidian';
import { AgentView, VIEW_TYPE_AI_AGENT } from './views/AgentView';
import { AiAgentSettings, DEFAULT_SETTINGS, AiAgentSettingsTab } from './settings';
import { ChatMessage, ChatStoreData, ChatThread, DEFAULT_CHAT_STORE, newMessageId } from './chat/chatStore';
import { AGENT_MD_PATH, DEFAULT_AGENT_MD } from './tools/agentMd';
import { getVaultIndex, VaultIndex } from './retrieval/vaultIndex';
import { getVectorStore } from './retrieval/vectorStore';
import { getEmbeddingBackend } from './retrieval/embeddings';
import { getIndexWorkerManager } from './retrieval/indexWorker';
import { migrateModelId } from './models/modelRegistry';

type ApiKeyProvider = 'openai' | 'anthropic' | 'gemini';

const API_KEY_STORAGE_KEYS: Record<ApiKeyProvider, string> = {
	openai: 'ai-agent.openai.api-key',
	anthropic: 'ai-agent.anthropic.api-key',
	gemini: 'ai-agent.gemini.api-key',
};

export default class ObsidianAiAgentPlugin extends Plugin {
	settings: AiAgentSettings;
	chatStore: ChatStoreData;
	vaultIndex: VaultIndex;
	private persistTimer: number | null = null;
	private warmupTimer: number | null = null;
	private workerTimer: number | null = null;
	private pendingWorkerPaths = new Set<string>();

	private get indexFilePath(): string {
		return `.obsidian/plugins/${this.manifest.id}/vault-index.json`;
	}

	private applyRuntimeConfig() {
		this.vaultIndex.setEmbeddingConfig({
			backend: getEmbeddingBackend(this.settings.embeddingBackend),
			apiKey:
				this.settings.embeddingBackend === 'openai' ? this.getProviderApiKey('openai') :
				this.settings.embeddingBackend === 'gemini' ? this.getProviderApiKey('gemini') :
				null,
			baseUrl: this.settings.embeddingBackend === 'ollama' ? this.settings.ollamaBaseUrl : null,
		});
	}

	async onload() {
		await this.loadAll();
		this.applyRuntimeConfig();
		await getVectorStore(this.app).load();
		this.registerVaultIndexEvents();
		this.scheduleVaultIndexWarmup(250);

		this.registerView(VIEW_TYPE_AI_AGENT, leaf => new AgentView(leaf, this));

		this.addRibbonIcon('bot', 'Open AI Agent', () => { void this.activateAgentView(); });

		this.addCommand({
			id: 'open-ai-agent-sidebar',
			name: 'Open AI Agent Sidebar',
			callback: () => { void this.activateAgentView(); },
		});

		this.addSettingTab(new AiAgentSettingsTab(this.app, this));
	}

	async activateAgentView() {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_AI_AGENT);
		if (existing.length > 0) {
			const leaf = existing[0];
			if (leaf) void this.app.workspace.revealLeaf(leaf);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE_AI_AGENT, active: true });
		void this.app.workspace.revealLeaf(leaf);
	}

	onunload() {
		if (this.persistTimer !== null) {
			window.clearTimeout(this.persistTimer);
			this.persistTimer = null;
		}
		if (this.warmupTimer !== null) {
			window.clearTimeout(this.warmupTimer);
			this.warmupTimer = null;
		}
		if (this.workerTimer !== null) {
			window.clearTimeout(this.workerTimer);
			this.workerTimer = null;
		}
		getIndexWorkerManager().terminate();
		void this.saveAll().catch(() => undefined);
	}

	async loadAll() {
		const raw = (await this.loadData()) as Record<string, unknown> | null ?? {};
		this.vaultIndex = getVaultIndex(this.app);

		if ('backendUrl' in raw || 'openaiApiKey' in raw) {
			this.settings = Object.assign({}, DEFAULT_SETTINGS, raw as Partial<AiAgentSettings>);
			this.chatStore = { ...DEFAULT_CHAT_STORE };
			this.migrateApiKeysToLocalStorage();
			this.migrateModelSelections();
			await this.saveAll();
			return;
		}

		this.settings = Object.assign({}, DEFAULT_SETTINGS, (raw['settings'] ?? {}) as Partial<AiAgentSettings>);
		this.chatStore = Object.assign({}, DEFAULT_CHAT_STORE, (raw['chatStore'] ?? {}) as Partial<ChatStoreData>);
		const migratedSecrets = this.migrateApiKeysToLocalStorage();
		const migratedModels = this.migrateModelSelections();

		// Load vault index from its own file; fall back to embedded data for migration
		await this.loadVaultIndex(raw['retrievalIndex'] as Parameters<VaultIndex['hydrate']>[0] | undefined);
		if (migratedSecrets || migratedModels) await this.saveAll();
	}

	getProviderApiKey(provider: ApiKeyProvider): string {
		const value = this.app.loadLocalStorage(API_KEY_STORAGE_KEYS[provider]);
		return typeof value === 'string' ? value : '';
	}

	setProviderApiKey(provider: ApiKeyProvider, value: string) {
		const trimmed = value.trim();
		this.app.saveLocalStorage(API_KEY_STORAGE_KEYS[provider], trimmed || null);
		this.clearProviderApiKeySetting(provider);
	}

	private migrateApiKeysToLocalStorage(): boolean {
		let migrated = false;
		const maybeMigrate = (provider: ApiKeyProvider, value: string) => {
			if (!value) return;
			if (!this.getProviderApiKey(provider)) {
				this.app.saveLocalStorage(API_KEY_STORAGE_KEYS[provider], value);
			}
			this.clearProviderApiKeySetting(provider);
			migrated = true;
		};
		maybeMigrate('openai', this.settings.openaiApiKey);
		maybeMigrate('anthropic', this.settings.anthropicApiKey);
		maybeMigrate('gemini', this.settings.geminiApiKey);
		return migrated;
	}

	private clearProviderApiKeySetting(provider: ApiKeyProvider) {
		if (provider === 'openai') this.settings.openaiApiKey = '';
		else if (provider === 'anthropic') this.settings.anthropicApiKey = '';
		else this.settings.geminiApiKey = '';
	}

	private migrateModelSelections(): boolean {
		let migrated = false;
		const migrate = (modelId: string) => migrateModelId(modelId, this.settings.customModels);

		const settingsModel = migrate(this.settings.lastSelectedModelId);
		if (settingsModel !== this.settings.lastSelectedModelId) {
			this.settings.lastSelectedModelId = settingsModel;
			migrated = true;
		}

		for (const thread of this.chatStore.threads) {
			const threadModel = migrate(thread.selectedModelId);
			if (threadModel !== thread.selectedModelId) {
				thread.selectedModelId = threadModel;
				migrated = true;
			}
		}
		return migrated;
	}

	private async loadVaultIndex(legacyData?: Parameters<VaultIndex['hydrate']>[0]) {
		try {
			const exists = await this.app.vault.adapter.exists(this.indexFilePath);
			if (exists) {
				const json = await this.app.vault.adapter.read(this.indexFilePath);
				this.vaultIndex.hydrate(JSON.parse(json) as Parameters<VaultIndex['hydrate']>[0]);
				return;
			}
		} catch {
			// Corrupt or missing file — rebuild from scratch on first search
		}
		// Migration: hydrate from legacy embedded data if present
		if (legacyData) this.vaultIndex.hydrate(legacyData);
	}

	async saveAll() {
		// Save settings + chat store in the normal Obsidian data file (stays small)
		await this.saveData({
			settings: this.settings,
			chatStore: this.chatStore,
		});
		// Save vault index to its own file to avoid bloating the main data file
		await this.saveVaultIndex();
		await getVectorStore(this.app).save();
	}

	private async saveVaultIndex() {
		try {
			const json = JSON.stringify(this.vaultIndex.exportData());
			await this.app.vault.adapter.write(this.indexFilePath, json);
		} catch {
			// Non-critical — index will be rebuilt on next load
		}
	}

	async saveSettings() {
		this.applyRuntimeConfig();
		await this.saveData({
			settings: this.settings,
			chatStore: this.chatStore,
		});
	}

	createNewThread(): ChatThread {
		const thread: ChatThread = {
			id: newMessageId(),
			title: 'New Chat',
			createdAt: Date.now(),
			updatedAt: Date.now(),
			archived: false,
			selectedModelId: this.settings.lastSelectedModelId,
			contextMode: 'active_file',
			contextModes: ['active_file'],
			activeFilePath: undefined,
			manualFilePaths: [],
			folderPath: undefined,
			includeAgentMd: true,
			messages: [],
		};
		this.chatStore.threads.unshift(thread);
		this.chatStore.activeThreadId = thread.id;
		void this.saveAll();
		return thread;
	}

	getActiveThread(): ChatThread {
		const thread = this.chatStore.threads.find(
			t => t.id === this.chatStore.activeThreadId && !t.archived,
		);
		return thread ?? this.createNewThread();
	}

	async addMessageToThread(threadId: string, message: Omit<ChatMessage, 'id' | 'createdAt'>): Promise<ChatMessage> {
		const msg: ChatMessage = { ...message, id: newMessageId(), createdAt: Date.now() };
		const thread = this.chatStore.threads.find(t => t.id === threadId);
		if (thread) {
			thread.messages.push(msg);
			thread.updatedAt = Date.now();
			if (thread.title === 'New Chat' && msg.role === 'user') {
				thread.title = msg.content.slice(0, 50).trim();
			}
			await this.saveAll();
		}
		return msg;
	}

	async archiveThread(threadId: string): Promise<void> {
		const thread = this.chatStore.threads.find(t => t.id === threadId);
		if (!thread) return;
		thread.archived = true;
		thread.updatedAt = Date.now();
		if (this.chatStore.activeThreadId === threadId) this.chatStore.activeThreadId = null;
		await this.saveAll();
	}

	async unarchiveThread(threadId: string): Promise<void> {
		const thread = this.chatStore.threads.find(t => t.id === threadId);
		if (!thread) return;
		thread.archived = false;
		thread.updatedAt = Date.now();
		await this.saveAll();
	}

	async deleteThread(threadId: string): Promise<void> {
		const idx = this.chatStore.threads.findIndex(t => t.id === threadId);
		if (idx < 0) return;
		this.chatStore.threads.splice(idx, 1);
		if (this.chatStore.activeThreadId === threadId) this.chatStore.activeThreadId = null;
		await this.saveAll();
	}

	async createAgentMd(): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(AGENT_MD_PATH);
		if (existing instanceof TFile) {
			new Notice('agent.md existiert bereits.');
			return;
		}
		await this.app.vault.create(AGENT_MD_PATH, DEFAULT_AGENT_MD);
		new Notice('agent.md erstellt.');
	}

	private registerVaultIndexEvents() {
		this.registerEvent(this.app.vault.on('create', file => {
			if (file.path === '.aiignore') this.vaultIndex.invalidateIgnore();
			else this.vaultIndex.markDirty(file.path);
			if (file.path.toLowerCase().endsWith('.md')) this.pendingWorkerPaths.add(file.path);
			this.schedulePersistAll();
			this.scheduleVaultIndexWarmup();
			this.scheduleWorkerJobs();
		}));
		this.registerEvent(this.app.vault.on('modify', file => {
			if (file.path === '.aiignore') this.vaultIndex.invalidateIgnore();
			else this.vaultIndex.markDirty(file.path);
			if (file.path.toLowerCase().endsWith('.md')) this.pendingWorkerPaths.add(file.path);
			this.schedulePersistAll();
			this.scheduleVaultIndexWarmup();
			this.scheduleWorkerJobs();
		}));
		this.registerEvent(this.app.vault.on('delete', file => {
			if (file.path === '.aiignore') this.vaultIndex.invalidateIgnore();
			else this.vaultIndex.remove(file.path);
			if (file.path.toLowerCase().endsWith('.md')) {
				this.pendingWorkerPaths.delete(file.path);
				void getVectorStore(this.app).deleteByPath(file.path);
			}
			this.schedulePersistAll();
			this.scheduleVaultIndexWarmup();
			this.scheduleWorkerJobs();
		}));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			if (file.path === '.aiignore' || oldPath === '.aiignore') this.vaultIndex.invalidateIgnore();
			else this.vaultIndex.rename(oldPath, file.path);
			if (oldPath.toLowerCase().endsWith('.md')) {
				this.pendingWorkerPaths.delete(oldPath);
				void getVectorStore(this.app).deleteByPath(oldPath);
			}
			if (file.path.toLowerCase().endsWith('.md')) this.pendingWorkerPaths.add(file.path);
			this.schedulePersistAll();
			this.scheduleVaultIndexWarmup();
			this.scheduleWorkerJobs();
		}));
	}

	private schedulePersistAll(delayMs = 750) {
		if (this.persistTimer !== null) {
			window.clearTimeout(this.persistTimer);
		}
		this.persistTimer = window.setTimeout(() => {
			this.persistTimer = null;
			void this.saveAll();
		}, delayMs);
	}

	private scheduleVaultIndexWarmup(delayMs = 1200) {
		if (this.warmupTimer !== null) {
			window.clearTimeout(this.warmupTimer);
		}
		this.warmupTimer = window.setTimeout(() => {
			this.warmupTimer = null;
			void this.vaultIndex.prewarm();
		}, delayMs);
	}

	private scheduleWorkerJobs(delayMs = 1500) {
		if (this.workerTimer !== null) {
			window.clearTimeout(this.workerTimer);
		}
		this.workerTimer = window.setTimeout(() => {
			this.workerTimer = null;
			void this.runPendingWorkerJobs();
		}, delayMs);
	}

	private async runPendingWorkerJobs() {
		const paths = Array.from(this.pendingWorkerPaths).slice(0, 25);
		for (const path of paths) this.pendingWorkerPaths.delete(path);
		const vectorStore = getVectorStore(this.app);
		const worker = getIndexWorkerManager();
		const embeddingConfig = {
			backend: getEmbeddingBackend(this.settings.embeddingBackend),
			apiKey:
				this.settings.embeddingBackend === 'openai' ? this.getProviderApiKey('openai') :
				this.settings.embeddingBackend === 'gemini' ? this.getProviderApiKey('gemini') :
				null,
			baseUrl: this.settings.embeddingBackend === 'ollama' ? this.settings.ollamaBaseUrl : null,
		} as const;
		for (const path of paths) {
			try {
				const note = await this.vaultIndex.getNote(path);
				if (!note) continue;
				const jobs = note.chunks
					.slice(0, 24)
					.map(chunk => ({
						type: 'embed' as const,
						path,
						hash: chunk.hash ?? chunk.id,
						text: chunk.content,
						backend: embeddingConfig.backend,
					}));
				const embedded = await worker.runBatch(jobs, embeddingConfig);
				const vectorByHash = new Map(embedded.map(item => [item.hash, item.vector] as const));
				for (const chunk of note.chunks.slice(0, 24)) {
					const hash = chunk.hash ?? chunk.id;
					const vector = vectorByHash.get(hash);
					if (!vector?.length) continue;
					await vectorStore.set({
						hash,
						chunk_id: chunk.id,
						path,
						section_path: chunk.sectionPath,
						mtime: note.mtime,
						vector,
						last_accessed: Date.now(),
					});
				}
			} catch {
				// Non-critical warmup path.
			}
		}
		await vectorStore.save();
		if (this.pendingWorkerPaths.size > 0) {
			this.scheduleWorkerJobs(250);
		}
	}
}
