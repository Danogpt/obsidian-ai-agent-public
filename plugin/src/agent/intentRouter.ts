import type { UIMode } from '../chat/chatStore';
import type { LearnedIntentPattern } from '../settingsTypes';
import { getLearnedIntent } from './intentClassifier';

export type { UIMode };

export interface RouterResult {
	mode: UIMode;
	needsPlanner: boolean;
	allowWrites: boolean;
	maxRetrievedChunks: number;
	reason: string;
	confidence: 'high' | 'med' | 'low';
	signals?: string[];
}

const SLASH_MODE_MAP: Record<string, UIMode> = {
	'/ask':   'ask',
	'/edit':  'edit',
	'/agent': 'agent',
	'/plan':  'plan',
};

const SEEDED_INTENT_KEYWORDS: Record<UIMode, string[]> = {
	ask: [
		'was ist', 'was bedeutet', 'was steht', 'erklaere', 'erkläre', 'explain', 'what is',
		'why', 'warum', 'wie funktioniert', 'summarize', 'zusammenfassen', 'fasse zusammen',
		'analysiere', 'analyze', 'bewerte', 'compare', 'vergleiche nur', 'ohne zu ändern', 'ohne zu aendern',
	],
	edit: [
		'aendere', 'ändere', 'edit', 'bearbeite', 'update', 'aktualisiere', 'ergänze', 'ergaenze',
		'format', 'formatiere', 'formatieren', 'structure', 'strukturiere', 'rewrite', 'umschreiben',
		'polish', 'improve', 'verbessere', 'make nicer', 'schöner', 'schoener', 'clean up', 'aufräumen',
		'aufraeumen', 'übersichtlicher', 'uebersichtlicher', 'klarer', 'sauberer', 'professioneller',
		'sinnvoller', 'wissenschaftlicher', 'besser formulieren', 'fix typo', 'korrigiere',
		'schreibe es in die datei', 'schreib es in die datei', 'schreib das in die datei',
		'speichere es in der datei', 'speicher das in der datei', 'uebernimm das', 'übernimm das',
	],
	agent: [
		'research and update', 'research and edit', 'recherchiere und aktualisiere', 'recherchiere und ändere',
		'recherchiere und aendere', 'suche und schreibe', 'compare and update', 'vergleiche und aktualisiere',
		'arbeite das ab', 'step by step', 'schritt für schritt', 'schritt fuer schritt', 'mehrere dateien',
		'all files', 'alle dateien', 'for each', 'für jede', 'fuer jede', 'build and save', 'erstelle und speichere',
		'einzelnen dateien', 'einzelne dateien', 'inhaltlich füllen', 'inhaltlich fuellen', 'ausformulieren',
	],
	plan: [
		'mach einen plan', 'erst planen', 'plan zuerst', 'plan das', 'make a plan', 'draft a plan',
		'before editing', 'bevor du änderst', 'bevor du aenderst', 'erst durchlesen', 'erst recherchieren',
		'gliederung planen', 'roadmap', 'outline first',
	],
};

// Heuristic patterns (German + English)
const WRITEBACK_RE = /(?:(?:schreib|schreibe|speicher|speichere|uebernimm|übernimm)\s+(?:es|das|den\s+text|die\s+fassung|die\s+version|den\s+inhalt)?\s*(?:in|zurueck\s+in|zurück\s+in|rein\s+in|direkt\s+in)?\s*(?:die|der|diese|aktuelle)?\s*(?:datei|notiz|file)|(?:in\s+die\s+datei\s+schreiben|in\s+der\s+datei\s+speichern))/u;
const EDIT_VERBS_RE = /(?:aendere|ändere|bearbeite|ueberarbeite|überarbeite|ergaenze|ergänze|aktualisiere|loesche|lösche|ersetze|strukturiere|formatiere|formatieren|verschönere|verschoenere|verbessere|optimier[e]?|räume\s+auf|raeume\s+auf|mach[e]?\s+(?:das|die|den|diese|diesen|datei)?\s*(?:schöner|schoener|übersichtlicher|uebersichtlicher|klarer|sauberer|professioneller|sinnvoller|wissenschaftlicher)|schöner\s+machen|schoener\s+machen|besser\s+formatieren|formuliere\s+(?:das|den|die|diese|diesen|es)?\s*(?:erst(?:mal|einmal)?\s+)?(?:professioneller|sinnvoller|klarer|besser|wissenschaftlicher|um)|(?:professioneller|sinnvoller|wissenschaftlicher|besser)\s+formulieren|rewrite|patch|schreib[e]?\s+um)/u;
const AGENT_PHRASES_RE = /(?:arbeite\s+das\s+ab|mach[e]?\s+schritt|führe\s+aus|fuehre\s+aus|erstelle\s+und\s+speichere|recherchiere\s+.*(?:aktualisiere|aendere|ändere|ergaenze|ergänze|vergleiche|formatiere|schreibe|baue\s+ein)|suche\s+und\s+schreibe|vergleiche\s+und\s+(?:aendere|ändere|formatiere|schreibe|baue\s+ein)|ändere\s+danach|aendere\s+danach|für\s+jede|fuer\s+jede|für\s+alle|fuer\s+alle|alle\s+dateien|mehrere\s+dateien|(?:einzelnen?|mehrere|alle)\s+[^.!?\n]{0,40}dateien\s+[^.!?\n]{0,80}(?:bearbeite|ueberarbeite|überarbeite|fuellen|füllen|ausformulieren|schöner|schoener|inhaltlich)|schritt\s+für\s+schritt|step\s+by\s+step|sequentiell)/u;
const PLAN_PHRASES_RE = /(?:mach[e]?\s+(?:einen?|erst\s+einen?)\s+plan|erst\s+planen|plan[e]?\s+(?:das|zuerst)|zeig[e]?\s+(?:mir\s+)?(?:einen?|den)\s+plan|zeig[e]?\s+erst|sammle\s+erst|bevor\s+(?:du|ich)\s+(?:änderst|aenderst|schreibst))/u;
const VAGUE_TASK_RE = /(?:kannst|könntest|koenntest|mach|mache|machst|soll|sollst|bitte|schau\s+(?:dir\s+)?(?:das|die|den)|geh\s+(?:da\s+)?(?:mal\s+)?drüber|geh\s+(?:da\s+)?(?:mal\s+)?drueber|ordentlich|aufbereiten|aufbereite|einbauen|ausbauen|anpassen|prüfen|pruefen|check|fix)/u;
const FOLLOWUP_TASK_RE = /(?:^|\b)(?:ja|genau|ok|okay|passt|so|das|es|den\s+text|die\s+version)\b.*\b(?:uebernimm|übernimm|schreib|schreibe|speicher|speichere|mach|mache|setz|setze|nimm|nehme|einfügen|einfuegen|verwenden|anwenden)\b|\b(?:uebernimm|übernimm|schreib|schreibe|speicher|speichere|mach|mache|setz|setze|nimm|nehme|einfügen|einfuegen|verwenden|anwenden)\b.*\b(?:das|es|so|den\s+text|die\s+version)\b/u;
const QUESTION_RE = /[?؟]\s*$|\b(?:was|warum|wieso|wie|wann|wo|wer|welche|findest du|erklaere|erkläre|explain|what|why|how)\b/u;

export function isLikelyEditRequest(message: string): boolean {
	return EDIT_VERBS_RE.test(message.toLowerCase());
}

export function parseSlashCommand(message: string): { command: UIMode | null; stripped: string } {
	for (const [slash, mode] of Object.entries(SLASH_MODE_MAP)) {
		if (message === slash) return { command: mode, stripped: '' };
		if (message.startsWith(slash + ' ')) {
			return { command: mode, stripped: message.slice(slash.length + 1).trimStart() };
		}
		const tokenRe = new RegExp(`(^|\\s)${slash.replace('/', '\\/')}(?=\\s|$)`);
		if (tokenRe.test(message)) {
			const stripped = message.replace(tokenRe, '$1').replace(/\s+/g, ' ').trim();
			return { command: mode, stripped };
		}
	}
	return { command: null, stripped: message };
}

export function routeIntent(
	message: string,
	_currentMode: UIMode,
	opts: {
		hasActiveFile?: boolean;
		hasMentionedFiles?: boolean;
		hasSelection?: boolean;
		learnedIntentPatterns?: LearnedIntentPattern[];
	} = {},
): RouterResult {
	const { command } = parseSlashCommand(message);
	const text = message.toLowerCase();

	// 1. Slash command wins unconditionally
	if (command) {
		return buildResult(command, 'high', `Slash /${command}`, ['slash_command']);
	}

	// 2. Specific heuristic signals for automatic routing
	if (AGENT_PHRASES_RE.test(text)) {
		return buildResult('agent', 'med', 'Heuristik: Agent-Workflow', ['agent_phrase']);
	}
	if (WRITEBACK_RE.test(text) && (opts.hasActiveFile || opts.hasMentionedFiles || opts.hasSelection)) {
		return buildResult('edit', 'high', 'Heuristik: Inhalt in Datei schreiben', ['writeback_phrase', 'file_context']);
	}
	if (PLAN_PHRASES_RE.test(text)) {
		return buildResult('plan', 'med', 'Heuristik: Plan-Formulierung', ['plan_phrase']);
	}

	// 3. Seeded keyword catalogue (broad DE/EN coverage)
	const seeded = matchSeededIntent(text);
	if (seeded) {
		if ((seeded.mode === 'edit' || seeded.mode === 'agent') && !(opts.hasActiveFile || opts.hasMentionedFiles || opts.hasSelection)) {
			return buildResult('ask', 'low', `Seed "${seeded.keyword}" wollte ${seeded.mode}, aber Dateikontext fehlt`, ['seed_keyword', `seed:${seeded.keyword}`, 'missing_file_context']);
		}
		return buildResult(seeded.mode, 'med', `Seed-Keyword: ${seeded.keyword}`, ['seed_keyword', `seed:${seeded.keyword}`]);
	}
	if (EDIT_VERBS_RE.test(text) && (opts.hasActiveFile || opts.hasMentionedFiles || opts.hasSelection)) {
		return buildResult('edit', 'med', 'Heuristik: Edit-Verb + Dateikontext', ['edit_phrase', 'file_context']);
	}

	const learned = getLearnedIntent(opts.learnedIntentPatterns, message);
	if (learned) {
		return buildResult(
			learned.mode,
			learned.count >= 4 ? 'high' : 'med',
			`Gelernt: "${learned.key}" -> ${learned.mode} (${learned.count}x)`,
			['learned_intent', `learned_count:${learned.count}`, `learned_total:${learned.total}`],
		);
	}
	if (FOLLOWUP_TASK_RE.test(text) && !QUESTION_RE.test(text) && (opts.hasActiveFile || opts.hasMentionedFiles || opts.hasSelection)) {
		return buildResult('ask', 'low', 'Unklar: Folgeanweisung mit Dateikontext', ['followup_task', 'file_context']);
	}
	if (VAGUE_TASK_RE.test(text) && (opts.hasActiveFile || opts.hasMentionedFiles || opts.hasSelection)) {
		return buildResult('ask', 'low', 'Unklar: Aufgabenformulierung mit Dateikontext', ['vague_task', 'file_context']);
	}

	// 4. Default: ask
	return buildResult('ask', opts.hasActiveFile || opts.hasMentionedFiles || opts.hasSelection ? 'med' : 'high', 'Standard: Ask', ['default_ask']);
}

function matchSeededIntent(text: string): { mode: UIMode; keyword: string } | null {
	for (const mode of ['plan', 'agent', 'edit', 'ask'] as UIMode[]) {
		const keyword = SEEDED_INTENT_KEYWORDS[mode].find(item => text.includes(item));
		if (keyword) return { mode, keyword };
	}
	return null;
}

function buildResult(mode: UIMode, confidence: RouterResult['confidence'], reason: string, signals: string[] = []): RouterResult {
	const cfg: Record<UIMode, Pick<RouterResult, 'needsPlanner' | 'allowWrites' | 'maxRetrievedChunks'>> = {
		ask:   { needsPlanner: false, allowWrites: false, maxRetrievedChunks: 5  },
		edit:  { needsPlanner: false, allowWrites: true,  maxRetrievedChunks: 3  },
		agent: { needsPlanner: true,  allowWrites: true,  maxRetrievedChunks: 10 },
		plan:  { needsPlanner: true,  allowWrites: false, maxRetrievedChunks: 10 },
	};
	return { mode, ...cfg[mode], reason, confidence, signals };
}
