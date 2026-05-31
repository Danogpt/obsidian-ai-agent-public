import type { UIMode } from '../chat/chatStore';
import type { LearnedIntentPattern } from '../settingsTypes';
import type { RouterResult } from './intentRouter';

export interface IntentClassifierInput {
	message: string;
	hasActiveFile?: boolean;
	hasSelection?: boolean;
	hasMentionedFiles?: boolean;
	webSearchEnabled?: boolean;
	baseMode?: UIMode;
	baseConfidence?: 'high' | 'med' | 'low';
	baseSignals?: string[];
}

export interface IntentClassifierResult {
	mode: UIMode;
	confidence: number;
	reason: string;
	signals: string[];
}

const VALID_MODES = new Set<UIMode>(['ask', 'edit', 'agent', 'plan']);

export function normalizeIntentPattern(message: string): string {
	return message
		.toLowerCase()
		.normalize('NFKC')
		.replace(/[`*_#[\](){}.,!?;:/"'“”„]/g, ' ')
		.replace(/\b(der|die|das|den|dem|eine|einen|einem|einer|bitte|mal|kurz|kannst|könntest|koenntest|du|mir)\b/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 160);
}

export function buildIntentClassifierPrompt(input: IntentClassifierInput): string {
	return [
		'Klassifiziere die Nutzerabsicht fuer einen Obsidian AI Agent.',
		'Antworte ausschliesslich als JSON ohne Markdown.',
		'Modi:',
		'- ask: beantworten, erklaeren, zusammenfassen, recherchieren ohne Datei zu aendern.',
		'- edit: eine aktive/erwaehnte Datei oder Selektion klein bis mittel aendern, strukturieren, formatieren, verbessern.',
		'- agent: mehrstufig arbeiten, recherchieren und danach Datei(en) aendern, vergleichen und einbauen.',
		'- plan: erst einen Plan liefern, noch nicht ausfuehren.',
		'JSON-Schema sinngemaess:',
		'{"mode":"ask|edit|agent|plan","confidence":0.0,"reason":"kurz","signals":["..."]}',
		'Wichtig: Wenn Datei-/Selektionskontext vorhanden ist und der Nutzer eine Folgeanweisung oder Aufgabe formuliert, waehle nicht vorschnell ask. Unterscheide Antwort, Entwurf, direkte Bearbeitung, Agent-Aufgabe und Plan anhand des gewuenschten Ergebnisses.',
		'Kontextflags:',
		JSON.stringify({
			hasActiveFile: Boolean(input.hasActiveFile),
			hasSelection: Boolean(input.hasSelection),
			hasMentionedFiles: Boolean(input.hasMentionedFiles),
			webSearchEnabled: Boolean(input.webSearchEnabled),
			baseMode: input.baseMode,
			baseConfidence: input.baseConfidence,
			baseSignals: input.baseSignals ?? [],
		}),
		'Nutzertext:',
		input.message,
	].join('\n');
}

export function parseIntentClassifierResult(text: string): IntentClassifierResult | null {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) return null;
	try {
		const parsed = JSON.parse(match[0]) as Partial<IntentClassifierResult>;
		if (!parsed.mode || !VALID_MODES.has(parsed.mode)) return null;
		const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
		return {
			mode: parsed.mode,
			confidence: Math.max(0, Math.min(1, confidence)),
			reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 180) : 'LLM-Classifier',
			signals: Array.isArray(parsed.signals) ? parsed.signals.map(String).slice(0, 8) : [],
		};
	} catch {
		return null;
	}
}

export function applyClassifierResult(
	base: RouterResult,
	classification: IntentClassifierResult,
	input: IntentClassifierInput,
): RouterResult {
	if (classification.confidence < 0.65) return base;

	const hasWritableContext = Boolean(input.hasActiveFile || input.hasSelection || input.hasMentionedFiles);
	if ((classification.mode === 'edit' || classification.mode === 'agent') && !hasWritableContext) {
		return {
			...base,
			reason: `${base.reason}; Classifier wollte ${classification.mode}, aber ohne Datei-/Selektionskontext blockiert`,
			signals: [...(base.signals ?? []), 'classifier_blocked_no_file_context'],
		};
	}
	const canOverrideBase =
		base.confidence === 'low' ||
		(base.mode === 'ask' && base.confidence === 'med' && classification.confidence >= 0.85 && hasWritableContext);
	if (!canOverrideBase) return base;

	return {
		...modeConfig(classification.mode),
		mode: classification.mode,
		confidence: classification.confidence >= 0.85 ? 'high' : 'med',
		reason: `KI-Classifier: ${classification.reason}`,
		signals: ['llm_classifier', ...classification.signals],
	};
}

export function shouldRunIntentClassifier(
	base: RouterResult,
	input: IntentClassifierInput,
): boolean {
	if (base.confidence === 'low') return true;
	const hasFileContext = Boolean(input.hasActiveFile || input.hasSelection || input.hasMentionedFiles);
	if (!hasFileContext || base.mode !== 'ask') return false;
	const normalized = input.message.toLowerCase().trim();
	const looksLikePlainQuestion =
		/[?؟]\s*$/.test(normalized) ||
		/\b(was|warum|wieso|wie|wann|wo|wer|welche|findest du|erkläre|erklaere|explain|what|why|how)\b/u.test(normalized);
	const looksLikeFollowupTask =
		/\b(das|es|so|genau|passt|okay|ok|übernimm|uebernimm|schreib|schreibe|speicher|speichere|mach|mache|setz|setze|nimm|nehme|bitte)\b/u.test(normalized);
	return looksLikeFollowupTask && !looksLikePlainQuestion;
}

export function learnIntentPattern(
	patterns: LearnedIntentPattern[],
	message: string,
	mode: UIMode,
	confidence = 1,
	now = Date.now(),
): LearnedIntentPattern[] {
	const key = normalizeIntentPattern(message);
	if (!key) return patterns;
	const next = patterns.map(entry => ({
		...entry,
		counts: { ...entry.counts },
	}));
	const existing = next.find(entry => entry.key === key);
	const increment = confidence >= 0.85 ? 2 : 1;
	if (existing) {
		existing.counts[mode] = (existing.counts[mode] ?? 0) + increment;
		existing.example = message.slice(0, 220);
		existing.updatedAt = now;
	} else {
		next.push({
			key,
			example: message.slice(0, 220),
			counts: { [mode]: increment },
			updatedAt: now,
		});
	}
	return next
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, 200);
}

export function getLearnedIntent(
	patterns: LearnedIntentPattern[] | undefined,
	message: string,
): { mode: UIMode; count: number; total: number; key: string } | null {
	const key = normalizeIntentPattern(message);
	const entry = patterns?.find(item => item.key === key);
	if (!entry) return null;
	let best: { mode: UIMode; count: number } | null = null;
	let total = 0;
	for (const [mode, count] of Object.entries(entry.counts) as Array<[UIMode, number | undefined]>) {
		const value = count ?? 0;
		total += value;
		if (!best || value > best.count) best = { mode, count: value };
	}
	if (!best || best.count < 2) return null;
	return { ...best, total, key };
}

function modeConfig(mode: UIMode): Pick<RouterResult, 'needsPlanner' | 'allowWrites' | 'maxRetrievedChunks'> {
	const cfg: Record<UIMode, Pick<RouterResult, 'needsPlanner' | 'allowWrites' | 'maxRetrievedChunks'>> = {
		ask:   { needsPlanner: false, allowWrites: false, maxRetrievedChunks: 5  },
		edit:  { needsPlanner: false, allowWrites: true,  maxRetrievedChunks: 3  },
		agent: { needsPlanner: true,  allowWrites: true,  maxRetrievedChunks: 10 },
		plan:  { needsPlanner: true,  allowWrites: false, maxRetrievedChunks: 10 },
	};
	return cfg[mode];
}
