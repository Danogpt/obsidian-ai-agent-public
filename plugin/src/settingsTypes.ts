import type { CustomModelConfig } from './models/modelRegistry';
import type { AgentMode } from './tools/toolTypes';

// ── Profile types ────────────────────────────────────────────────

export type VaultPurpose =
	| 'student' | 'business' | 'research' | 'coding'
	| 'personal_knowledge' | 'content' | 'finance' | 'custom';

export type WritingStyle =
	| 'neutral' | 'formal' | 'casual' | 'academic'
	| 'concise' | 'explanatory' | 'executive' | 'study_notes'
	| 'consulting' | 'custom';

export type MarkdownEditMode =
	| 'minimal' | 'structure' | 'rewrite' | 'expand' | 'compress' | 'transform';

export type AgentBehavior =
	| 'conservative' | 'helpful' | 'proactive' | 'autonomous';

export type TaskProfile =
	| 'general' | 'research' | 'coding' | 'planning' | 'writing';

export type AnswerPreference =
	| 'balanced'
	| 'concise_actions'
	| 'structured_analysis'
	| 'implementation_first'
	| 'draft_first';

// ── Settings interface ───────────────────────────────────────────

export interface AiAgentSettings {
	openaiApiKey: string;
	anthropicApiKey: string;
	geminiApiKey: string;
	ollamaBaseUrl: string;

	lastSelectedModelId: string;
	autoSendActiveNote: boolean;

	agentMode: AgentMode;
	confirmBeforeWrite: boolean;
	confirmBeforeDelete: boolean;

	customModels: CustomModelConfig[];

	// Writing profile
	vaultPurpose: VaultPurpose;
	writingStyle: WritingStyle;
	markdownEditMode: MarkdownEditMode;
	agentBehavior: AgentBehavior;
	taskProfile: TaskProfile;
	answerPreference: AnswerPreference;
	autoApplyFileTemplates: boolean;
	defaultLanguage: 'de' | 'en' | 'auto';
	preserveMarkdownStructure: boolean;
	askBeforeLargeRewrite: boolean;
	customStyleInstructions: string;
	embeddingBackend: 'local' | 'openai' | 'gemini' | 'ollama';
	enableStyleCritique: boolean;
	enableLlmRerank: boolean;
}

export const DEFAULT_SETTINGS: AiAgentSettings = {
	openaiApiKey: '',
	anthropicApiKey: '',
	geminiApiKey: '',
	ollamaBaseUrl: 'http://127.0.0.1:11434',

	lastSelectedModelId: 'gpt-5.5',
	autoSendActiveNote: true,

	agentMode: 'suggest',
	confirmBeforeWrite: true,
	confirmBeforeDelete: true,

	customModels: [],

	vaultPurpose: 'student',
	writingStyle: 'concise',
	markdownEditMode: 'structure',
	agentBehavior: 'helpful',
	taskProfile: 'general',
	answerPreference: 'balanced',
	autoApplyFileTemplates: true,
	defaultLanguage: 'auto',
	preserveMarkdownStructure: true,
	askBeforeLargeRewrite: true,
	customStyleInstructions: '',
	embeddingBackend: 'local',
	enableStyleCritique: true,
	enableLlmRerank: false,
};

// ── Style profile builder ────────────────────────────────────────

const PURPOSE_HINTS: Record<VaultPurpose, string> = {
	student:           'Erkläre verständlich, nutze Definitionen und Beispiele, erstelle Lernmaterial.',
	business:          'Schreibe professionell und knapp, Fokus auf Entscheidung und nächste Schritte.',
	research:          'Präzise, vorsichtig, quellenorientiert, trenne Befund und Interpretation.',
	coding:            'Fokus auf Architektur und Dateipfade, erst lesen dann ändern, kleine Patches.',
	personal_knowledge:'Vernetz Ideen, baue Verweise, denke in Konzepten und Strukturen.',
	content:           'Schreibe ansprechend, publikumsgerecht und leicht lesbar.',
	finance:           'Analytisch, zahlenorientiert, trenne Fakten, Annahmen und Einschätzung.',
	custom:            '',
};

const TASK_PROFILE_HINTS: Record<TaskProfile, string> = {
	general:  'Arbeite allgemein nuetzlich, klar und kontextbewusst.',
	research: 'Priorisiere Befunde, Quellenbezug, Unsicherheit, offene Fragen und saubere Zusammenfassungen.',
	coding:   'Priorisiere konkrete Umsetzung, Dateipfade, Risiken, kleine Patches und verifizierbare Schritte.',
	planning: 'Priorisiere Ziele, Arbeitspakete, Abhaengigkeiten, Entscheidungen, offene Punkte und naechste Schritte.',
	writing:  'Priorisiere gute Struktur, Lesefluss, klare Ueberschriften, konsistente Sprache und saubere Endfassungen.',
};

const ANSWER_PREFERENCE_HINTS: Record<AnswerPreference, string> = {
	balanced:              'Nutze eine ausgewogene Antworttiefe.',
	concise_actions:       'Bevorzuge knappe, handlungsorientierte Antworten mit klaren naechsten Schritten.',
	structured_analysis:   'Bevorzuge strukturierte Analyse mit Abschnitten, Befund, Begruendung und offenen Fragen.',
	implementation_first:  'Bevorzuge Umsetzung vor langer Erklaerung. Zeige nur die noetige Begruendung.',
	draft_first:           'Bevorzuge zuerst einen verwendbaren Entwurf und danach kurze Hinweise.',
};

// ── MUST rules (non-negotiable per purpose) ──────────────────────

const PURPOSE_MUST_RULES: Record<VaultPurpose, string[]> = {
	student:           ['Erklaere Konzepte klar und verstaendlich. Erfinde keine Fakten.'],
	business:          ['Halte Ausgaben professionell und auf den Punkt. Kein Fuelltext.'],
	research:          ['Trenne Befund von Interpretation. Keine unbelegten Behauptungen.'],
	coding:            ['Lies immer Dateien bevor du sie aenderst. Kleine, pruefbare Aenderungen.'],
	personal_knowledge:['Baue Querverweise. Behalte bestehende Verlinkungen beim Bearbeiten.'],
	content:           ['Achte auf Lesbarkeit und Zielgruppe. Kein generisches Kochbuchformat.'],
	finance:           ['Trenne klar Fakten, Annahmen und Einschaetzungen.'],
	custom:            [],
};

// ── Style examples (good/bad) ─────────────────────────────────────

const STYLE_EXAMPLES: Partial<Record<WritingStyle, { good: string; bad: string }>> = {
	concise: {
		good: 'Die Funktion gibt null zurueck wenn der Pfad nicht existiert.',
		bad:  'Es ist wichtig zu beachten, dass unter bestimmten Umstaenden die Funktion null zurueckgeben koennte...',
	},
	academic: {
		good: 'Gemaess [Quelle] gilt X unter Bedingung Y (vgl. Z).',
		bad:  'Ich denke, das koennte vielleicht damit zusammenhaengen, dass...',
	},
	formal: {
		good: 'Die Analyse ergab folgende Kernaussagen: 1. ... 2. ...',
		bad:  'Also ich hab mir das mal angeschaut und so ungefaehr...',
	},
	executive: {
		good: 'Empfehlung: Option A. Begruendung: spart 30 % Aufwand. Naechster Schritt: Meeting am Mo.',
		bad:  'Es gibt mehrere Moeglichkeiten, die wir in Betracht ziehen koennten...',
	},
};

const TASK_PROFILE_RULES: Record<TaskProfile, string[]> = {
	general: [
		'Arbeite allgemein nuetzlich, direkt und kontextbewusst.',
		'Wiederhole keine offensichtlichen Informationen unnoetig.',
	],
	research: [
		'Wenn ausreichend Wissen, Web-Ergebnisse oder Quellenkontext vorhanden sind, antworte direkt mit einem kompakten Sachueberblick statt zuerst Vault-Arbeit vorzuschlagen.',
		'Trenne klar zwischen Kurzfazit, Befunden, Unsicherheit und offenen Fragen.',
		'Nenne Quellen oder fehlende Belege explizit, wenn sie fuer die Aussage wichtig sind.',
	],
	coding: [
		'Behandle den Vault und das Plugin als Arbeitskontext. Wenn die Anfrage wahrscheinlich projekt- oder dateibezogen ist, lies zuerst relevante Dateien statt generisch zu antworten.',
		'Bevorzuge konkrete Umsetzung, Dateipfade, kleine Patches, Risiken und verifizierbare naechste Schritte.',
		'Wenn Information im Projekt fehlen koennte, suche gezielt im Vault statt nur allgemein zu erklaeren.',
	],
	planning: [
		'Strukturiere Antworten in Ziel, Arbeitspakete, Abhaengigkeiten, Risiken, offene Punkte und naechste Schritte.',
		'Verdichte lose Ideen zu einem umsetzbaren Plan.',
	],
	writing: [
		'Bevorzuge gut lesbare Endfassungen mit klarer Struktur und konsistenten Ueberschriften.',
		'Wenn eine Datei beschrieben wird, liefere moeglichst direkt einen verwendbaren Entwurf statt nur Meta-Hinweise.',
	],
};

const ANSWER_PREFERENCE_RULES: Record<AnswerPreference, string[]> = {
	balanced: [
		'Waehle eine ausgewogene Tiefe zwischen Ergebnis und Begruendung.',
	],
	concise_actions: [
		'Antworte knapp.',
		'Beende Antworten mit klaren naechsten Schritten oder konkreten Punkten.',
	],
	structured_analysis: [
		'Nutze klare Abschnitte statt Fliesstext.',
		'Stelle Befunde, Begruendung und offene Fragen getrennt dar.',
	],
	implementation_first: [
		'Bevorzuge Ausfuehrung vor Erklaerung.',
		'Wenn eine konkrete Aktion moeglich ist, fuehre sie zuerst aus und erklaere danach kurz.',
	],
	draft_first: [
		'Wenn der Nutzer auf einen Inhalt oder Text hinauswill, liefere zuerst einen brauchbaren Entwurf.',
		'Meta-Erlaeuterungen nur kurz und nachrangig.',
	],
};

/**
 * Build the compact STYLE_PROFILE block injected into the system prompt.
 *
 * Budget tiers (maxContextChars):
 *   tight  (< 40 000) → header + MUST rules only
 *   normal (< 80 000) → + PREFERRED rules + hints
 *   ample  (≥ 80 000) → + style examples
 */
export function buildStyleProfile(s: AiAgentSettings, maxContextChars = 120_000): string {
	const tight  = maxContextChars < 40_000;
	const normal = maxContextChars < 80_000;

	const softRules: string[] = [];
	if (s.preserveMarkdownStructure) softRules.push('preserve_structure');
	if (s.askBeforeLargeRewrite)     softRules.push('ask_before_large_rewrite');

	const lines = [
		'STYLE_PROFILE:',
		`purpose=${s.vaultPurpose}`,
		`style=${s.writingStyle}`,
		`edit_mode=${s.markdownEditMode}`,
		`behavior=${s.agentBehavior}`,
		`task_profile=${s.taskProfile}`,
		`answer_preference=${s.answerPreference}`,
		`language=${s.defaultLanguage}`,
	];

	// MUST rules — always included (hard requirements, never drop under budget pressure)
	const mustRules: string[] = [
		...PURPOSE_MUST_RULES[s.vaultPurpose],
		...(softRules.includes('preserve_structure') ? ['Behalte die bestehende Markdown-Struktur beim Bearbeiten.'] : []),
	];
	if (s.customStyleInstructions.trim()) {
		mustRules.push(s.customStyleInstructions.trim());
	}
	if (mustRules.length) {
		lines.push('MUST:');
		for (const rule of mustRules) lines.push(`- ${rule}`);
	}

	// PREFERRED rules — dropped when context is tight
	if (!tight) {
		const hint = PURPOSE_HINTS[s.vaultPurpose];
		if (hint) lines.push(`hint: ${hint}`);
		lines.push(`task_hint: ${TASK_PROFILE_HINTS[s.taskProfile]}`);
		lines.push(`answer_hint: ${ANSWER_PREFERENCE_HINTS[s.answerPreference]}`);

		const preferredRules: string[] = [
			...TASK_PROFILE_RULES[s.taskProfile],
			...ANSWER_PREFERENCE_RULES[s.answerPreference],
		].slice(0, 8);
		if (preferredRules.length) {
			lines.push('PREFERRED:');
			for (const rule of preferredRules) lines.push(`- ${rule}`);
		}
	}

	// Style examples — only when context is ample
	if (!normal) {
		const example = STYLE_EXAMPLES[s.writingStyle];
		if (example) {
			lines.push(`EXAMPLE_GOOD: "${example.good}"`);
			lines.push(`EXAMPLE_BAD:  "${example.bad}"`);
		}
	}

	return lines.join('\n');
}
