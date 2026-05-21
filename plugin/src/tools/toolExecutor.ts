/* eslint-disable obsidianmd/ui/sentence-case */

import { App, Modal, Notice } from 'obsidian';
import { ObsidianVaultTools } from './obsidianVaultTools';
import type { ToolCall, ToolResult } from '../agent/types';
import { DEFAULT_AGENT_MD, AGENT_MD_PATH } from './agentMd';
import type ObsidianAiAgentPlugin from '../main';
import type { VaultSearchFilters } from '../retrieval/types';
import type { LlmCallFn } from '../retrieval/reranker';

// ── Ask-user modal ────────────────────────────────────────────────

class AskUserModal extends Modal {
	private resolved = false;
	private resolve!: (answer: string | null) => void;

	constructor(
		app: App,
		private question: string,
		private options: string[],
	) {
		super(app);
	}

	openAndWait(): Promise<string | null> {
		return new Promise(res => {
			this.resolve = res;
			this.open();
		});
	}

	onOpen() {
		this.titleEl.setText('Agent braucht eine Klärung');
		const { contentEl } = this;

		contentEl.createEl('p', { cls: 'ai-ask-user-question', text: this.question });

		if (this.options.length > 0) {
			const optionsEl = contentEl.createDiv('ai-ask-user-options');
			for (const opt of this.options) {
				const btn = optionsEl.createEl('button', { text: opt, cls: 'ai-ask-user-option-btn' });
				btn.addEventListener('click', () => { this.resolved = true; this.resolve(opt); this.close(); });
			}
			contentEl.createEl('p', { cls: 'ai-ask-user-or', text: '— oder freie Antwort —' });
		}

		const input = contentEl.createEl('textarea', {
			cls: 'ai-ask-user-input',
			attr: { placeholder: 'Deine Antwort…', rows: '3' },
		});

		const footer = contentEl.createDiv('ai-ask-user-footer');
		const submitBtn = footer.createEl('button', { text: 'Antworten', cls: 'mod-cta' });
		submitBtn.addEventListener('click', () => {
			const answer = input.value.trim();
			if (!answer) return;
			this.resolved = true;
			this.resolve(answer);
			this.close();
		});
		input.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitBtn.click(); }
		});

		setTimeout(() => input.focus(), 10);
	}

	onClose() {
		this.contentEl.empty();
		if (!this.resolved) this.resolve(null);
	}
}

// ── Confirmation modal ────────────────────────────────────────────

type ConfirmKind = 'write' | 'patch' | 'delete';

class ConfirmModal extends Modal {
	private resolved = false;
	private resolve!: (confirmed: boolean) => void;

	constructor(
		app: App,
		private kind: ConfirmKind,
		private filePath: string,
		private snippet: string,
	) {
		super(app);
	}

	openAndWait(): Promise<boolean> {
		return new Promise(res => {
			this.resolve = res;
			this.open();
		});
	}

	onOpen() {
		const titles: Record<ConfirmKind, string> = {
			write:  'Datei schreiben',
			patch:  'Datei bearbeiten',
			delete: 'Datei löschen',
		};
		this.titleEl.setText(titles[this.kind]);
		const { contentEl } = this;

		const pathEl = contentEl.createDiv('ai-confirm-path');
		pathEl.createSpan({ cls: 'ai-confirm-path-icon', text: this.kind === 'delete' ? '🗑' : '📝' });
		pathEl.createSpan({ cls: 'ai-confirm-path-text', text: this.filePath });

		if (this.snippet) {
			contentEl.createDiv({ cls: 'ai-confirm-snippet-label', text: 'Vorschau' });
			contentEl.createEl('pre', { cls: 'ai-confirm-snippet', text: this.snippet });
		}

		const footer = contentEl.createDiv('ai-confirm-footer');
		const allowBtn = footer.createEl('button', {
			cls: 'mod-cta',
			text: this.kind === 'delete' ? 'Löschen' : 'Erlauben',
		});
		const denyBtn = footer.createEl('button', { text: 'Ablehnen' });

		allowBtn.addEventListener('click', () => { this.resolved = true; this.resolve(true);  this.close(); });
		denyBtn.addEventListener('click',  () => { this.resolved = true; this.resolve(false); this.close(); });
	}

	onClose() {
		this.contentEl.empty();
		if (!this.resolved) this.resolve(false);
	}
}

function snip(text: string, max: number): string {
	if (!text) return '';
	return text.length > max ? text.slice(0, max) + '…' : text;
}

function buildSnippet(kind: ConfirmKind, args: Record<string, unknown>): string {
	if (kind === 'write') {
		return snip((args['content'] as string | undefined) ?? '', 320);
	}
	if (kind === 'patch') {
		const old_ = snip((args['oldText'] as string | undefined) ?? '', 140);
		const new_ = snip((args['newText'] as string | undefined) ?? '', 140);
		return `− ${old_}\n\n+ ${new_}`;
	}
	return '';
}

// ── Executor ──────────────────────────────────────────────────────

export class ToolExecutor {
	private tools: ObsidianVaultTools;
	private app: App;
	private plugin: ObsidianAiAgentPlugin;
	private llmRerankFn: LlmCallFn | null = null;

	constructor(app: App, plugin: ObsidianAiAgentPlugin) {
		this.app = app;
		this.plugin = plugin;
		this.tools = new ObsidianVaultTools(app);
	}

	setLlmRerankFn(fn: LlmCallFn | null) {
		this.llmRerankFn = fn;
	}

	async execute(call: ToolCall): Promise<ToolResult> {
		try {
			const args = call.args;

			switch (call.tool) {
				case 'list_files':
					return this.ok(call, this.tools.listFiles());

				case 'read_file':
					return this.ok(call, await this.tools.readFile(
						args['path'] as string,
						(args['maxChars'] as number | undefined) ?? 60000,
					));

				case 'read_active_file':
					return this.ok(call, await this.tools.readActiveFile(
						(args['maxChars'] as number | undefined) ?? 60000,
					));

				case 'search_vault':
					return this.ok(call, await this.tools.searchVault(
						args['query'] as string,
						(args['limit'] as number | undefined) ?? 20,
						args['filters'] as VaultSearchFilters | undefined,
						this.llmRerankFn,
					));

				case 'read_folder':
					return this.ok(call, await this.tools.readFolder(
						args['path'] as string,
						(args['maxFiles'] as number | undefined) ?? 30,
						(args['maxCharsPerFile'] as number | undefined) ?? 12000,
					));

				case 'expand_chunk':
					return this.ok(call, await this.tools.expandChunk(
						args['chunk_id'] as string,
						(args['maxChars'] as number | undefined) ?? 12000,
					));

				case 'write_file':
					this.ensureCanWrite();
					await this.confirmIfNeeded('write', args, 'User rejected write_file.');
					return this.ok(call, await this.tools.writeFile(
						args['path'] as string,
						args['content'] as string,
						(args['overwrite'] as boolean | undefined) ?? false,
					));

				case 'patch_file':
					this.ensureCanWrite();
					await this.confirmIfNeeded('patch', args, 'User rejected patch_file.');
					return this.ok(call, await this.tools.patchFile(
						args['path'] as string,
						args['oldText'] as string,
						args['newText'] as string,
					));

				case 'delete_file':
					this.ensureCanDelete();
					await this.confirmIfNeeded('delete', args, 'User rejected delete_file.');
					return this.ok(call, await this.tools.deleteFile(args['path'] as string));

				case 'query_dataview':
					return this.ok(call, await this.tools.queryDataview(args['dql'] as string));

				case 'read_user_preferences':
					return this.ok(call, await this.tools.readUserPreferences(
						(args['maxChars'] as number | undefined) ?? 12000,
					));

				case 'update_user_preferences':
					this.ensureCanWrite();
					await this.confirmIfNeeded('write', { ...args, path: 'user_preferences.md' }, 'User rejected update_user_preferences.');
					return this.ok(call, await this.tools.updateUserPreferences(
						args['content'] as string,
						(args['overwrite'] as boolean | undefined) ?? true,
					));

				case 'ask_user': {
					const question = typeof args['question'] === 'string' ? args['question'] : 'Wie soll ich vorgehen?';
					const rawOptions = args['options'];
					const options = Array.isArray(rawOptions) ? rawOptions.map(String) : [];
					const answer = await new AskUserModal(this.app, question, options).openAndWait();
					if (answer === null) {
						return {
							id: call.id,
							tool: call.tool,
							ok: false,
							error: 'ask_user abgebrochen oder geschlossen.',
							result: { question, cancelled: true },
						};
					}
					return this.ok(call, { question, answer });
				}

				case 'save_memory':
					this.ensureCanWrite();
					return this.ok(call, await this.tools.saveAgentMemory(
						args['content'] as string,
						args['label'] as string | undefined,
					));

				case 'recall_memory':
					return this.ok(call, await this.tools.recallAgentMemory(
						(args['maxChars'] as number | undefined) ?? 12000,
						typeof args['query'] === 'string' ? args['query'] : undefined,
					));

				case 'create_agent_md': {
					const existing = this.app.vault.getAbstractFileByPath(AGENT_MD_PATH);
					if (existing) return this.ok(call, { action: 'exists', path: AGENT_MD_PATH });
					await this.app.vault.create(AGENT_MD_PATH, DEFAULT_AGENT_MD);
					return this.ok(call, { action: 'created', path: AGENT_MD_PATH });
				}

				default:
					throw new Error(`Unknown tool: ${call.tool}`);
			}
		} catch (err) {
			new Notice(`Tool failed: ${call.tool}`);
			return {
				id: call.id,
				tool: call.tool,
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	private ok(call: ToolCall, result: unknown): ToolResult {
		return { id: call.id, tool: call.tool, ok: true, result };
	}

	private ensureCanWrite() {
		if (this.plugin.settings.agentMode === 'read') {
			throw new Error('Agent Mode "read" erlaubt keine Schreibzugriffe.');
		}
	}

	private ensureCanDelete() {
		if (this.plugin.settings.agentMode !== 'agent') {
			throw new Error('Löschen ist nur im Agent Mode "agent" erlaubt.');
		}
	}

	private async confirmIfNeeded(kind: ConfirmKind, args: Record<string, unknown>, error: string) {
		if (this.plugin.settings.agentMode === 'agent') return;

		const enabled = kind === 'delete'
			? this.plugin.settings.confirmBeforeDelete
			: this.plugin.settings.confirmBeforeWrite;
		if (!enabled) return;
		const confirmed = await new ConfirmModal(
			this.app,
			kind,
			(args['path'] as string | undefined) ?? '(unbekannt)',
			buildSnippet(kind, args),
		).openAndWait();
		if (!confirmed) throw new Error(error);
	}
}
