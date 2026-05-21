/* eslint-disable obsidianmd/ui/sentence-case */

import { App, PluginSettingTab, Setting } from 'obsidian';
import type ObsidianAiAgentPlugin from './main';
import type { AgentMode } from './tools/toolTypes';

export type { ProviderName } from './models/modelRegistry';

// Re-export types and defaults so existing imports from './settings' continue to work
export {
	DEFAULT_SETTINGS,
	buildStyleProfile,
} from './settingsTypes';
export type {
	AiAgentSettings,
	VaultPurpose,
	WritingStyle,
	MarkdownEditMode,
	AgentBehavior,
	TaskProfile,
	AnswerPreference,
} from './settingsTypes';

import type {
	AiAgentSettings,
	VaultPurpose,
	WritingStyle,
	MarkdownEditMode,
	AgentBehavior,
	TaskProfile,
	AnswerPreference,
} from './settingsTypes';

export class AiAgentSettingsTab extends PluginSettingTab {
	plugin: ObsidianAiAgentPlugin;

	constructor(app: App, plugin: ObsidianAiAgentPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private addHeading(containerEl: HTMLElement, name: string, desc?: string) {
		const heading = new Setting(containerEl).setName(name).setHeading();
		if (desc) heading.setDesc(desc);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('ai-agent-settings');
		this.addHeading(containerEl, 'AI Agent');

		// ── API Keys ─────────────────────────────────────────────
		this.addHeading(containerEl, 'API Keys');

		new Setting(containerEl)
			.setName('OpenAI')
			.addText(t => {
				t.inputEl.type = 'password';
				t.setPlaceholder('sk-…').setValue(this.plugin.settings.openaiApiKey)
					.onChange(async v => { this.plugin.settings.openaiApiKey = v; await this.plugin.saveSettings(); });
			});

		new Setting(containerEl)
			.setName('Anthropic')
			.addText(t => {
				t.inputEl.type = 'password';
				t.setPlaceholder('sk-ant-…').setValue(this.plugin.settings.anthropicApiKey)
					.onChange(async v => { this.plugin.settings.anthropicApiKey = v; await this.plugin.saveSettings(); });
			});

		new Setting(containerEl)
			.setName('Google Gemini')
			.addText(t => {
				t.inputEl.type = 'password';
				t.setPlaceholder('AIza…').setValue(this.plugin.settings.geminiApiKey)
					.onChange(async v => { this.plugin.settings.geminiApiKey = v; await this.plugin.saveSettings(); });
			});

		// ── Ollama ───────────────────────────────────────────────
		this.addHeading(containerEl, 'Ollama');

		new Setting(containerEl)
			.setName('Server URL')
			.addText(t => t
				.setPlaceholder('http://127.0.0.1:11434').setValue(this.plugin.settings.ollamaBaseUrl)
				.onChange(async v => { this.plugin.settings.ollamaBaseUrl = v; await this.plugin.saveSettings(); }));

		// ── Agent ────────────────────────────────────────────────
		this.addHeading(containerEl, 'Agent');

		new Setting(containerEl)
			.setName('Agent-Modus')
			.setDesc('Bestimmt welche Vault-Aktionen erlaubt sind.')
			.addDropdown(d => d
				.addOption('read', 'Read — nur lesen und suchen')
				.addOption('suggest', 'Suggest — Änderungen mit Bestätigung')
				.addOption('agent', 'Agent — Schreiben und Löschen erlaubt')
				.setValue(this.plugin.settings.agentMode)
				.onChange(async v => {
					this.plugin.settings.agentMode = v as AgentMode;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Bestätigung vor Schreiben')
			.addToggle(t => t.setValue(this.plugin.settings.confirmBeforeWrite)
				.onChange(async v => { this.plugin.settings.confirmBeforeWrite = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Bestätigung vor Löschen')
			.addToggle(t => t.setValue(this.plugin.settings.confirmBeforeDelete)
				.onChange(async v => { this.plugin.settings.confirmBeforeDelete = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('agent.md erstellen')
			.setDesc('Erstellt eine Regel- und Kontextdatei im Vault-Root.')
			.addButton(b => b.setButtonText('agent.md erstellen').onClick(async () => {
				await this.plugin.createAgentMd();
			}));

		// ── Verhalten ────────────────────────────────────────────
		this.addHeading(containerEl, 'Verhalten');

		new Setting(containerEl)
			.setName('Aktive Notiz automatisch mitsenden')
			.addToggle(t => t.setValue(this.plugin.settings.autoSendActiveNote)
				.onChange(async v => { this.plugin.settings.autoSendActiveNote = v; await this.plugin.saveSettings(); }));

		// ── Schreibprofil ─────────────────────────────────────────
		this.addHeading(containerEl, 'Schreibprofil');
		containerEl.createEl('p', {
			text: 'Diese Einstellungen bestimmen, wie der Agent grundsätzlich schreibt und denkt. Projektspezifische Regeln gehören in die agent.md.',
			cls: 'setting-item-description',
		});

		new Setting(containerEl)
			.setName('Vault-Zweck')
			.setDesc('Wofür dieser Vault hauptsächlich genutzt wird.')
			.addDropdown(d => d
				.addOption('student',           'Student / Uni')
				.addOption('business',          'Arbeit / Business')
				.addOption('research',          'Research / Wissenschaft')
				.addOption('coding',            'Coding / Projektentwicklung')
				.addOption('personal_knowledge','Private Wissensdatenbank')
				.addOption('content',           'Content / Blog / Social Media')
				.addOption('finance',           'Finance / Investment Research')
				.addOption('custom',            'Custom')
				.setValue(this.plugin.settings.vaultPurpose)
				.onChange(async v => { this.plugin.settings.vaultPurpose = v as VaultPurpose; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Schreibstil')
			.setDesc('Wie der Agent standardmäßig formulieren soll.')
			.addDropdown(d => d
				.addOption('neutral',     'Neutral')
				.addOption('formal',      'Formell')
				.addOption('casual',      'Locker')
				.addOption('academic',    'Wissenschaftlich')
				.addOption('concise',     'Kurz & direkt')
				.addOption('explanatory', 'Ausführlich erklärend')
				.addOption('executive',   'Executive Summary')
				.addOption('study_notes', 'Lernzettel / Klausurmodus')
				.addOption('consulting',  'Consulting Style')
				.addOption('custom',      'Custom')
				.setValue(this.plugin.settings.writingStyle)
				.onChange(async v => { this.plugin.settings.writingStyle = v as WritingStyle; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Markdown-Bearbeitungsmodus')
			.setDesc('Wie stark der Agent Dateien umformulieren darf.')
			.addDropdown(d => d
				.addOption('minimal',   'Minimal — nur kleine Korrekturen')
				.addOption('structure', 'Struktur verbessern')
				.addOption('rewrite',   'Umformulieren (Bedeutung erhalten)')
				.addOption('expand',    'Ausbauen & ergänzen')
				.addOption('compress',  'Kürzen & verdichten')
				.addOption('transform', 'Transformieren (neues Format)')
				.setValue(this.plugin.settings.markdownEditMode)
				.onChange(async v => { this.plugin.settings.markdownEditMode = v as MarkdownEditMode; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Agent-Verhalten')
			.setDesc('Wie aktiv und eigenständig der Agent handeln soll.')
			.addDropdown(d => d
				.addOption('conservative', 'Conservative — nur explizit Gefragtes')
				.addOption('helpful',      'Helpful — sinnvolle Verbesserungen vorschlagen')
				.addOption('proactive',    'Proactive — Lücken erkennen, nächste Schritte')
				.addOption('autonomous',   'Autonomous — Aufgaben selbstständig abarbeiten')
				.setValue(this.plugin.settings.agentBehavior)
				.onChange(async v => { this.plugin.settings.agentBehavior = v as AgentBehavior; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Aufgabenprofil')
			.setDesc('Legt fest, welche Arbeitsweise der Agent standardmaessig fuer diese Vault-Sitzung bevorzugt.')
			.addDropdown(d => d
				.addOption('general',  'Allgemein')
				.addOption('research', 'Recherche')
				.addOption('coding',   'Programmierung')
				.addOption('planning', 'Planung')
				.addOption('writing',  'Schreiben')
				.setValue(this.plugin.settings.taskProfile)
				.onChange(async v => { this.plugin.settings.taskProfile = v as TaskProfile; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Antwortpraeferenz')
			.setDesc('Bestimmt, welche Art von Antworten bevorzugt wird.')
			.addDropdown(d => d
				.addOption('balanced',             'Ausgewogen')
				.addOption('concise_actions',      'Knapp und handlungsorientiert')
				.addOption('structured_analysis',  'Strukturierte Analyse')
				.addOption('implementation_first', 'Umsetzung zuerst')
				.addOption('draft_first',          'Erst Entwurf, dann Hinweise')
				.setValue(this.plugin.settings.answerPreference)
				.onChange(async v => { this.plugin.settings.answerPreference = v as AnswerPreference; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Datei-Vorlagen automatisch nutzen')
			.setDesc('Nutzt fuer To-dos, Projektplaene, Recherchen und Protokolle automatisch eine einheitliche Grundstruktur.')
			.addToggle(t => t.setValue(this.plugin.settings.autoApplyFileTemplates)
				.onChange(async v => { this.plugin.settings.autoApplyFileTemplates = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Standardsprache')
			.addDropdown(d => d
				.addOption('auto', 'Auto (Sprache des Nutzers)')
				.addOption('de',   'Deutsch')
				.addOption('en',   'English')
				.setValue(this.plugin.settings.defaultLanguage)
				.onChange(async v => { this.plugin.settings.defaultLanguage = v as 'de' | 'en' | 'auto'; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Markdown-Struktur erhalten')
			.setDesc('Überschriften, Reihenfolge und vorhandene Formatierung möglichst nicht verändern.')
			.addToggle(t => t.setValue(this.plugin.settings.preserveMarkdownStructure)
				.onChange(async v => { this.plugin.settings.preserveMarkdownStructure = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Vor großem Rewrite fragen')
			.setDesc('Agent fragt nach, bevor er eine Datei stark umschreibt.')
			.addToggle(t => t.setValue(this.plugin.settings.askBeforeLargeRewrite)
				.onChange(async v => { this.plugin.settings.askBeforeLargeRewrite = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Custom Instructions')
			.setDesc('Eigene Stil-Regeln, z. B. "keine Semikolons", "immer mit Beispielen", "kurze Absätze".')
			.addTextArea(t => t
				.setPlaceholder('z. B. Schreibe marktintern, knapp, mit Zahlen und klaren Treibern.')
				.setValue(this.plugin.settings.customStyleInstructions)
				.onChange(async v => { this.plugin.settings.customStyleInstructions = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Embedding-Backend')
			.setDesc('Dense-Layer fuer Retrieval: lokal bevorzugt, optional ueber Provider.')
			.addDropdown(d => d
				.addOption('local', 'Lokal')
				.addOption('openai', 'OpenAI')
				.addOption('gemini', 'Gemini')
				.addOption('ollama', 'Ollama')
				.setValue(this.plugin.settings.embeddingBackend)
				.onChange(async v => {
					this.plugin.settings.embeddingBackend = v as AiAgentSettings['embeddingBackend'];
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Stil-Selbstkritik')
			.setDesc('Fuehrt vor der finalen Anzeige einen billigen zweiten Stil-/Format-Check aus.')
			.addToggle(t => t
				.setValue(this.plugin.settings.enableStyleCritique)
				.onChange(async v => {
					this.plugin.settings.enableStyleCritique = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('LLM-Reranking')
			.setDesc('Fuehrt nach der Suche einen zusaetzlichen LLM-Aufruf durch, um die relevantesten Treffer nach oben zu sortieren. Kostet einen Extra-API-Aufruf pro Suche.')
			.addToggle(t => t
				.setValue(this.plugin.settings.enableLlmRerank)
				.onChange(async v => {
					this.plugin.settings.enableLlmRerank = v;
					await this.plugin.saveSettings();
				}));
	}
}
