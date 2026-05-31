/* eslint-disable obsidianmd/ui/sentence-case */

import { ItemView, MarkdownRenderer, Modal, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import type ObsidianAiAgentPlugin from '../main';
import type { ProviderName } from '../settings';
import {
	getAllModels,
	describeModelReasoning,
	getModelApiId,
	getModelAvailability,
	getModelConfigWithCustom,
	getModelSourceUrl,
	getRecommendedModels,
	getModelsByProvider,
	isReasoningActive,
	legacyThinkingReasoning,
} from '../models/modelRegistry';
import type { ChatRequestPayload, ContextItem, EditPlan, TaskPlan, ToolResult, TypedStep, TaskComplexity } from '../agent/types';
import { buildSystemPrompt, parseStructuredEditPlan, parseTaskPlan } from '../agent/prompts';
import { postCheckAssistantAnswer } from '../agent/postCheck';
import { advanceTaskPlan, buildFallbackPlan, classifyTaskComplexity, shouldReplanFromToolResults, shouldUsePlanner } from '../agent/planner';
import { callProvider } from '../providers/router';
import { ProviderError } from '../providers/http';
import { formatProviderUsage } from '../providers/usage';
import { buildStyleProfile } from '../settings';
import type { ChatMessage, ChatThread, ContextMode, UIMode } from '../chat/chatStore';
import { getEffectiveModes, setEffectiveModes } from '../chat/chatStore';
import { parseSlashCommand, routeIntent } from '../agent/intentRouter';
import type { RouterResult } from '../agent/intentRouter';
import { buildPendingPlanContext, clonePendingTaskPlan, isPendingPlanExecutionRequest, isPendingPlanRevisionRequest } from '../agent/pendingPlan';
import {
	applyClassifierResult,
	buildIntentClassifierPrompt,
	learnIntentPattern,
	parseIntentClassifierResult,
	shouldRunIntentClassifier,
} from '../agent/intentClassifier';
import { buildContextDebugSnapshot, type ContextDebugSnapshot } from '../context/contextDebug';
import { buildCompactHistory, buildWorkingMemoryContext, compactToolResults, recordToolOutcome, refreshWorkingSummary } from '../context/contextMemory';
import { ContextResolver } from '../context/contextResolver';
import { defaultMaxContextChars, defaultMaxOutputTokens, getRateLimitProfile } from '../limits/rateLimitProfiles';
import { buildTemplateHint } from '../templates/fileTemplates';
import { buildEditFormatHint } from '../tools/editFormats';
import { ToolExecutor } from '../tools/toolExecutor';
import { compactContextForBudget, estimatePayloadTokens } from '../limits/tokenBudget';
import { rateLimitManager } from '../limits/rateLimitState';

export const VIEW_TYPE_AI_AGENT = 'obsidian-ai-agent-view';

import {
	MAX_AGENT_STEPS,
	PLAN_ALLOWED_TOOLS,
	READ_ONLY_TOOLS,
	METADATA_ONLY_TOOLS,
	WRITE_TOOLS,
	getEditReadLoopGuard,
	getDuplicateReadGuard,
	getRoundLoopGuard,
	getReadPaths,
	getSearchResultCount,
	hasFreshReadForPath,
	hasExplicitBroadDiscoveryIntent,
	isLikelyNewFileCreationIntent,
	validateReadFolderScope,
	getLatestReadContentForPath,
	validateOverwriteContentSafety,
} from './agentGuards';

const PROVIDER_GROUPS: { label: string; provider: ProviderName }[] = [
	{ label: 'OpenAI', provider: 'openai' },
	{ label: 'Anthropic', provider: 'anthropic' },
	{ label: 'Google Gemini', provider: 'gemini' },
	{ label: 'Ollama (lokal)', provider: 'ollama' },
];

const CONTEXT_MODE_LABELS: Record<ContextMode, string> = {
	active_file:   'Aktuelle Datei',
	selected_text: 'Markierter Text',
	manual_files:  'Mehrere Dateien',
	folder:        'Ordner',
	vault:         'Ganzer Vault',
	none:          'Kein Kontext',
};

type Screen = 'chat' | 'chat_list';

// ── Multi-file picker modal ────────────────────────────────────

class MultiFileModal extends Modal {
	private selected: Set<string>;
	private onSubmit: (paths: string[]) => void;

	constructor(app: import('obsidian').App, currentPaths: string[], onSubmit: (paths: string[]) => void) {
		super(app);
		this.selected = new Set(currentPaths);
		this.onSubmit = onSubmit;
	}

	onOpen() {
		this.titleEl.setText('Dateien für Kontext');
		const { contentEl } = this;

		const search = contentEl.createEl('input', {
			cls: 'ai-agent-modal-search',
			attr: { type: 'text', placeholder: 'Suchen…' },
		});
		const listEl = contentEl.createDiv('ai-agent-modal-list');

		const render = (q: string) => {
			listEl.empty();
			const lq = q.toLowerCase();
			const files = this.app.vault.getMarkdownFiles()
				.filter(f => !q || f.path.toLowerCase().includes(lq) || f.basename.toLowerCase().includes(lq))
				.sort((a, b) => a.path.localeCompare(b.path));

			for (const file of files) {
				const row = listEl.createDiv('ai-agent-modal-row');
				const cb = row.createEl('input', { attr: { type: 'checkbox' } });
				cb.checked = this.selected.has(file.path);
				row.createSpan({ text: file.path.replace(/\.md$/, '') });
				cb.addEventListener('change', () => {
					if (cb.checked) this.selected.add(file.path);
					else this.selected.delete(file.path);
				});
				row.addEventListener('click', e => {
					if (e.target !== cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
				});
			}
		};

		search.addEventListener('input', () => render(search.value));
		render('');

		const footer = contentEl.createDiv('ai-agent-modal-footer');
		const applyBtn = footer.createEl('button', { text: 'Anwenden', cls: 'mod-cta' });
		applyBtn.addEventListener('click', () => { this.onSubmit(Array.from(this.selected)); this.close(); });
		footer.createEl('button', { text: 'Abbrechen' }).addEventListener('click', () => this.close());

		setTimeout(() => search.focus(), 10);
	}

	onClose() { this.contentEl.empty(); }
}

// ── Main view ──────────────────────────────────────────────────

export class AgentView extends ItemView {
	plugin: ObsidianAiAgentPlugin;
	private contextResolver: ContextResolver;
	private toolExecutor: ToolExecutor;

	private currentScreen: Screen = 'chat';
	private showArchive = false;

	private options = { webSearch: false, thinkingMode: false, vaultTools: true };
	private isLoading = false;

	private messagesEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private modelBtn!: HTMLButtonElement;
	private sendBtn!: HTMLButtonElement;

	private activePopover: HTMLElement | null = null;
	private activePopoverCleanup: (() => void) | null = null;
	private statusBodyEl: HTMLElement | null = null;
	private statusHeaderEl: HTMLElement | null = null;
	private statusLabelEl: HTMLElement | null = null;
	private thinkingDotsEl: HTMLElement | null = null;
	private thinkingDotsInterval: ReturnType<typeof setInterval> | null = null;
	private emittedStatusKeys = new Set<string>();

	private resizeComposerInput() {
		this.inputEl.setCssProps({ height: 'auto' });
		this.inputEl.setCssProps({ height: `${this.inputEl.scrollHeight}px` });
	}

	constructor(leaf: WorkspaceLeaf, plugin: ObsidianAiAgentPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.contextResolver = new ContextResolver(this.app);
		this.toolExecutor = new ToolExecutor(this.app, plugin);
		this.selectedModelId = plugin.settings.lastSelectedModelId;
	}

	// Getter/setter so selectedModelId stays in sync with the active thread
	private get selectedModelId(): string {
		return this.plugin.chatStore.threads.find(t => t.id === this.plugin.chatStore.activeThreadId)?.selectedModelId
			?? this.plugin.settings.lastSelectedModelId;
	}
	private set selectedModelId(id: string) {
		const t = this.plugin.chatStore.threads.find(x => x.id === this.plugin.chatStore.activeThreadId);
		if (t) t.selectedModelId = id;
		this.plugin.settings.lastSelectedModelId = id;
	}

	getViewType(): string { return VIEW_TYPE_AI_AGENT; }
	getDisplayText(): string { return 'AI Agent'; }
	getIcon(): string { return 'bot'; }

	async onOpen() {
		if (!this.plugin.chatStore.activeThreadId) {
			this.currentScreen = 'chat_list';
		} else {
			this.currentScreen = 'chat';
		}
		this.render();
	}

	// ── Core render ────────────────────────────────────────────

	private render() {
		this.closePopover();
		const root = this.containerEl.children[1];
		if (!(root instanceof HTMLElement)) return;
		root.empty();
		root.addClass('ai-agent-root');
		if (this.currentScreen === 'chat_list') this.renderChatList(root);
		else this.renderChat(root);
	}

	// ── Chat screen ────────────────────────────────────────────

	private renderChat(root: HTMLElement) {
		const thread = this.plugin.getActiveThread();

		const header = root.createDiv('ai-agent-header');
		const backBtn = header.createEl('button', { cls: 'ai-agent-header-btn', text: '←', attr: { title: 'Alle Chats' } });
		backBtn.addEventListener('click', () => { this.currentScreen = 'chat_list'; this.render(); });
		header.createDiv({ cls: 'ai-agent-header-title', text: thread.title || 'Untitled' });
		const actions = header.createDiv('ai-agent-header-actions');
		const newBtn = actions.createEl('button', { cls: 'ai-agent-header-btn', text: '✎', attr: { title: 'Neuer Chat' } });
		newBtn.addEventListener('click', () => { this.plugin.createNewThread(); this.currentScreen = 'chat'; this.render(); });

		this.messagesEl = root.createDiv('ai-agent-messages');
		for (const msg of thread.messages) this.renderMessageEl(msg);
		this.scrollToBottom();

		this.renderComposer(root, thread);
	}

	private renderMessageEl(msg: ChatMessage) {
		if (msg.role === 'user') {
			const row = this.messagesEl.createDiv('ai-message-user-row');
			row.createDiv({ cls: 'ai-message ai-message-user', text: msg.content });
		} else {
			const el = this.messagesEl.createDiv('ai-message ai-message-assistant');
			void MarkdownRenderer.render(this.app, msg.content, el, '', this);
		}
	}


	// ── Chat list screen ───────────────────────────────────────

	private renderChatList(root: HTMLElement) {
		const header = root.createDiv('ai-agent-list-header');
		header.createDiv({ cls: 'ai-agent-list-title', text: 'Tasks' });
		const newBtn = header.createEl('button', { cls: 'ai-agent-header-btn', text: '+', attr: { title: 'Neuer Chat' } });
		newBtn.addEventListener('click', () => { this.plugin.createNewThread(); this.currentScreen = 'chat'; this.render(); });

		const listEl = root.createDiv('ai-agent-thread-list');
		const threads = this.plugin.chatStore.threads.filter(t => !t.archived).sort((a, b) => b.updatedAt - a.updatedAt);
		if (!threads.length) listEl.createDiv({ cls: 'ai-agent-empty-state', text: 'Noch keine Chats. Starte mit +.' });

		for (const t of threads) {
			const row = listEl.createDiv('ai-agent-thread-row');
			if (t.id === this.plugin.chatStore.activeThreadId) row.addClass('is-active');
			row.createDiv({ cls: 'ai-agent-thread-title', text: t.title || 'Untitled' });
			row.createDiv({ cls: 'ai-agent-thread-age', text: this.relativeTime(t.updatedAt) });
			row.addEventListener('click', () => {
				this.plugin.chatStore.activeThreadId = t.id;
				void this.plugin.saveAll();
				this.currentScreen = 'chat';
				this.render();
			});
			const archBtn = row.createEl('button', { cls: 'ai-agent-thread-archive-btn', attr: { title: 'Archivieren' } });
			setIcon(archBtn, 'archive');
			archBtn.addEventListener('click', e => { e.stopPropagation(); void this.plugin.archiveThread(t.id).then(() => this.render()); });
		}

		const archivedThreads = this.plugin.chatStore.threads.filter(t => t.archived).sort((a, b) => b.updatedAt - a.updatedAt);
		if (archivedThreads.length > 0) {
			const archiveSection = root.createDiv('ai-agent-archive-section');
			const archiveHeader = archiveSection.createDiv('ai-agent-archive-header');
			archiveHeader.createSpan({ cls: 'ai-agent-archive-toggle', text: this.showArchive ? '▾' : '▸' });
			archiveHeader.createSpan({ cls: 'ai-agent-archive-label', text: `Archiv (${archivedThreads.length})` });
			archiveHeader.addEventListener('click', () => { this.showArchive = !this.showArchive; this.render(); });

			if (this.showArchive) {
				const archiveList = archiveSection.createDiv('ai-agent-archive-list');
				for (const t of archivedThreads) {
					const row = archiveList.createDiv('ai-agent-thread-row');
					row.createDiv({ cls: 'ai-agent-thread-title', text: t.title || 'Untitled' });
					row.createDiv({ cls: 'ai-agent-thread-age', text: this.relativeTime(t.updatedAt) });
					const restoreBtn = row.createEl('button', { cls: 'ai-agent-thread-restore-btn', attr: { title: 'Wiederherstellen' } });
					setIcon(restoreBtn, 'undo');
					restoreBtn.addEventListener('click', (e: MouseEvent) => { e.stopPropagation(); void this.plugin.unarchiveThread(t.id).then(() => this.render()); });
					const deleteBtn = row.createEl('button', { cls: 'ai-agent-thread-delete-btn', attr: { title: 'Löschen' } });
					setIcon(deleteBtn, 'trash');
					deleteBtn.addEventListener('click', (e: MouseEvent) => { e.stopPropagation(); void this.plugin.deleteThread(t.id).then(() => this.render()); });
				}
			}
		}
	}

	// ── Composer ───────────────────────────────────────────────

	private renderComposer(root: HTMLElement, thread: ChatThread) {
		const composer = root.createDiv('ai-agent-composer');

		this.inputEl = composer.createEl('textarea', {
			cls: 'ai-agent-input',
			attr: { placeholder: this.modeInputPlaceholder('ask') },
		});
		this.inputEl.addEventListener('input', () => {
			this.resizeComposerInput();
		});
		this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void this.handleSend(); }
		});

		const bar = composer.createDiv('ai-agent-bottom-bar');

		const ctxBtn = bar.createEl('button', { cls: 'ai-agent-icon-btn', text: '+', attr: { title: 'Kontext' } });
		ctxBtn.addEventListener('click', () => this.togglePopover(ctxBtn, p => this.fillContextPopover(p, thread)));
		const optBtn = bar.createEl('button', { cls: 'ai-agent-icon-btn', text: '⚙', attr: { title: 'Optionen' } });
		optBtn.addEventListener('click', () => this.togglePopover(optBtn, p => this.fillOptionsPopover(p)));

		bar.createDiv('ai-agent-spacer');

		const model = getModelConfigWithCustom(thread.selectedModelId, this.plugin.settings.customModels);
		this.modelBtn = bar.createEl('button', { cls: 'ai-agent-model-btn', text: model?.label ?? thread.selectedModelId });
		this.modelBtn.addEventListener('click', () => this.togglePopover(this.modelBtn, p => this.fillModelDropdown(p, thread)));

		this.sendBtn = bar.createEl('button', { cls: 'ai-agent-send-btn', text: '↑', attr: { title: 'Senden' } });
		this.sendBtn.addEventListener('click', () => void this.handleSend());
	}

	// ── Popovers ───────────────────────────────────────────────

	private togglePopover(anchor: HTMLElement, fill: (el: HTMLElement) => void) {
		if (this.activePopover) { this.closePopover(); return; }
		const popover = document.body.createDiv('ai-agent-popover');
		this.activePopover = popover;
		fill(popover);
		const rect = anchor.getBoundingClientRect();
		popover.setCssProps({
			bottom: `${window.innerHeight - rect.top + 8}px`,
			left: `${rect.left}px`,
		});
		requestAnimationFrame(() => {
			const pr = popover.getBoundingClientRect();
			if (pr.right > window.innerWidth - 8) {
				popover.setCssProps({ left: `${window.innerWidth - pr.width - 8}px` });
			}
		});
		const onDown = (e: MouseEvent) => { if (!popover.contains(e.target as Node) && e.target !== anchor) this.closePopover(); };
		this.activePopoverCleanup = () => document.removeEventListener('mousedown', onDown);
		setTimeout(() => document.addEventListener('mousedown', onDown), 50);
	}

	private closePopover() {
		this.activePopover?.remove();
		this.activePopover = null;
		this.activePopoverCleanup?.();
		this.activePopoverCleanup = null;
	}

	// ── Context mode picker popover ────────────────────────────

	private fillContextPopover(popover: HTMLElement, thread: ChatThread) {
		popover.addClass('ai-agent-ctx-popover');
		popover.createEl('p', { text: 'Kontext', cls: 'ai-agent-popover-title' });

		const ALL_MODES: ContextMode[] = ['active_file', 'selected_text', 'manual_files', 'folder', 'vault', 'none'];
		let folderInputRow: HTMLElement | null = null;

		const save = async () => { thread.updatedAt = Date.now(); await this.plugin.saveAll(); };

		const toggleMode = async (mode: ContextMode, checked: boolean) => {
			if (mode === 'none') {
				setEffectiveModes(thread, checked ? ['none'] : ['active_file']);
			} else {
				let modes = getEffectiveModes(thread).filter(m => m !== 'none' && m !== mode);
				if (checked) modes.push(mode);
				setEffectiveModes(thread, modes.length ? modes : ['active_file']);
			}
			await save();
			renderCheckboxes();
			// show/hide folder input
			folderInputRow?.remove();
			folderInputRow = null;
			if (getEffectiveModes(thread).includes('folder')) showFolderInput();
		};

		const checkboxContainer = popover.createDiv('ai-agent-ctx-modes');

		const renderCheckboxes = () => {
			checkboxContainer.empty();
			const active = getEffectiveModes(thread);
			const noneSelected = active.includes('none');
			for (const mode of ALL_MODES) {
				const row = checkboxContainer.createDiv('ai-agent-mode-option');
				const cb = row.createEl('input', { attr: { type: 'checkbox' } }) as HTMLInputElement;
				cb.checked = active.includes(mode);
				if (mode !== 'none' && noneSelected) cb.disabled = true;
				const labelEl = row.createSpan({ text: CONTEXT_MODE_LABELS[mode] });
				if (mode === 'manual_files' && thread.manualFilePaths?.length) {
					labelEl.createSpan({ cls: 'ai-ctx-count', text: ` (${thread.manualFilePaths.length})` });
				}
				cb.addEventListener('change', () => {
					void (async () => {
						if (mode === 'manual_files' && cb.checked) {
							this.closePopover();
							new MultiFileModal(this.app, thread.manualFilePaths ?? [], async (paths) => {
								thread.manualFilePaths = paths;
								const modes: ContextMode[] = getEffectiveModes(thread).filter(m => m !== 'none' && m !== 'manual_files');
								if (paths.length) modes.push('manual_files');
								setEffectiveModes(thread, modes.length ? modes : ['active_file']);
								await save();
							}).open();
						} else {
							await toggleMode(mode, cb.checked);
						}
					})();
				});
				row.addEventListener('click', e => {
					if (e.target !== cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
				});
			}
		};

		const showFolderInput = () => {
			folderInputRow = popover.createDiv('ai-agent-ctx-folder-row');
			const input = folderInputRow.createEl('input', {
				cls: 'ai-agent-ctx-search',
				attr: { type: 'text', placeholder: 'Ordner-Pfad…', value: thread.folderPath ?? '' },
			});
			const resultEl = folderInputRow.createDiv('ai-agent-ctx-file-list');
			const renderFolders = (q: string) => {
				resultEl.empty();
				const seen = new Set<string>();
				for (const f of this.app.vault.getMarkdownFiles()) {
					const parts = f.path.split('/');
					for (let i = 1; i < parts.length; i++) seen.add(parts.slice(0, i).join('/'));
				}
				Array.from(seen).filter(p => !q || p.toLowerCase().includes(q.toLowerCase())).slice(0, 8)
					.forEach(p => {
						const item = resultEl.createDiv('ai-agent-ctx-file-item');
						item.createSpan({ text: '📁 ' + (p.split('/').pop() ?? p) });
						item.addEventListener('click', () => {
							void (async () => { thread.folderPath = p; await save(); input.value = p; resultEl.empty(); })();
						});
					});
			};
			input.addEventListener('input', () => renderFolders(input.value));
			input.addEventListener('blur', () => { if (input.value) { thread.folderPath = input.value; void save(); } });
			renderFolders('');
			setTimeout(() => input.focus(), 10);
		};

		renderCheckboxes();
		if (getEffectiveModes(thread).includes('folder')) showFolderInput();

		popover.createEl('hr', { cls: 'ai-agent-ctx-sep' });
		const agentMdRow = popover.createDiv('ai-agent-popover-toggle');
		const agentMdCb = agentMdRow.createEl('input', { attr: { type: 'checkbox' } });
		agentMdCb.checked = thread.includeAgentMd !== false;
		agentMdRow.createSpan({ text: 'agent.md' });
		agentMdCb.addEventListener('change', () => {
			void (async () => { thread.includeAgentMd = agentMdCb.checked; thread.updatedAt = Date.now(); await this.plugin.saveAll(); })();
		});
	}

	private fillOptionsPopover(popover: HTMLElement) {
		popover.addClass('ai-agent-tools-popover');
		popover.createEl('p', { text: 'Tools', cls: 'ai-agent-popover-title' });
		this.addIconToggle(popover, 'globe', 'Websearch', 'Websuche aktivieren', this.options.webSearch, v => { this.options.webSearch = v; });
		this.addIconToggle(popover, 'brain', 'Thinking Mode', 'Erweitertes Denken', this.options.thinkingMode, v => { this.options.thinkingMode = v; });
		this.addIconToggle(popover, 'folder-open', 'Vault-Tools', 'Dateizugriff & Suche', this.options.vaultTools, v => { this.options.vaultTools = v; });
	}

	private addIconToggle(parent: HTMLElement, iconName: string, label: string, desc: string, checked: boolean, onChange: (v: boolean) => void) {
		const row = parent.createDiv('ai-agent-tool-row');
		const left = row.createDiv('ai-agent-tool-left');
		const iconEl = left.createSpan({ cls: 'ai-agent-tool-icon' });
		setIcon(iconEl, iconName);
		const info = left.createDiv('ai-agent-tool-info');
		info.createDiv({ cls: 'ai-agent-tool-label', text: label });
		if (desc) info.createDiv({ cls: 'ai-agent-tool-desc', text: desc });
		const toggleLabel = row.createEl('label', { cls: 'ai-agent-toggle-switch' });
		const cb = toggleLabel.createEl('input', { attr: { type: 'checkbox' } });
		cb.checked = checked;
		toggleLabel.createSpan({ cls: 'ai-agent-toggle-slider' });
		cb.addEventListener('change', () => onChange(cb.checked));
	}

	private addToggle(parent: HTMLElement, label: string, checked: boolean, onChange: (v: boolean) => void) {
		const row = parent.createDiv('ai-agent-popover-toggle');
		const cb = row.createEl('input', { attr: { type: 'checkbox' } });
		cb.checked = checked;
		row.createSpan({ text: label });
		cb.addEventListener('change', () => onChange(cb.checked));
	}

	// ── Model dropdown ─────────────────────────────────────────

	private fillModelDropdown(popover: HTMLElement, thread: ChatThread) {
		popover.addClass('ai-agent-model-dropdown');
		const searchEl = popover.createEl('input', { cls: 'ai-agent-model-search', attr: { type: 'text', placeholder: 'Modell suchen…' } });
		const listEl = popover.createDiv('ai-agent-model-list');
		const custom = this.plugin.settings.customModels;

		const renderFiltered = (f: string) => {
			listEl.empty();
			const lf = f.toLowerCase();
			const vis = getAllModels(custom).filter(m =>
				!m.deprecated &&
				(!f || m.label.toLowerCase().includes(lf) || m.provider.toLowerCase().includes(lf) || m.id.toLowerCase().includes(lf))
			);
			if (!vis.length) { listEl.createEl('p', { text: 'Kein Modell gefunden.', cls: 'ai-agent-model-empty' }); return; }
			vis.forEach(m => this.addModelItem(listEl, m.id, thread));
		};
		const renderGrouped = () => {
			listEl.empty();
			const rec = getRecommendedModels();
			if (rec.length) { this.addModelGroup(listEl, 'Empfohlen'); rec.forEach(m => this.addModelItem(listEl, m.id, thread)); }
			for (const { label, provider } of PROVIDER_GROUPS) {
				const ms = getModelsByProvider(provider, custom);
				if (!ms.length) continue;
				this.addModelGroup(listEl, label);
				ms.forEach(m => this.addModelItem(listEl, m.id, thread));
			}
			if (custom.length) { this.addModelGroup(listEl, 'Custom'); custom.forEach(m => this.addModelItem(listEl, m.id, thread)); }
		};
		searchEl.addEventListener('input', () => searchEl.value.trim() ? renderFiltered(searchEl.value) : renderGrouped());
		renderGrouped();
		setTimeout(() => searchEl.focus(), 10);
	}

	private addModelGroup(parent: HTMLElement, label: string) {
		parent.createDiv({ text: label, cls: 'ai-agent-model-group-title' });
	}

	private addModelItem(parent: HTMLElement, modelId: string, thread: ChatThread) {
		const model = getModelConfigWithCustom(modelId, this.plugin.settings.customModels);
		if (!model) return;
		const item = parent.createDiv('ai-agent-model-item');
		if (model.id === thread.selectedModelId) item.addClass('is-selected');
		const main = item.createDiv('ai-agent-model-item-main');
		main.createSpan({ text: model.label, cls: 'ai-agent-model-item-name' });
		const availability = getModelAvailability(model);
		main.createSpan({ text: `${model.provider} · ${availability}`, cls: 'ai-agent-model-item-provider' });
		const badges = item.createDiv('ai-agent-model-item-badges');
		badges.createSpan({ text: model.quality, cls: 'ai-agent-model-item-speed' });
		if (availability !== 'verified') {
			const badge = badges.createSpan({ text: availability, cls: `ai-agent-model-item-availability is-${availability}` });
			badge.title = getModelSourceUrl(model);
		}
		item.addEventListener('click', () => {
			thread.selectedModelId = model.id;
			this.plugin.settings.lastSelectedModelId = model.id;
			void this.plugin.saveAll();
			this.modelBtn.textContent = model.label;
			this.closePopover();
		});
	}

	// ── Agent send loop ────────────────────────────────────────

	private async handleSend() {
		const rawMessage = this.inputEl.value.trim();
		if (!rawMessage || this.isLoading) return;

		const thread = this.plugin.getActiveThread();

		// Slash commands route one message explicitly. Normal input stays automatic.
		const parsedSlash = parseSlashCommand(rawMessage);
		const slashCmd = parsedSlash.command;
		let strippedMsg = parsedSlash.stripped;
		if (slashCmd && !strippedMsg) {
			if (slashCmd === 'agent' && thread.pendingTaskPlan) {
				strippedMsg = 'mach das';
			} else {
			this.inputEl.value = '';
			this.inputEl.setCssProps({ height: 'auto' });
			this.inputEl.setAttribute('placeholder', `/${slashCmd} direkt mit Aufgabe verwenden…`);
			return;
			}
		}
		const message = slashCmd ? strippedMsg : rawMessage;

		this.inputEl.value = '';
		this.inputEl.setCssProps({ height: 'auto' });
		this.statusBodyEl = null;
		this.statusHeaderEl = null;
		if (this.thinkingDotsInterval) { clearInterval(this.thinkingDotsInterval); this.thinkingDotsInterval = null; }
		this.emittedStatusKeys.clear();
		this.closePopover();

		await this.plugin.addMessageToThread(thread.id, { role: 'user', content: message, modelId: thread.selectedModelId });
		const userBubbleWrapper = this.appendUserBubble(message);
		const summaryChanged = refreshWorkingSummary(thread);
		if (summaryChanged) await this.plugin.saveAll();

		const modelConfig = getModelConfigWithCustom(thread.selectedModelId, this.plugin.settings.customModels);
		if (!modelConfig) { this.appendStatusLine(`Unbekanntes Modell: ${thread.selectedModelId}`); return; }
		const apiModelId = getModelApiId(modelConfig);
		const reasoning = modelConfig.reasoning ?? (this.options.thinkingMode ? legacyThinkingReasoning(modelConfig) : undefined);
		const thinkingMode = isReasoningActive(reasoning);
		const llmRerankFn = this.plugin.settings.enableLlmRerank
			? async (prompt: string) => {
				const rerankPayload: ChatRequestPayload = {
					provider: modelConfig.provider,
					model: apiModelId,
					auth: this.getAuthForProvider(modelConfig.provider),
					message: prompt,
					history: [],
					context: [],
					tool_results: [],
					options: {
						thinking_mode: false,
						web_search: false,
						vault_tools_enabled: false,
						stream: false,
						max_context_chars: 2000,
						max_output_tokens: 200,
						agent_mode: this.plugin.settings.agentMode,
						execution_phase: 'normal',
						embedding_backend: this.plugin.settings.embeddingBackend,
						enable_style_critique: false,
					},
				};
				const resp = await callProvider(rerankPayload);
				return resp.answer ?? '';
			}
			: null;
		this.toolExecutor.setLlmRerankFn(llmRerankFn);
		this.contextResolver.setLlmRerankFn(llmRerankFn);

		// Check rate-limit cooldown from a previous request
		const waitSecs = rateLimitManager.shouldWait(modelConfig.provider, apiModelId);
		if (waitSecs > 0) {
			this.appendStatusLine(`Rate Limit — warte ${waitSecs}s…`);
			await new Promise(r => setTimeout(r, waitSecs * 1000));
		}

		// ── Intent routing ─────────────────────────────────────────
		const intentInput = {
			hasActiveFile: Boolean(getEffectiveModes(thread).includes('active_file') && this.app.workspace.getActiveFile()?.path),
			hasMentionedFiles: this.contextResolver.getReferencedFilePaths(message).length > 0,
			hasSelection: Boolean(this.app.workspace.getActiveFile() && window.getSelection()?.toString().trim()),
			webSearchEnabled: this.options.webSearch && modelConfig.supportsWebSearch,
		};
		let routeResult = routeIntent(rawMessage, 'ask', {
			...intentInput,
			learnedIntentPatterns: this.plugin.settings.learnedIntentPatterns,
		});
		const pendingPlan = thread.pendingTaskPlan ? clonePendingTaskPlan(thread.pendingTaskPlan) : null;
		const revisePendingPlan = Boolean(pendingPlan && isPendingPlanRevisionRequest(message));
		const executePendingPlan = Boolean(pendingPlan && !revisePendingPlan && isPendingPlanExecutionRequest(message));
		if (executePendingPlan) {
			routeResult = {
				mode: 'agent',
				needsPlanner: true,
				allowWrites: true,
				maxRetrievedChunks: 10,
				reason: 'Gespeicherter Plan bestaetigt',
				confidence: 'high',
				signals: ['pending_plan_execute'],
			};
		} else if (revisePendingPlan) {
			routeResult = {
				mode: 'plan',
				needsPlanner: true,
				allowWrites: false,
				maxRetrievedChunks: 10,
				reason: 'Gespeicherten Plan anpassen',
				confidence: 'high',
				signals: ['pending_plan_revision'],
			};
		}
		if (!executePendingPlan && !revisePendingPlan && this.plugin.settings.enableIntentClassifier && shouldRunIntentClassifier(routeResult, {
			message,
			...intentInput,
		})) {
			const classifiedRoute = await this.classifyIntentWithLlm(message, routeResult, intentInput, modelConfig.provider, apiModelId);
			routeResult = classifiedRoute;
		}

		// Resolve & compact context to stay within provider token limits
		const resolvedContext = await this.contextResolver.resolveContext(thread, message, { route: routeResult });
		const pendingPlanContext = pendingPlan && (executePendingPlan || revisePendingPlan)
			? [buildPendingPlanContext(pendingPlan)]
			: [];
		const rawContext = [...pendingPlanContext, ...buildWorkingMemoryContext(thread), ...resolvedContext];
		const profile = getRateLimitProfile(modelConfig.provider, apiModelId);
		const learnedTpm = rateLimitManager.learnedTpm(modelConfig.provider, apiModelId);
		const profileContextChars = defaultMaxContextChars(modelConfig.provider, apiModelId);
		const dynamicContextChars = learnedTpm ? Math.max(8_000, Math.floor(learnedTpm * 0.35 * 3)) : profileContextChars;
		const maxContextChars = Math.min(profileContextChars, dynamicContextChars);
		const context = compactContextForBudget(rawContext, maxContextChars, {
			intent: this.contextResolver.getLastIntent(),
			query: message,
			maxRetrievedChunks: routeResult.maxRetrievedChunks,
		});

		const writesBlocked = !routeResult.allowWrites;
		const usePlanner = (() => {
			if (executePendingPlan) return false;
			switch (routeResult.mode) {
				case 'ask':   return false;
				case 'edit':  return shouldUsePlanner(message, context);
				case 'agent': return classifyTaskComplexity(message, context) !== 'simple' || shouldUsePlanner(message, context);
				case 'plan':  return true;
			}
		})();

			const history = buildCompactHistory(thread).slice(0, -1);
			const vaultToolsEnabled = this.options.vaultTools;
			const maxOutputTokens = defaultMaxOutputTokens(modelConfig.provider, apiModelId);
			const allowedToolNames = this.buildAllowedToolNamesForRequest(routeResult.mode, message, thread);
			const templateHint = this.plugin.settings.autoApplyFileTemplates
				? buildTemplateHint(message, context)
				: undefined;
		const editFormatHint = buildEditFormatHint(modelConfig.provider, apiModelId);
		const baseOptions = {
			thinking_mode: thinkingMode,
			reasoning,
			web_search: this.options.webSearch && modelConfig.supportsWebSearch,
			vault_tools_enabled: vaultToolsEnabled,
			stream: false,
			max_context_chars: maxContextChars,
			max_output_tokens: maxOutputTokens,
			agent_mode: this.plugin.settings.agentMode,
			execution_phase: usePlanner ? 'plan' as const : 'normal' as const,
				ui_mode: routeResult.mode,
				allowed_tool_names: allowedToolNames,
				style_profile: buildStyleProfile(this.plugin.settings, maxContextChars),
			template_hint: templateHint,
			edit_format_hint: editFormatHint,
			embedding_backend: this.plugin.settings.embeddingBackend,
			enable_style_critique: this.plugin.settings.enableStyleCritique,
		};
		const systemPrompt = buildSystemPrompt({
			provider: modelConfig.provider,
			model: apiModelId,
			auth: this.getAuthForProvider(modelConfig.provider),
			message,
			history,
			context,
			tool_results: [],
			options: baseOptions,
		});

		// Debug: show what context was collected and an estimated token count
		for (const item of context) {
			const parts: string[] = [item.type];
			if (item.path) parts.push(item.path);
			if (item.content) parts.push(`${item.content.length} chars`);
			if (item.files?.length) parts.push(`${item.files.length} files`);
			this.appendStatusLine(`Context: ${parts.join(' | ')}`);
		}
		for (const rawItem of rawContext) {
			const compacted = context.find(item => item.type === rawItem.type && item.path === rawItem.path && item.label === rawItem.label);
			if (!rawItem.content || !compacted?.content) continue;
			const mode =
				compacted.content.includes('[outline mode]') ? 'outline'
				: compacted.content.includes('[... truncated by context budget ...]') ? 'trimmed'
				: 'full';
			this.appendStatusLine(`Budget: ${rawItem.type} | ${rawItem.content.length} -> ${compacted.content.length} chars | ${mode}`);
		}
		if (profile.requestsPerMinute || profile.tokensPerMinute || profile.inputTokensPerMinute) {
			const limits: string[] = [];
			if (profile.requestsPerMinute) limits.push(`${profile.requestsPerMinute} RPM`);
			if (profile.tokensPerMinute) limits.push(`${Math.round(profile.tokensPerMinute / 1000)}k TPM`);
			if (profile.inputTokensPerMinute) limits.push(`${Math.round(profile.inputTokensPerMinute / 1000)}k ITPM`);
			if (profile.outputTokensPerMinute) limits.push(`${Math.round(profile.outputTokensPerMinute / 1000)}k OTPM`);
			if (profile.requestsPerDay) limits.push(`${profile.requestsPerDay} RPD`);
			this.appendStatusLine(`Limit-Profil: ${limits.join(' | ')}`);
		} else if (modelConfig.provider === 'ollama') {
			this.appendStatusLine('Limit-Profil: Ollama lokal - Budget ueber Context, Queue und RAM/VRAM');
		}
		if (learnedTpm) {
			this.appendStatusLine(`Gelerntes TPM-Limit: ${learnedTpm}`);
		}
		if (thread.workingSummary) {
			this.appendStatusLine(`Arbeitszusammenfassung aktiv (${thread.archivedMessageCount ?? 0} Nachrichten archiviert)`);
		}
		if (templateHint) {
			const firstLine = templateHint.split('\n')[0]?.replace('DATEI_VORLAGE: ', '');
			this.appendStatusLine(`Vorlage aktiv: ${firstLine}`);
		}
		this.appendStatusLine(`Embeddings: ${this.plugin.settings.embeddingBackend}`);
		this.appendStatusLine(`Stil-Check: ${this.plugin.settings.enableStyleCritique ? 'aktiv' : 'aus'}`);
		this.appendStatusLine(`Edit-Format: ${modelConfig.provider}`);
		this.appendStatusLine(`Reasoning-Stufe: ${describeModelReasoning(reasoning)}`);
		this.appendStatusLine(`Modus: ${routeResult.mode.toUpperCase()} — ${routeResult.reason}${routeResult.confidence !== 'high' ? ` (${routeResult.confidence})` : ''}`);
		if (routeResult.signals?.length) this.appendStatusLine(`Intent-Signale: ${routeResult.signals.join(', ')}`);
		if (writesBlocked) this.appendStatusLine(`Schreibzugriff: blockiert (${routeResult.mode}-Modus)`);
		if (usePlanner) {
			this.appendStatusLine(`Plan-Flow: Planphase aktiv (${classifyTaskComplexity(message, context)})`);
		}
		const estTokens = estimatePayloadTokens({
			message,
			history,
			context,
			systemPrompt,
			maxOutputTokens,
		});
		const debugSnapshot = buildContextDebugSnapshot({
			rawContext,
			finalContext: context,
			contextModes: getEffectiveModes(thread),
			query: message,
			maxContextChars,
			estimatedTokens: estTokens,
			mode: routeResult.mode,
			modeReason: routeResult.reason,
			intentConfidence: routeResult.confidence,
			intentSignals: routeResult.signals,
		});
		this.appendContextToUserBubble(userBubbleWrapper, context, debugSnapshot);
		this.appendStatusLine(`~${Math.round(estTokens / 100) / 10}k Tokens geschätzt`);

		if (this.plugin.settings.enableLlmRerank) {
			this.appendStatusLine('LLM-Rerank: aktiv');
		}

		this.setLoading(true);
		try {
			const toolResults: ToolResult[] = [];
			let executionPhase: 'normal' | 'plan' | 'execute' = executePendingPlan ? 'execute' : usePlanner ? 'plan' : 'normal';
			let currentTaskPlan: TaskPlan | null = executePendingPlan ? pendingPlan : null;
			let currentEditPlan: EditPlan | null = executePendingPlan ? this.buildEditPlanFromTaskPlan(pendingPlan) : null;
			let activeSteps: TypedStep[] = executePendingPlan && pendingPlan
				? pendingPlan.steps.map(stepItem => ({ ...stepItem, status: 'pending' as const }))
				: [];
			let completedWithFinalResponse = false;
			let consecutiveReadOnlyRounds = 0;
			let latestSearchHadZeroHits = false;
			let consecutiveBlockedReadRounds = 0;
			const repeatedPlanErrors = new Map<string, number>();
			const mutationReasons = new Map<string, string>();
			const resetPhaseLoopCounters = () => {
				consecutiveReadOnlyRounds = 0;
				consecutiveBlockedReadRounds = 0;
				latestSearchHadZeroHits = false;
			};
			if (executePendingPlan && currentTaskPlan) {
				this.appendStatusLine('Pending-Plan: bestaetigt, Ausfuehrungsphase aktiv');
				if (activeSteps.length) this.appendStepList(activeSteps);
				toolResults.push({
					id: 'pending_task_plan',
					tool: 'task_plan',
					ok: true,
					result: currentTaskPlan,
				});
			}

			for (let step = 0; step < MAX_AGENT_STEPS; step++) {
				const compactedToolResults = compactToolResults(toolResults);
				const payload: ChatRequestPayload = {
					provider: modelConfig.provider,
					model: apiModelId,
					auth: this.getAuthForProvider(modelConfig.provider),
					message,
					history,
					context,
					tool_results: compactedToolResults,
					options: {
						...baseOptions,
						execution_phase: executionPhase,
					},
				};

				const response = await this.callWithFallback(
					payload,
					rawContext,
					maxContextChars,
					modelConfig.provider,
					apiModelId,
					{ intent: this.contextResolver.getLastIntent(), query: message },
				);

				for (const ev of response.events ?? []) this.appendProviderStatus(ev.text, step + 1);
				const usageLine = formatProviderUsage(response.usage);
				if (usageLine) this.appendStatusLine(`Usage: ${usageLine}`);

				if (response.tool_calls?.length) {
						const editReadLoopGuard = getEditReadLoopGuard(response.tool_calls, toolResults, message, routeResult.mode);
						const roundGuard = editReadLoopGuard ?? getRoundLoopGuard(response.tool_calls, toolResults, consecutiveReadOnlyRounds, latestSearchHadZeroHits);
					if (roundGuard) {
						this.appendStatusLine(`Loop-Guard: ${roundGuard}`);
						toolResults.push({
							id: `loop_guard_${step + 1}`,
							tool: 'loop_guard',
							ok: false,
							error: roundGuard,
						});
						consecutiveBlockedReadRounds += 1;
						if (consecutiveBlockedReadRounds >= 2) {
							const fallbackAnswer = this.buildFallbackAssistantMessage(
								message,
								toolResults,
								currentTaskPlan,
								`Der Host hat nach ${consecutiveBlockedReadRounds} geblockten Lese-Runden automatisch beendet, um eine weitere Schleife zu verhindern.`,
							);
							await this.deliverAssistantMessage(thread.id, thread.selectedModelId, modelConfig.provider, fallbackAnswer, this.collectUsedPaths(context, toolResults), context);
							completedWithFinalResponse = true;
							break;
						}
						if (executionPhase === 'execute') {
							executionPhase = 'plan';
							resetPhaseLoopCounters();
						}
						continue;
					}
					let completedToolCalls = 0;
					let roundHadWrite = false;
					const roundWasReadOnly = response.tool_calls.every(call => READ_ONLY_TOOLS.has(call.tool));
					// A round consisting only of metadata tools (list_files, query_dataview) is NOT counted
					// as a consecutive read-only round — it's discovery progress, not stuck repetition.
					const roundIsMetadataOnly = response.tool_calls.every(call => METADATA_ONLY_TOOLS.has(call.tool));
					let roundSearchZeroHits = false;
					let blockedReadThisRound = false;
					const currentRoundReadPaths = new Set<string>();
					for (const call of response.tool_calls) {
						if (baseOptions.allowed_tool_names && !baseOptions.allowed_tool_names.includes(call.tool)) {
							this.appendStatusLine(`Tool-Guard: ${call.tool} nicht im erlaubten Toolset`);
							toolResults.push({
								id: call.id,
								tool: call.tool,
								args: call.args,
								provider_context: call.provider_context,
								ok: false,
								error: `Tool guard: ${call.tool} is not allowed for this request. Allowed tools: ${baseOptions.allowed_tool_names.join(', ')}.`,
							});
							continue;
						}
						if (executionPhase === 'plan' && !PLAN_ALLOWED_TOOLS.has(call.tool)) {
							this.appendStatusLine(`Plan-Guard: ${call.tool} in Planphase blockiert`);
							toolResults.push({
								id: call.id,
								tool: call.tool,
								args: call.args,
								provider_context: call.provider_context,
								ok: false,
								error: `Planning phase: ${call.tool} is not allowed yet. Read/search first and return a short edit plan before executing write tools.`,
							});
							continue;
						}
						if (writesBlocked && WRITE_TOOLS.has(call.tool)) {
							this.appendStatusLine(`Modus-Guard: ${call.tool} blockiert (${routeResult.mode}-Modus erlaubt keine Schreibzugriffe)`);
							toolResults.push({ id: call.id, tool: call.tool, args: call.args, provider_context: call.provider_context, ok: false, error: `Mode guard: write tools blocked in ${routeResult.mode} mode. Switch to /edit or /agent mode to make changes.` });
							continue;
							}
							this.appendStatusLine(`Tool: ${call.tool}${call.reason ? ` — ${call.reason}` : ''}`);
							const readFolderScopeError = this.validateReadToolScope(call, thread, message, routeResult.mode);
							if (readFolderScopeError) {
								this.appendStatusLine(`Scope-Guard: ${readFolderScopeError}`);
								toolResults.push({
									id: call.id,
									tool: call.tool,
									args: call.args,
									provider_context: call.provider_context,
									ok: false,
									error: readFolderScopeError,
								});
								blockedReadThisRound = true;
								continue;
							}
							const duplicateReadError = getDuplicateReadGuard(call, toolResults, currentRoundReadPaths);
						if (duplicateReadError) {
							this.appendStatusLine(`Loop-Guard: ${duplicateReadError}`);
							toolResults.push({
								id: call.id,
								tool: call.tool,
								args: call.args,
								provider_context: call.provider_context,
								ok: false,
								error: duplicateReadError,
							});
							blockedReadThisRound = true;
							continue;
						}
						if (call.tool === 'read_file') {
							const path = typeof call.args['path'] === 'string' ? call.args['path'] : '';
							if (path) currentRoundReadPaths.add(path);
						}
						if (executionPhase === 'execute' && currentEditPlan) {
							const guardError = this.validateEditToolCall(call, currentEditPlan, toolResults);
							if (guardError) {
								this.appendStatusLine(`Execute-Guard: ${guardError}`);
								toolResults.push({
									id: call.id,
									tool: call.tool,
									args: call.args,
									provider_context: call.provider_context,
									ok: false,
									error: guardError,
								});
								continue;
							}
						}
						const writeSafetyError = this.validateWriteSafety(call, toolResults, message);
						if (writeSafetyError) {
							this.appendStatusLine(`Write-Guard: ${writeSafetyError}`);
							toolResults.push({
								id: call.id,
								tool: call.tool,
								args: call.args,
								provider_context: call.provider_context,
								ok: false,
								error: writeSafetyError,
							});
							continue;
						}
						const result = await this.toolExecutor.execute(call);
						toolResults.push(result);
						this.appendToolResultStatus(call.tool, result);
						const isRecoverablePatchFailure =
							call.tool === 'patch_file' &&
							!result.ok &&
							typeof result.error === 'string' &&
							(
								result.error.includes('oldText not found') ||
								result.error.includes('ambiguous match')
							);
						const resultPath = result.result && typeof result.result === 'object'
							? ((result.result as { path?: unknown }).path as string | undefined)
							: undefined;
						if (!isRecoverablePatchFailure) {
							recordToolOutcome(thread, {
								tool: call.tool,
								ok: result.ok,
								path: resultPath ?? (typeof call.args['path'] === 'string' ? call.args['path'] : undefined),
								turnId: `${thread.id}:${call.id}`,
								error: result.error,
							});
						}
						if (result.ok) completedToolCalls += 1;
						if (WRITE_TOOLS.has(call.tool) && result.ok) {
							roundHadWrite = true;
							const mutationPath = resultPath ?? (typeof call.args['path'] === 'string' ? call.args['path'] : '');
							const mutationReason = typeof call.reason === 'string' ? call.reason.trim() : '';
							if (mutationPath && mutationReason) mutationReasons.set(mutationPath, mutationReason);
						}
						if (call.tool === 'search_vault' && result.ok && getSearchResultCount(result) === 0) roundSearchZeroHits = true;
						if (!result.ok && result.error) {
							this.appendStatusLine(result.cancelled ? `Tool abgelehnt: ${result.error}` : `Tool-Fehler: ${result.error}`);
						}

						if (currentTaskPlan && activeSteps.length > 0) {
							const advanced = advanceTaskPlan(currentTaskPlan, call.tool, result.ok, result.error);
							currentTaskPlan = advanced.plan;
							activeSteps = currentTaskPlan.steps.map(stepItem => ({ ...stepItem }));
							if (advanced.outcome) {
								this.updateStepStatus(activeSteps, advanced.outcome.step_id, advanced.outcome.status === 'done' ? 'done' : 'failed');
							}
						}
						if (isRecoverablePatchFailure) {
							const path = typeof call.args['path'] === 'string' ? call.args['path'] : '';
							if (path) {
								this.appendStatusLine(`Recovery: lese ${path} neu ein...`);
								const refreshResult = await this.toolExecutor.execute({
									id: `${call.id}_refresh`,
									tool: 'read_file',
									args: { path, maxChars: 60000 },
									reason: 'Refresh file after failed patch',
								});
								toolResults.push(refreshResult);
								if (refreshResult.ok) this.appendStatusLine(`Recovery: ${path} neu geladen`);
								else if (refreshResult.error) this.appendStatusLine(`Recovery-Fehler: ${refreshResult.error}`);
								if (refreshResult.ok) toolResults.splice(0, Math.max(0, toolResults.length - 2));
								if (refreshResult.ok) {
									toolResults.push({
										id: `${call.id}_hint`,
										tool: 'patch_recovery_hint',
										ok: true,
										result: `Der letzte patch_file-Aufruf fuer ${path} ist fehlgeschlagen. Nutze den frisch gelesenen Dateistand und erzeuge jetzt entweder einen groesseren, eindeutigeren Patch oder verwende write_file mit overwrite=true, falls eine groessere Neufassung sinnvoller ist.`,
									});
								}
							}
						}
					}
					consecutiveReadOnlyRounds = roundWasReadOnly && !roundHadWrite && !roundIsMetadataOnly
						? consecutiveReadOnlyRounds + 1
						: roundIsMetadataOnly ? consecutiveReadOnlyRounds  // no change — metadata rounds don't count
						: 0;
					latestSearchHadZeroHits = roundSearchZeroHits;
					if (roundHadWrite) latestSearchHadZeroHits = false;
					if (blockedReadThisRound && roundWasReadOnly && !roundHadWrite) {
						consecutiveBlockedReadRounds += 1;
					} else if (completedToolCalls > 0 || roundHadWrite) {
						consecutiveBlockedReadRounds = 0;
					}
					if (consecutiveBlockedReadRounds >= 2) {
						this.appendStatusLine(`Loop-Guard: ${consecutiveBlockedReadRounds} geblockte Lese-Runden erkannt`);
						const fallbackAnswer = this.buildFallbackAssistantMessage(
							message,
							toolResults,
							currentTaskPlan,
							`Der Host hat nach ${consecutiveBlockedReadRounds} geblockten Lese-Runden automatisch abgeschlossen, um weiteres Kreisen zu verhindern.`,
						);
						await this.deliverAssistantMessage(thread.id, thread.selectedModelId, modelConfig.provider, fallbackAnswer, this.collectUsedPaths(context, toolResults), context);
						completedWithFinalResponse = true;
						break;
					}
					if (consecutiveReadOnlyRounds >= 2) {
						this.appendStatusLine(`Loop-Guard: ${consecutiveReadOnlyRounds} reine Lese-Runden erkannt`);
						toolResults.push({
							id: `loop_guard_readonly_${step + 1}`,
							tool: 'loop_guard',
							ok: false,
							error: 'Too many read-only rounds. You must now either: (1) call read_file on the specific target file you identified, then immediately patch_file or write_file it; or (2) return a concise status answer. Do NOT call search_vault or list_files again.',
						});
						if (executionPhase === 'execute') {
							executionPhase = 'plan';
							resetPhaseLoopCounters();
						}
					}
					if (roundHadWrite && !this.hasPendingMutationStep(currentTaskPlan)) {
						const finalAnswer = postCheckAssistantAnswer(
							this.buildSuccessfulMutationMessage(toolResults, currentTaskPlan, mutationReasons, message),
							this.plugin.settings,
							{ mutatedPaths: this.getMutatedPaths(toolResults) },
						);
						await this.maybePersistUserPreference(message, toolResults);
						if (executePendingPlan) this.clearPendingTaskPlan(thread);
						await this.deliverAssistantMessage(thread.id, thread.selectedModelId, modelConfig.provider, finalAnswer, this.collectUsedPaths(context, toolResults), context);
						completedWithFinalResponse = true;
						break;
					}
					this.appendStatusLine(`Fortschritt: ${completedToolCalls}/${response.tool_calls.length} Tool-Aufrufe abgeschlossen, naechste Modellrunde startet`);
					continue;
				}

				if (response.answer) {
					if (executionPhase === 'plan') {
						const taskPlan = parseTaskPlan(response.answer)
							?? this.buildTaskPlanFromLegacyEditPlan(parseStructuredEditPlan(response.answer));
						if (taskPlan) {
							const planError = this.validateTaskPlanAgainstContext(taskPlan, context, toolResults, message);
							if (planError) {
								this.appendStatusLine(`Plan-Fehler: ${planError}`);
								const planErrorCount = (repeatedPlanErrors.get(planError) ?? 0) + 1;
								repeatedPlanErrors.set(planError, planErrorCount);
								toolResults.push({
									id: `task_plan_invalid_${step + 1}`,
									tool: 'task_plan',
									ok: false,
									error: this.buildPlanRepairHint(planError, context, toolResults),
								});
								if (planErrorCount >= 2) {
									const fallbackAnswer = this.buildFallbackAssistantMessage(
										message,
										toolResults,
										currentTaskPlan,
										`Der Plan wurde wiederholt mit demselben ungueltigen Ziel abgelehnt: ${planError}`,
									);
									await this.deliverAssistantMessage(thread.id, thread.selectedModelId, modelConfig.provider, fallbackAnswer, this.collectUsedPaths(context, toolResults), context);
									completedWithFinalResponse = true;
									break;
								}
								continue;
							}
							currentTaskPlan = taskPlan;
							currentEditPlan = this.buildEditPlanFromTaskPlan(taskPlan);
							const summary = this.summarizeTaskPlan(taskPlan);
							this.appendStatusLine(`Plan: ${summary}`);
							if (taskPlan.steps?.length) {
								activeSteps = taskPlan.steps.map(s => ({ ...s, status: 'pending' as const }));
								this.appendStepList(activeSteps);
							}
							toolResults.push({
								id: `task_plan_${step + 1}`,
								tool: 'task_plan',
								ok: true,
								result: taskPlan,
							});
							// Plan mode: deliver plan as answer, no execution
							if (routeResult.mode === 'plan') {
								this.savePendingTaskPlan(thread, taskPlan);
								this.appendStatusLine('Pending-Plan: gespeichert, wartet auf Bestaetigung');
								const planDisplay = this.formatPlanForDisplay(taskPlan);
								await this.deliverAssistantMessage(thread.id, thread.selectedModelId, modelConfig.provider, planDisplay, [], context);
								completedWithFinalResponse = true;
								break;
							}
							executionPhase = 'execute';
							resetPhaseLoopCounters();
							this.appendStatusLine('Plan-Flow: Ausfuehrungsphase aktiv');
							continue;
						}
						const fallbackPlan = buildFallbackPlan(message, context);
						if (routeResult.mode === 'plan') {
							this.appendStatusLine('Plan-Hinweis: unstrukturierter Plantext wird direkt ausgegeben');
							const planDisplay = this.formatUnstructuredPlanForDisplay(response.answer);
							await this.deliverAssistantMessage(thread.id, thread.selectedModelId, modelConfig.provider, planDisplay, [], context);
							completedWithFinalResponse = true;
							break;
						}
						this.appendStatusLine('Plan-Fehler: strukturierter Plan fehlt oder ist ungueltig');
						toolResults.push({
							id: `task_plan_invalid_${step + 1}`,
							tool: 'task_plan',
							ok: false,
							error: `Structured task plan missing or invalid. Return answer as JSON with goal, complexity and steps. Optional file-edit fields may be included. Fallback: ${JSON.stringify(fallbackPlan)}`,
						});
						continue;
					}
					const replan = currentTaskPlan && currentTaskPlan.complexity !== 'simple'
						? shouldReplanFromToolResults(toolResults)
						: { required: false as const };
					if (executionPhase === 'execute' && replan.required) {
						this.appendStatusLine(`Replan: ${replan.reason ?? 'Ausfuehrung fehlgeschlagen'}`);
						toolResults.push({
							id: `task_plan_replan_${step + 1}`,
							tool: 'task_plan',
							ok: false,
							error: `Replan required: ${replan.reason ?? 'one or more execution steps failed'}`,
						});
						executionPhase = 'plan';
						resetPhaseLoopCounters();
						continue;
					}
					if (executionPhase === 'execute' && currentTaskPlan) {
						const redundantPlan = parseTaskPlan(response.answer)
							?? this.buildTaskPlanFromLegacyEditPlan(parseStructuredEditPlan(response.answer));
						if (redundantPlan) {
							this.appendStatusLine('Execute-Guard: Modell hat erneut einen Plan geliefert; Ausfuehrung wird angefordert');
							toolResults.push({
								id: `execute_plan_instead_of_tools_${step + 1}`,
								tool: 'task_plan',
								ok: false,
								error: 'A valid task plan is already accepted and execution phase is active. Do not return another plan or JSON. Execute the pending write/patch steps now using the available tools.',
							});
							continue;
						}
					}
					const mutatedPaths = this.getMutatedPaths(toolResults);
					const finalAnswer = postCheckAssistantAnswer(response.answer, this.plugin.settings, { mutatedPaths });
					await this.maybePersistUserPreference(message, toolResults);
					const usedPaths = [
						...context.filter(item => item.path).map(item => item.path!),
						...toolResults
							.filter(r => r.ok && (r.tool === 'read_file' || r.tool === 'read_active_file'))
							.map(r => (r.result as { path?: string })?.path ?? '')
							.filter(Boolean),
					].filter((p, i, a) => a.indexOf(p) === i);
					await this.deliverAssistantMessage(thread.id, thread.selectedModelId, modelConfig.provider, finalAnswer, usedPaths, context);
					completedWithFinalResponse = true;
					break;
				}
				this.appendStatusLine(`Agent-Loop: Modellrunde ${step + 1} lieferte weder Antwort noch Tool-Calls`);
				const fallbackAnswer = this.buildFallbackAssistantMessage(message, toolResults, currentTaskPlan, 'Das Modell hat keinen verwertbaren Abschlussschritt geliefert.');
				await this.deliverAssistantMessage(thread.id, thread.selectedModelId, modelConfig.provider, fallbackAnswer, this.collectUsedPaths(context, toolResults), context);
				completedWithFinalResponse = true;
				break;
			}
			if (!completedWithFinalResponse) {
				this.appendStatusLine(`Agent-Loop: Maximale Schrittzahl erreicht (${MAX_AGENT_STEPS})`);
				const fallbackAnswer = this.buildFallbackAssistantMessage(message, toolResults, currentTaskPlan, `Der Agent wurde nach ${MAX_AGENT_STEPS} Werkzeugrunden ohne sauberen Abschluss gestoppt.`);
				await this.deliverAssistantMessage(thread.id, thread.selectedModelId, modelConfig.provider, fallbackAnswer, this.collectUsedPaths(context, toolResults), context);
			}
		} catch (err) {
			const fallbackAnswer = this.buildFallbackAssistantMessage(message, [], null, err instanceof Error ? err.message : String(err));
			await this.deliverAssistantMessage(thread.id, thread.selectedModelId, modelConfig.provider, fallbackAnswer, [], context);
		} finally {
			this.toolExecutor.setLlmRerankFn(null);
			this.contextResolver.setLlmRerankFn(null);
			this.setLoading(false);
			this.inputEl?.focus();
		}
	}

	private collectUsedPaths(context: ContextItem[], toolResults: ToolResult[]): string[] {
		return [
			...context.filter(item => item.path).map(item => item.path!),
			...toolResults
				.filter(r => r.ok && (r.tool === 'read_file' || r.tool === 'read_active_file'))
				.map(r => (r.result as { path?: string })?.path ?? '')
				.filter(Boolean),
		].filter((p, i, a) => a.indexOf(p) === i);
	}

	private getMutatedPaths(toolResults: ToolResult[]): string[] {
		return toolResults
			.filter(result => result.ok && ['write_file', 'patch_file', 'delete_file'].includes(result.tool))
			.map(result => {
				if (!result.result || typeof result.result !== 'object') return '';
				return ((result.result as { path?: unknown }).path as string | undefined) ?? '';
			})
			.filter((path): path is string => Boolean(path))
			.filter((path, index, list) => list.indexOf(path) === index);
	}

	private hasPendingMutationStep(plan: TaskPlan | null): boolean {
		return Boolean(plan?.steps.some(step =>
			step.status === 'pending' && ['write', 'patch', 'delete'].includes(step.type),
		));
	}

	private savePendingTaskPlan(thread: ChatThread, plan: TaskPlan) {
		thread.pendingTaskPlan = clonePendingTaskPlan(plan);
		thread.pendingTaskPlanCreatedAt = Date.now();
		thread.updatedAt = Date.now();
		void this.plugin.saveAll();
	}

	private clearPendingTaskPlan(thread: ChatThread) {
		if (!thread.pendingTaskPlan) return;
		delete thread.pendingTaskPlan;
		delete thread.pendingTaskPlanCreatedAt;
		thread.updatedAt = Date.now();
		void this.plugin.saveAll();
	}

	private buildSuccessfulMutationMessage(
		toolResults: ToolResult[],
		taskPlan: TaskPlan | null = null,
		mutationReasons: Map<string, string> = new Map(),
		userMessage = '',
	): string {
		const paths = this.getMutatedPaths(toolResults);
		const changed = paths.length
			? paths.map(path => {
				const result = toolResults.find(item => {
					if (!item.ok || !item.result || typeof item.result !== 'object') return false;
					return ((item.result as { path?: unknown }).path as string | undefined) === path;
				});
				const action = result?.result && typeof result.result === 'object'
					? ((result.result as { action?: unknown }).action as string | undefined)
					: undefined;
				const reason = this.formatMutationReason(mutationReasons.get(path));
				return `- ${path}: ${reason ?? this.describeMutationAction(action)}.`;
			}).join('\n')
			: '- Datei aktualisiert';
		const completedSteps = taskPlan?.steps
			.filter(step => step.status === 'done' && ['write', 'patch', 'delete'].includes(step.type))
			.slice(0, 3)
			.map(step => `- ${step.description}${step.target ? ` (${step.target})` : ''}`)
			.join('\n');
		const reasonSummary = this.buildMutationReasonSummary(paths, mutationReasons, userMessage);
		const summary = reasonSummary
			? `Kurzfassung: ${reasonSummary}`
			: taskPlan?.operation?.trim()
				? `Kurzfassung: ${taskPlan.operation.trim()}`
				: completedSteps ? `Kurzfassung:\n${completedSteps}` : '';
		return [
			'Erledigt. Die Änderung wurde geschrieben.',
			summary,
			`Geändert:\n${changed}`,
		].filter(Boolean).join('\n\n');
	}

	private buildMutationReasonSummary(paths: string[], mutationReasons: Map<string, string>, userMessage: string): string | null {
		const reasons = paths
			.map(path => this.formatMutationReason(mutationReasons.get(path)))
			.filter((reason): reason is string => Boolean(reason));
		if (reasons.length > 0) return Array.from(new Set(reasons)).slice(0, 2).join(' ');
		const fallback = this.formatMutationReason(userMessage);
		return fallback && fallback.length <= 220 ? fallback : null;
	}

	private formatMutationReason(reason: string | undefined): string | null {
		const cleaned = reason
			?.replace(/\s+/g, ' ')
			.replace(/^die\s+/i, '')
			.replace(/^der\s+/i, '')
			.replace(/^das\s+/i, '')
			.replace(/\bsoll\s+/i, '')
			.trim();
		if (!cleaned) return null;
		const normalized = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
		return normalized.endsWith('.') ? normalized.slice(0, -1) : normalized;
	}

	private describeMutationAction(action: string | undefined): string {
		switch (action) {
			case 'created': return 'neu erstellt';
			case 'modified': return 'vollständig überschrieben';
			case 'patched': return 'gezielt bearbeitet';
			case 'trashed': return 'gelöscht';
			default: return 'aktualisiert';
		}
	}

	private async deliverAssistantMessage(
		threadId: string,
		modelId: string,
		provider: ProviderName,
		content: string,
		usedPaths: string[],
		context: ContextItem[],
	) {
		await this.plugin.addMessageToThread(threadId, {
			role: 'assistant',
			content,
			modelId,
			provider,
		});
		this.appendAssistantBubble(content, usedPaths, context);
	}

	private buildFallbackAssistantMessage(
		userMessage: string,
		toolResults: ToolResult[],
		taskPlan: TaskPlan | null,
		reason: string,
	): string {
		const readPaths = getReadPaths(toolResults);
		const readFolderPaths = toolResults
			.filter(result => result.ok && result.tool === 'read_folder')
			.map(result => {
				if (!result.result || typeof result.result !== 'object') return '';
				return ((result.result as { path?: unknown }).path as string | undefined) ?? '';
			})
			.filter(Boolean);
		const searchCount = toolResults.filter(result => result.ok && result.tool === 'search_vault').length;
		const changedPaths = toolResults
			.filter(result => result.ok && ['write_file', 'patch_file', 'delete_file'].includes(result.tool))
			.map(result => ((result.result as { path?: string } | undefined)?.path) ?? '')
			.filter(Boolean);
		const failedTools = toolResults.filter(result => !result.ok);
		const uniqueChanged = changedPaths.filter((path, index, list) => list.indexOf(path) === index);
		const topRead = [
			...Array.from(readPaths).map(path => `- Datei: ${path}`),
			...readFolderPaths.map(path => `- Ordner: ${path}`),
			searchCount > 0 ? `- Vault-Suchen: ${searchCount}` : '',
		].filter(Boolean).slice(0, 8).join('\n');
		const hadSuccessfulDiscovery = Boolean(topRead);
		const nextPlanned = taskPlan?.steps
			?.filter(step => step.status === 'pending')
			.slice(0, 3)
			.map(step => `- ${step.description}${step.target ? ` (${step.target})` : ''}`)
			.join('\n');
		const shortReason = this.summarizeFallbackReason(reason);

		const parts = [
			'Ich gebe dir den aktuellen Arbeitsstand.',
			'',
			shortReason ? `Zwischenstand: ${shortReason}` : '',
			'',
			hadSuccessfulDiscovery
				? `Bereits geprueft:\n${topRead}`
				: 'Es wurden noch keine relevanten Dateien erfolgreich eingelesen.',
			uniqueChanged.length
				? `\nBereits angepasst:\n${uniqueChanged.map(path => `- ${path}`).join('\n')}`
				: '\nBisher wurden noch keine Dateien geaendert.',
			failedTools.length
				? `\nOffene Punkte:\n${failedTools.slice(0, 3).map(result => `- ${result.tool}: ${result.error ?? 'unbekannter Fehler'}`).join('\n')}`
				: '',
			nextPlanned
				? `\nNaechste sinnvolle Schritte:\n${nextPlanned}`
				: '\nNaechster sinnvoller Schritt: Ziel-Dateien enger eingrenzen oder die Aufgabe in kleinere Teilaufgaben aufteilen.',
			`\nAnfrage: ${userMessage}`,
		];

		return parts.filter(Boolean).join('\n');
	}

	private summarizeFallbackReason(reason: string): string {
		const normalized = reason.toLowerCase();
		if (normalized.includes('keinen verwertbaren abschlussschritt')) {
			return 'Die Recherche ist noch nicht in eine belastbare Abschlussantwort oder einen konkreten Schreibschritt umgeschlagen.';
		}
		if (normalized.includes('werkzeugrunden ohne sauberen abschluss')) {
			return 'Es wurden viele Werkzeugschritte ausgefuehrt, ohne dass daraus ein stabiler Abschluss entstanden ist.';
		}
		if (normalized.includes('geblockten lese-runden')) {
			return 'Es wurden wiederholt nur weitere Lese-Schritte vorgeschlagen, ohne klaren Fortschritt zur Bearbeitung oder zum Abschluss.';
		}
		if (normalized.includes('schleife')) {
			return 'Der Ablauf hat sich in wiederholten Zwischenschritten festgefahren.';
		}
		return reason;
	}

	private async maybePersistUserPreference(userMessage: string, toolResults: ToolResult[]) {
		if (this.plugin.settings.agentMode === 'read') return;
		if (!/\b(merke dir|in zukunft immer|bitte kuenftig|bitte künftig|remember this preference|ab jetzt|immer so|nie wieder)\b/i.test(userMessage)) {
			return;
		}
		if (toolResults.some(result => result.ok && result.tool === 'update_user_preferences')) return;

		const normalized = userMessage
			.replace(/^.*?\b(merke dir|in zukunft immer|bitte kuenftig|bitte künftig|remember this preference|ab jetzt)\b[:\s-]*/i, '')
			.trim();
		if (!normalized) return;

		const prefs = await this.toolExecutor.execute({
			id: `pref_read_${Date.now()}`,
			tool: 'read_user_preferences',
			args: { maxChars: 12000 },
			reason: 'Read user preferences before persisting a new explicit instruction.',
		});
		const existingContent =
			prefs.ok && prefs.result && typeof prefs.result === 'object' && typeof (prefs.result as { content?: unknown }).content === 'string'
				? (prefs.result as { content: string }).content
				: '# user_preferences\n\n## Persistente Praeferenzen\n';
		const bullet = `- ${normalized}`;
		if (existingContent.includes(bullet)) return;

		const nextContent = existingContent.trimEnd() + `\n${bullet}\n`;
		const writeResult = await this.toolExecutor.execute({
			id: `pref_write_${Date.now()}`,
			tool: 'update_user_preferences',
			args: { content: nextContent, overwrite: true },
			reason: 'Persist explicit user preference from the current message.',
		});
		if (writeResult.ok) this.appendStatusLine('Praeferenz gespeichert: user_preferences.md');
	}

	private async classifyIntentWithLlm(
		message: string,
		baseRoute: RouterResult,
		intentInput: {
			hasActiveFile?: boolean;
			hasMentionedFiles?: boolean;
			hasSelection?: boolean;
			webSearchEnabled?: boolean;
		},
		provider: ProviderName,
		model: string,
	): Promise<RouterResult> {
		const prompt = buildIntentClassifierPrompt({
			message,
			...intentInput,
			baseMode: baseRoute.mode,
			baseConfidence: baseRoute.confidence,
			baseSignals: baseRoute.signals,
		});
		try {
			const response = await callProvider({
				provider,
				model,
				auth: this.getAuthForProvider(provider),
				message: prompt,
				history: [],
				context: [],
				tool_results: [],
				options: {
					thinking_mode: false,
					web_search: false,
					vault_tools_enabled: false,
					stream: false,
					max_context_chars: 1200,
					max_output_tokens: 180,
					agent_mode: 'read',
					execution_phase: 'normal',
					embedding_backend: this.plugin.settings.embeddingBackend,
					enable_style_critique: false,
				},
			});
			const parsed = parseIntentClassifierResult(response.answer ?? '');
			if (!parsed) {
				return {
					...baseRoute,
					reason: `${baseRoute.reason}; KI-Classifier nicht parsebar`,
					signals: [...(baseRoute.signals ?? []), 'classifier_parse_failed'],
				};
			}
			this.plugin.settings.learnedIntentPatterns = learnIntentPattern(
				this.plugin.settings.learnedIntentPatterns,
				message,
				parsed.mode,
				parsed.confidence,
			);
			await this.plugin.saveSettings();
			const nextRoute = applyClassifierResult(baseRoute, parsed, { message, ...intentInput });
			if (nextRoute === baseRoute) {
				return {
					...baseRoute,
					reason: `${baseRoute.reason}; KI-Classifier blieb bei Sicherheitsfallback`,
					signals: [...(baseRoute.signals ?? []), 'classifier_rejected'],
				};
			}
			return nextRoute;
		} catch {
			return {
				...baseRoute,
				reason: `${baseRoute.reason}; KI-Classifier fehlgeschlagen`,
				signals: [...(baseRoute.signals ?? []), 'classifier_error'],
			};
		}
	}

	// Sends a request and automatically retries once. Rate limits keep the same
	// payload; only real context errors trigger context compaction.
	private async callWithFallback(
		payload: import('../agent/types').ChatRequestPayload,
		rawContext: import('../agent/types').ContextItem[],
		maxContextChars: number,
		provider: string,
		model: string,
		budgetOptions?: import('../limits/tokenBudget').CompactBudgetOptions,
	): Promise<import('../agent/types').ChatResponsePayload> {
		try {
			return await callProvider(payload);
		} catch (err) {
			if (!(err instanceof ProviderError)) throw err;

			const is429     = err.status === 429;
			const isCtxErr  = err.status === 400 && /context|token|length/i.test(err.message);
			if (!is429 && !isCtxErr) throw err;

			const info = rateLimitManager.updateFromError(provider, model, err.message);

			if (is429) {
				const waitSeconds = Math.max(0, info.retryAfterSeconds);
				if (waitSeconds > 0) {
					this.appendStatusLine(`Rate Limit — warte ${waitSeconds}s und versuche erneut…`);
					await new Promise(r => setTimeout(r, waitSeconds * 1000));
				} else {
					this.appendStatusLine('Rate Limit — versuche erneut ohne Kontextreduktion…');
				}
				return await callProvider(payload);
			}

			this.appendStatusLine('Kontext zu groß — reduziere automatisch…');
			const halvedChars = Math.max(8_000, Math.floor(maxContextChars / 2));
			const smallerContext = compactContextForBudget(rawContext, halvedChars, budgetOptions);
			const retryPayload: ChatRequestPayload = {
				...payload,
				history: payload.history.slice(-4),
				context: smallerContext,
				tool_results: compactToolResults(payload.tool_results).slice(-2),
				options: {
					...payload.options,
					web_search: false,
					max_context_chars: halvedChars,
					max_output_tokens: Math.min(payload.options.max_output_tokens ?? 1200, 800),
				},
			};
			return await callProvider(retryPayload);
		}
	}

	private setLoading(v: boolean) {
		this.isLoading = v;
		this.sendBtn.disabled = v;
		this.sendBtn.textContent = v ? '…' : '↑';
		if (!v) this.finishStatusDisplay();
	}

	private modeInputPlaceholder(mode: UIMode): string {
		const map: Record<UIMode, string> = {
			ask:   'Frage oder Aufgabe beschreiben…',
			edit:  'Was soll geändert werden? (Enter = Senden)',
			agent: 'Aufgabe beschreiben… (Enter = Senden)',
			plan:  'Was soll geplant werden? (Enter = Senden)',
		};
		return map[mode];
	}

	private buildAllowedToolNamesForRequest(mode: UIMode, userMessage: string, thread: ChatThread): string[] | undefined {
		if (mode !== 'edit') return undefined;
		const broadDiscovery = hasExplicitBroadDiscoveryIntent(userMessage);
		const selectedFolder = Boolean(thread.folderPath && getEffectiveModes(thread).includes('folder'));
		const names = new Set([
			'read_active_file',
			'read_file',
			'patch_file',
			'write_file',
			'ask_user',
			'read_user_preferences',
			'update_user_preferences',
			'create_agent_md',
		]);
		if (broadDiscovery) {
			names.add('search_vault');
			names.add('list_files');
			names.add('expand_chunk');
		}
		if (broadDiscovery || selectedFolder) {
			names.add('read_folder');
		}
		return Array.from(names);
	}

	private validateReadToolScope(
		call: { tool: string; args: Record<string, unknown> },
		thread: ChatThread,
		userMessage: string,
		mode: UIMode,
	): string | null {
		if (call.tool !== 'read_folder') return null;
		const path = typeof call.args['path'] === 'string' ? call.args['path'] : '';
		const selectedFolder = getEffectiveModes(thread).includes('folder') ? thread.folderPath : undefined;
		return validateReadFolderScope({ path, folderPath: selectedFolder, userMessage, mode });
	}

	private validateEditToolCall(
		call: { tool: string; args: Record<string, unknown> },
		plan: EditPlan,
		toolResults: ToolResult[],
	): string | null {
		if (!['patch_file', 'write_file', 'delete_file'].includes(call.tool)) {
			return null;
		}

		const targetPath = typeof call.args['path'] === 'string' ? call.args['path'] : '';
		if (!targetPath) {
			return 'Write tool without target path.';
		}

		if (!plan.target_files.includes(targetPath)) {
			return `Target path ${targetPath} is not part of the approved plan (${plan.target_files.join(', ')}).`;
		}

		if (call.tool === 'delete_file' && plan.operation.toLowerCase().includes('delete') === false && plan.operation.toLowerCase().includes('loesch') === false) {
			return `delete_file does not match planned operation "${plan.operation}".`;
		}

		if (call.tool !== plan.preferred_tool) {
			const allowWriteFallback =
				plan.preferred_tool === 'patch_file' &&
				call.tool === 'write_file' &&
				this.canFallbackFromPatchToWrite(plan, targetPath, toolResults);
			if (!allowWriteFallback) {
				return `${call.tool} does not match preferred_tool=${plan.preferred_tool}.`;
			}
		}

		if (plan.safety === 'high' && call.tool === 'patch_file') {
			if (!hasFreshReadForPath(toolResults, targetPath)) {
				return `High-safety plan requires a fresh read_file/read_active_file for ${targetPath} before patch_file.`;
			}
		}

		if (plan.safety === 'high' && call.tool === 'write_file') {
			if (call.args['overwrite'] !== true) {
				return `High-safety plan requires write_file with overwrite=true for ${targetPath}.`;
			}
		}

		return null;
	}

	private validateWriteSafety(
		call: { tool: string; args: Record<string, unknown> },
		toolResults: ToolResult[],
		userMessage: string,
	): string | null {
		if (call.tool !== 'write_file') return null;
		if (call.args['overwrite'] !== true) return null;

		const targetPath = typeof call.args['path'] === 'string' ? call.args['path'] : '';
		const nextContent = typeof call.args['content'] === 'string' ? call.args['content'] : '';
		if (!targetPath || !nextContent) return null;

		const existing = this.app.vault.getAbstractFileByPath(targetPath);
		if (!(existing instanceof TFile)) return null;

		return validateOverwriteContentSafety({
			path: targetPath,
			nextContent,
			previousContent: getLatestReadContentForPath(toolResults, targetPath),
			userMessage,
		});
	}

	private canFallbackFromPatchToWrite(plan: EditPlan, targetPath: string, toolResults: ToolResult[]): boolean {
		const operation = plan.operation.toLowerCase();
		const broadRewrite = /\b(komplett|vollstaendig|vollständig|rewrite|neu schreiben|umschreiben|restructure|restrukturieren|neuaufbau|neufassung|dateiweit|überall|ueberall)\b/u.test(operation);
		const patchAlreadyFailed = toolResults.some(result =>
			result.tool === 'patch_file' &&
			!result.ok &&
			typeof result.error === 'string' &&
			(
				result.error.includes('oldText not found') ||
				result.error.includes('Suchtext nicht gefunden') ||
				result.error.includes('ambiguous match')
			),
		);
		const hasFreshRead = hasFreshReadForPath(toolResults, targetPath);
		return hasFreshRead && (broadRewrite || patchAlreadyFailed || plan.safety === 'high');
	}

	private validateEditPlanAgainstContext(
		plan: EditPlan,
		context: ContextItem[],
		toolResults: ToolResult[],
		userMessage: string,
	): string | null {
		const newFileTargets = new Set<string>();
		for (const path of plan.target_files) {
			const abstractFile = this.app.vault.getAbstractFileByPath(path);
			if (!(abstractFile instanceof TFile)) {
				const canCreateNewFile =
					plan.preferred_tool === 'write_file' &&
					isLikelyNewFileCreationIntent(userMessage, plan.operation);
				if (canCreateNewFile) {
					newFileTargets.add(path);
					continue;
				}
				return `Planned target file does not exist: ${path}.`;
			}
		}

		const focusedPaths = new Set(
			context
				.filter(item =>
					item.type === 'active_file' ||
					item.type === 'manual_file' ||
					item.type === 'input_reference',
				)
				.map(item => item.path)
				.filter((path): path is string => Boolean(path)),
		);
		const referencedPaths = new Set(this.contextResolver.getReferencedFilePaths(userMessage));
		const readPaths = getReadPaths(toolResults);

		for (const path of plan.target_files) {
			if (newFileTargets.has(path)) continue;
			if (!focusedPaths.has(path) && !referencedPaths.has(path) && !readPaths.has(path)) {
				return `Planned target file ${path} is not active, manually selected, explicitly referenced, or freshly read in the planning phase.`;
			}
		}

		if (plan.preferred_tool === 'patch_file') {
			const patchPlausibilityError = this.validatePatchPlanPlausibility(plan, context, toolResults);
			if (patchPlausibilityError) return patchPlausibilityError;
		}

		return null;
	}

	private validateTaskPlanAgainstContext(
		plan: TaskPlan,
		context: ContextItem[],
		toolResults: ToolResult[],
		userMessage: string,
	): string | null {
		if (!plan.goal.trim()) {
			return 'Task plan requires a non-empty goal.';
		}
		if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
			return 'Task plan requires at least one step.';
		}
		const editPlan = this.buildEditPlanFromTaskPlan(plan);
		if (editPlan) {
			return this.validateEditPlanAgainstContext(editPlan, context, toolResults, userMessage);
		}
		return null;
	}

	private buildPlanRepairHint(planError: string, context: ContextItem[], toolResults: ToolResult[]): string {
		const focusedPaths = context
			.filter(item => item.path && ['active_file', 'manual_file', 'input_reference'].includes(item.type))
			.map(item => item.path!)
			.filter((path, index, list) => list.indexOf(path) === index);
		const readFiles = Array.from(getReadPaths(toolResults));
		const readFolders = toolResults
			.filter(result => result.ok && result.tool === 'read_folder')
			.map(result => {
				const value = result.result && typeof result.result === 'object'
					? ((result.result as { path?: unknown }).path as string | undefined)
					: undefined;
				return value ?? '';
			})
			.filter(Boolean);
		const knownTargets = [...focusedPaths, ...readFiles].filter((path, index, list) => list.indexOf(path) === index);
		const parts = [
			planError,
			'Repair the plan instead of repeating it.',
			knownTargets.length ? `Use one of these known file targets unless the user explicitly asked to create a new file: ${knownTargets.slice(0, 8).join(', ')}.` : '',
			readFolders.length ? `Already inspected folders: ${readFolders.slice(0, 4).join(', ')}.` : '',
			'If the intended target does not exist, ask the user or choose an existing active/read file. Do not invent README paths.',
		];
		return parts.filter(Boolean).join(' ');
	}

	private buildEditPlanFromTaskPlan(plan: TaskPlan | null): EditPlan | null {
		if (!plan?.target_files?.length || !plan.preferred_tool || !plan.operation || !plan.safety) {
			return null;
		}
		return {
			target_files: plan.target_files,
			operation: plan.operation,
			preferred_tool: plan.preferred_tool,
			safety: plan.safety,
			reasoning: plan.reasoning,
			risk_notes: plan.risk_notes,
			complexity: plan.complexity,
			steps: plan.steps,
		};
	}

	private buildTaskPlanFromLegacyEditPlan(plan: EditPlan | null): TaskPlan | null {
		if (!plan) return null;
		return {
			goal: plan.operation,
			complexity: plan.complexity ?? 'compound',
			steps: plan.steps ?? [],
			target_files: plan.target_files,
			operation: plan.operation,
			preferred_tool: plan.preferred_tool,
			safety: plan.safety,
			reasoning: plan.reasoning,
			risk_notes: plan.risk_notes,
		};
	}

	private formatPlanForDisplay(plan: TaskPlan): string {
		const lines: string[] = [
			`## Plan: ${plan.goal}`,
			'',
			`**Komplexität:** ${plan.complexity}`,
		];
		if (plan.operation) lines.push(`**Operation:** ${plan.operation}`);
		if (plan.target_files?.length) lines.push(`**Zieldateien:** ${plan.target_files.map(f => `\`${f}\``).join(', ')}`);
		if (plan.safety) lines.push(`**Risiko:** ${plan.safety}`);
		lines.push('', '### Schritte', '');
		plan.steps.forEach((s, i) => {
			lines.push(`${i + 1}. **${s.type}**: ${s.description}${s.target ? ` → \`${s.target}\`` : ''}`);
		});
		lines.push('', '_Sag „ja, umsetzen“ oder „mach das“, um diesen Plan auszuführen. Für Änderungen schreibe z.B. „ändere Schritt 2 …“._');
		return lines.join('\n');
	}

	private formatUnstructuredPlanForDisplay(answer: string): string {
		const trimmed = answer.trim();
		const body = /^#{1,3}\s+/m.test(trimmed)
			? trimmed
			: `## Plan\n\n${trimmed}`;
		return `${body}\n\n_Dieser Plan ist nur als Text angekommen. Sag „mach daraus einen ausführbaren Plan“, wenn ich ihn als gespeicherten Plan vorbereiten soll._`;
	}

	private summarizeTaskPlan(plan: TaskPlan): string {
		return [
			`goal=${plan.goal}`,
			`complexity=${plan.complexity}`,
			plan.target_files?.length ? `files=${plan.target_files.join(', ')}` : '',
			plan.preferred_tool ? `tool=${plan.preferred_tool}` : '',
			plan.safety ? `risk=${plan.safety}` : '',
			plan.operation ? `op=${plan.operation}` : '',
			plan.steps.length ? `steps=${plan.steps.length}` : '',
		].filter(Boolean).join(' | ');
	}

	private validatePatchPlanPlausibility(
		plan: EditPlan,
		context: ContextItem[],
		toolResults: ToolResult[],
	): string | null {
		if (plan.target_files.length !== 1) {
			return 'preferred_tool=patch_file is only plausible for a single target file.';
		}

		const targetPath = plan.target_files[0] ?? '';
		const abstractFile = this.app.vault.getAbstractFileByPath(targetPath);
		const fileSize = typeof (abstractFile as { stat?: { size?: number } } | null)?.stat?.size === 'number'
			? (abstractFile as unknown as { stat: { size: number } }).stat.size
			: 0;
		const normalizedOperation = plan.operation.toLowerCase();
		const riskyRewrite = /\b(komplett|vollstaendig|vollständig|rewrite|neu schreiben|umschreiben|restructure|restrukturieren|neuaufbau)\b/u.test(normalizedOperation);
		const hasInlineContent = context.some(item => item.path === targetPath && typeof item.content === 'string' && item.content.length > 0);
		const hasFreshRead = hasFreshReadForPath(toolResults, targetPath);

		if (!hasInlineContent && !hasFreshRead) {
			return `preferred_tool=patch_file is not plausible for ${targetPath} without inline content or a fresh read_file result.`;
		}
		if (fileSize > 40_000) {
			return `preferred_tool=patch_file is not plausible for ${targetPath} because the file is large (${fileSize} chars/bytes-scale). Prefer write_file(overwrite=true).`;
		}
		if (plan.safety === 'high' && fileSize > 12_000) {
			return `preferred_tool=patch_file is too risky for high-safety editing of ${targetPath}. Prefer write_file(overwrite=true) or re-read and reduce scope.`;
		}
		if (riskyRewrite) {
			return `preferred_tool=patch_file is not plausible because the planned operation looks like a broad rewrite (${plan.operation}). Prefer write_file(overwrite=true).`;
		}

		return null;
	}


	private getAuthForProvider(provider: ProviderName) {
		const s = this.plugin.settings;
		switch (provider) {
			case 'openai':    return { api_key: this.plugin.getProviderApiKey('openai') || null };
			case 'anthropic': return { api_key: this.plugin.getProviderApiKey('anthropic') || null };
			case 'gemini':    return { api_key: this.plugin.getProviderApiKey('gemini') || null };
			case 'ollama':    return { base_url: s.ollamaBaseUrl || null };
		}
	}

	// ── Message rendering ──────────────────────────────────────

	private appendUserBubble(text: string): HTMLElement {
		const wrapper = this.messagesEl.createDiv('ai-message-user-row');
		wrapper.createDiv({ cls: 'ai-message ai-message-user', text });
		this.scrollToBottom();
		return wrapper;
	}

	private appendContextToUserBubble(_wrapper: HTMLElement, contextItems: ContextItem[], debug?: ContextDebugSnapshot) {
		if (!contextItems.length) return;
		this.ensureStatusContainer();
		if (!this.statusHeaderEl) return;
		const infoBtn = this.statusHeaderEl.createEl('button', { cls: 'ai-status-ctx-btn', text: 'i', attr: { title: 'Kontext dieser Anfrage' } });
		infoBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.togglePopover(infoBtn, p => {
				p.addClass('ai-user-ctx-popover');
				p.createEl('p', { text: 'Kontext dieser Anfrage', cls: 'ai-agent-popover-title' });
				if (debug) this.renderContextDebugInspector(p, debug);
				for (const item of contextItems) {
					const row = p.createDiv('ai-ctx-item');
					const primaryPath = item.path ?? item.files?.[0]?.path ?? '';
					const displayName = primaryPath
						? (primaryPath.split('/').pop()?.replace(/\.md$/, '') ?? primaryPath)
						: item.label;
					const hdr = row.createDiv('ai-ctx-item-header');
					hdr.createSpan({ cls: 'ai-ctx-type-badge', text: item.type.replace(/_/g, ' ') });
					hdr.createSpan({ cls: 'ai-ctx-label', text: displayName, attr: { title: primaryPath || item.label } });
					if (item.summary) row.createDiv({ cls: 'ai-ctx-summary', text: item.summary });
					if (item.reasons?.length) {
						const reasonsRow = row.createDiv('ai-ctx-reasons');
						for (const reason of item.reasons) {
							reasonsRow.createSpan({ cls: 'ai-ctx-reason-chip', text: reason });
						}
					}
					if (item.files?.length) {
						const filesRow = row.createDiv('ai-ctx-files');
						for (const file of item.files.slice(0, 4)) {
							const name = file.path.split('/').pop()?.replace(/\.md$/, '') ?? file.path;
							filesRow.createDiv({ cls: 'ai-ctx-file-name', text: file.heading ? `${name} § ${file.heading}` : name });
						}
						if (item.files.length > 4) filesRow.createDiv({ cls: 'ai-ctx-file-more', text: `+${item.files.length - 4} weitere` });
					}
				}
			});
		});
	}

	private renderContextDebugInspector(container: HTMLElement, debug: ContextDebugSnapshot) {
		const summary = container.createDiv('ai-ctx-debug-summary');
		const summaryItems = [
			`Modus: ${debug.mode.toUpperCase()} (${debug.intentConfidence})`,
			`Kontext: ${debug.contextModes.join(' + ')}`,
			`Items: ${debug.summary.finalItems}/${debug.summary.rawItems}`,
			`Chars: ${debug.summary.finalChars}/${debug.summary.rawChars}`,
			`Budget: ${debug.maxContextChars}`,
			`~${Math.round(debug.estimatedTokens / 100) / 10}k Tokens`,
		];
		for (const item of summaryItems) summary.createSpan({ text: item });
		summary.createDiv({ cls: 'ai-ctx-debug-reason', text: debug.modeReason });
		if (debug.intentSignals.length) {
			const signals = summary.createDiv('ai-ctx-debug-signals');
			for (const signal of debug.intentSignals.slice(0, 8)) {
				signals.createSpan({ text: signal });
			}
		}

		const list = container.createDiv('ai-ctx-debug-list');
		for (const item of debug.items) {
			const row = list.createDiv(`ai-ctx-debug-item ${item.included ? 'is-included' : 'is-dropped'}`);
			const head = row.createDiv('ai-ctx-debug-head');
			head.createSpan({ cls: 'ai-ctx-debug-mode', text: item.mode });
			head.createSpan({
				cls: 'ai-ctx-debug-name',
				text: item.path ?? item.label,
				attr: { title: item.path ?? item.label },
			});
			head.createSpan({ cls: 'ai-ctx-debug-size', text: `${item.rawChars} -> ${item.finalChars}` });
			row.createDiv({ cls: 'ai-ctx-debug-detail', text: item.reason });
			const chips = row.createDiv('ai-ctx-debug-chips');
			chips.createSpan({ text: item.type.replace(/_/g, ' ') });
			if (item.files) chips.createSpan({ text: `${item.files} files` });
			for (const reason of item.reasons.slice(0, 5)) chips.createSpan({ text: reason });
			for (const [key, value] of Object.entries(item.stats)) {
				if (value === undefined) continue;
				if (!/confidence|score|gate|short_reference|retrieval/i.test(key)) continue;
				chips.createSpan({ text: `${key}: ${String(value)}` });
			}
		}
	}

	private ensureStatusContainer() {
		if (this.statusBodyEl) return;
		const container = this.messagesEl.createDiv('ai-status-container');
		const header = container.createDiv('ai-status-header');
		const toggle = header.createSpan({ cls: 'ai-status-toggle', text: '▾' });
		const labelEl = header.createSpan({ cls: 'ai-status-label', text: 'Thinking' });
		const dotsEl = header.createSpan({ cls: 'ai-thinking-dots', text: '.' });
		let dots = 1;
		if (this.thinkingDotsInterval) clearInterval(this.thinkingDotsInterval);
		this.thinkingDotsInterval = setInterval(() => {
			dots = dots >= 3 ? 1 : dots + 1;
			dotsEl.textContent = '.'.repeat(dots);
		}, 400);
		header.createDiv('ai-status-header-spacer');
		const body = container.createDiv('ai-status-body');
		header.addEventListener('click', (e) => {
			if ((e.target as HTMLElement).closest('.ai-status-ctx-btn')) return;
			const collapsed = body.hasClass('is-collapsed');
			body.toggleClass('is-collapsed', !collapsed);
			toggle.textContent = collapsed ? '▾' : '▸';
		});
		this.statusHeaderEl = header;
		this.statusLabelEl = labelEl;
		this.thinkingDotsEl = dotsEl;
		this.statusBodyEl = body;
		this.scrollToBottom();
	}

	private finishStatusDisplay() {
		if (this.thinkingDotsInterval) {
			clearInterval(this.thinkingDotsInterval);
			this.thinkingDotsInterval = null;
		}
		if (this.statusLabelEl) this.statusLabelEl.textContent = 'Abgeschlossen';
		if (this.thinkingDotsEl) this.thinkingDotsEl.textContent = '';
	}

	private appendStatusLine(text: string) {
		this.ensureStatusContainer();
		this.statusBodyEl!.createDiv({ cls: 'ai-message-status', text });
		this.scrollToBottom();
	}

	private appendProviderStatus(text: string, round: number) {
		const key = `${round}:${text}`;
		if (this.emittedStatusKeys.has(key)) return;
		this.emittedStatusKeys.add(key);

		switch (text) {
			case 'Planning next moves':
				this.appendStatusLine(`Modellrunde ${round}: plane naechsten Schritt`);
				return;
			case 'Packing Obsidian context':
				this.appendStatusLine(`Modellrunde ${round}: bereite Obsidian-Kontext vor`);
				return;
			case 'Websearch enabled':
				if (!this.emittedStatusKeys.has('feature:websearch')) {
					this.emittedStatusKeys.add('feature:websearch');
					this.appendStatusLine('Option: Websuche aktiv');
				}
				return;
			case 'Reasoning enabled':
				if (!this.emittedStatusKeys.has('feature:reasoning')) {
					this.emittedStatusKeys.add('feature:reasoning');
					this.appendStatusLine('Option: Reasoning aktiv');
				}
				return;
			case 'Vault tools enabled':
				if (!this.emittedStatusKeys.has('feature:vault_tools')) {
					this.emittedStatusKeys.add('feature:vault_tools');
					this.appendStatusLine('Option: Vault-Tools aktiv');
				}
				return;
			default:
				if (text.startsWith('Calling ')) {
					this.appendStatusLine(`Modellrunde ${round}: ${text}`);
					return;
				}
				this.appendStatusLine(text);
		}
	}

	private appendToolResultStatus(tool: string, result: ToolResult) {
		if (!result.ok) return;
		const data = result.result;
		if (!data || typeof data !== 'object') {
			this.appendStatusLine(`Tool fertig: ${tool}`);
			return;
		}

		const path = typeof (data as { path?: unknown }).path === 'string' ? (data as { path: string }).path : '';
		switch (tool) {
			case 'read_file':
			case 'read_active_file': {
				const content = typeof (data as { content?: unknown }).content === 'string' ? (data as { content: string }).content : '';
				this.appendStatusLine(`Gelesen: ${path || 'Datei'}${content ? ` (${content.length} Zeichen)` : ''}`);
				return;
			}
			case 'read_folder': {
				const files = Array.isArray((data as { files?: unknown[] }).files) ? (data as { files: unknown[] }).files : [];
				this.appendStatusLine(`Ordner gelesen: ${path || 'Ordner'} (${files.length} Dateien)`);
				return;
			}
			case 'search_vault': {
				const results = Array.isArray(data)
					? data
					: (Array.isArray((data as { results?: unknown[] }).results) ? (data as { results: unknown[] }).results : []);
				this.appendStatusLine(`Vault-Suche: ${results.length} Treffer`);
				return;
			}
			case 'expand_chunk': {
				const chunkPath = path || (typeof (data as { name?: unknown }).name === 'string' ? (data as { name: string }).name : 'Chunk');
				this.appendStatusLine(`Chunk erweitert: ${chunkPath}`);
				return;
			}
			case 'patch_file':
			case 'write_file':
			case 'delete_file': {
				const action = typeof (data as { action?: unknown }).action === 'string' ? (data as { action: string }).action : tool;
				this.appendStatusLine(`Aenderung: ${action}${path ? ` -> ${path}` : ''}`);
				return;
			}
			case 'query_dataview': {
				const count = typeof (data as { count?: unknown }).count === 'number' ? (data as { count: number }).count : undefined;
				this.appendStatusLine(`Dataview: ${count !== undefined ? `${count} Ergebnisse` : 'Abfrage abgeschlossen'}`);
				return;
			}
			default:
				this.appendStatusLine(`Tool fertig: ${tool}${path ? ` -> ${path}` : ''}`);
		}
	}

	private appendStepList(steps: TypedStep[]) {
		const container = this.messagesEl.createDiv('ai-step-list');
		for (const step of steps) {
			const row = container.createDiv({ cls: 'ai-step-item', attr: { 'data-step-id': step.id } });
			row.createSpan({ cls: 'ai-step-icon', text: '⬜' });
			row.createSpan({ cls: 'ai-step-description', text: step.description });
			if (step.target) row.createSpan({ cls: 'ai-step-target', text: ` → ${step.target.split('/').pop() ?? step.target}` });
		}
		this.scrollToBottom();
	}

	private updateStepStatus(steps: TypedStep[], stepId: string, status: 'done' | 'failed') {
		const stepIndex = steps.findIndex(s => s.id === stepId);
		if (stepIndex < 0) return;
		const step = steps[stepIndex];
		if (!step) return;
		step.status = status;
		const row = this.messagesEl.querySelector(`.ai-step-item[data-step-id="${stepId}"]`);
		if (!row) return;
		const icon = row.querySelector('.ai-step-icon');
		if (icon) icon.textContent = status === 'done' ? '✅' : '❌';
		if (status === 'done') row.classList.add('is-done');
		else row.classList.add('is-failed');
	}

	private classifyTaskComplexity(message: string): TaskComplexity {
		const text = message.toLowerCase();
		if (/\b(und dann|danach|anschließend|anschliessend|für jede|für alle|alle dateien|mehrere dateien|schritt für schritt|step by step|sequentiell)\b/u.test(text)) return 'complex';
		if (/\b(außerdem|zusätzlich|ebenfalls|sowie)\b/u.test(text) && /\b(erstelle|schreibe|ändere|aendere|lösche|loesche|patch)\b/u.test(text)) return 'compound';
		return 'simple';
	}

	private appendAssistantBubble(markdown: string, _sources: string[] = [], _sourceContext: ContextItem[] = []) {
		if (this.thinkingDotsInterval) { clearInterval(this.thinkingDotsInterval); this.thinkingDotsInterval = null; }
		this.statusBodyEl = null;
		this.statusHeaderEl = null;
		this.statusLabelEl = null;
		this.thinkingDotsEl = null;
		const wrapper = this.messagesEl.createDiv('ai-message-wrapper');
		const el = wrapper.createDiv('ai-message ai-message-assistant');
		void MarkdownRenderer.render(this.app, markdown, el, '', this);
		this.scrollToBottom();
	}

	private scrollToBottom() { this.messagesEl.scrollTop = this.messagesEl.scrollHeight; }

	private relativeTime(ts: number): string {
		const d = Date.now() - ts;
		const m = Math.floor(d / 60_000);
		if (m < 1) return 'gerade eben';
		if (m < 60) return `${m}m`;
		const h = Math.floor(d / 3_600_000);
		if (h < 24) return `${h}h`;
		const days = Math.floor(d / 86_400_000);
		return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`;
	}

	async onClose() {
		this.closePopover();
	}
}
