import type { ContextItem } from '../agent/types';
import type { ContextMode, UIMode } from '../chat/chatStore';

export type ContextDebugItem = {
	key: string;
	type: string;
	label: string;
	path?: string;
	included: boolean;
	rawChars: number;
	finalChars: number;
	mode: 'full' | 'trimmed' | 'focused' | 'outline' | 'dropped' | 'metadata';
	reason: string;
	reasons: string[];
	stats: Record<string, string | number | boolean | undefined>;
	files: number;
};

export type ContextDebugSnapshot = {
	mode: UIMode;
	modeReason: string;
	intentConfidence: string;
	intentSignals: string[];
	contextModes: ContextMode[];
	query: string;
	maxContextChars: number;
	estimatedTokens: number;
	items: ContextDebugItem[];
	summary: {
		rawItems: number;
		finalItems: number;
		rawChars: number;
		finalChars: number;
		droppedItems: number;
		trimmedItems: number;
	};
};

type BuildContextDebugSnapshotOptions = {
	rawContext: ContextItem[];
	finalContext: ContextItem[];
	contextModes: ContextMode[];
	query: string;
	maxContextChars: number;
	estimatedTokens: number;
	mode: UIMode;
	modeReason: string;
	intentConfidence: string;
	intentSignals?: string[];
};

function contextKey(item: ContextItem): string {
	return `${item.type}:${item.path ?? ''}:${item.label}`;
}

function contextChars(item: ContextItem): number {
	let chars = item.content?.length ?? 0;
	if (item.files?.length) {
		chars += item.files.reduce((sum, file) => sum + (file.content?.length ?? file.snippet?.length ?? 0), 0);
	}
	return chars;
}

function modeFor(raw: ContextItem, finalItem: ContextItem | undefined): ContextDebugItem['mode'] {
	if (!finalItem) return 'dropped';
	if (!raw.content && !raw.files?.length) return 'metadata';
	const content = finalItem.content ?? '';
	if (content.includes('[outline mode]')) return 'outline';
	if (content.includes('[focused mode]')) return 'focused';
	if (content.includes('[... truncated by context budget ...]')) return 'trimmed';
	return contextChars(finalItem) < contextChars(raw) ? 'trimmed' : 'full';
}

function reasonFor(mode: ContextDebugItem['mode'], item: ContextItem, rawChars: number, finalChars: number): string {
	if (mode === 'dropped') return 'Dropped by context budget, retrieval gate, mode scope, or maxRetrievedChunks.';
	if (mode === 'metadata') return 'Metadata-only context item.';
	if (mode === 'full') return 'Included fully.';
	if (mode === 'focused') return 'Focused around query-relevant sections.';
	if (mode === 'outline') return 'Reduced to outline.';
	if (mode === 'trimmed') {
		const gate = item.stats?.confidence_gate;
		if (typeof gate === 'string') return `Trimmed or shortened: ${gate}`;
		return `Trimmed from ${rawChars} to ${finalChars} chars.`;
	}
	return 'Included.';
}

export function buildContextDebugSnapshot(options: BuildContextDebugSnapshotOptions): ContextDebugSnapshot {
	const remainingFinal = [...options.finalContext];
	const items = options.rawContext.map(raw => {
		const key = contextKey(raw);
		const finalIndex = remainingFinal.findIndex(item => contextKey(item) === key);
		const finalItem = finalIndex >= 0 ? remainingFinal.splice(finalIndex, 1)[0] : undefined;
		const rawChars = contextChars(raw);
		const finalChars = finalItem ? contextChars(finalItem) : 0;
		const mode = modeFor(raw, finalItem);
		const effectiveItem = finalItem ?? raw;
		return {
			key,
			type: raw.type,
			label: raw.label,
			path: raw.path,
			included: Boolean(finalItem),
			rawChars,
			finalChars,
			mode,
			reason: reasonFor(mode, effectiveItem, rawChars, finalChars),
			reasons: effectiveItem.reasons ?? [],
			stats: effectiveItem.stats ?? {},
			files: effectiveItem.files?.length ?? 0,
		};
	});

	for (const item of remainingFinal) {
		const chars = contextChars(item);
		items.push({
			key: contextKey(item),
			type: item.type,
			label: item.label,
			path: item.path,
			included: true,
			rawChars: 0,
			finalChars: chars,
			mode: 'full',
			reason: 'Added after raw snapshot or generated during compaction.',
			reasons: item.reasons ?? [],
			stats: item.stats ?? {},
			files: item.files?.length ?? 0,
		});
	}

	const rawChars = options.rawContext.reduce((sum, item) => sum + contextChars(item), 0);
	const finalChars = options.finalContext.reduce((sum, item) => sum + contextChars(item), 0);
	return {
		mode: options.mode,
		modeReason: options.modeReason,
		intentConfidence: options.intentConfidence,
		intentSignals: options.intentSignals ?? [],
		contextModes: options.contextModes,
		query: options.query,
		maxContextChars: options.maxContextChars,
		estimatedTokens: options.estimatedTokens,
		items,
		summary: {
			rawItems: options.rawContext.length,
			finalItems: options.finalContext.length,
			rawChars,
			finalChars,
			droppedItems: items.filter(item => !item.included).length,
			trimmedItems: items.filter(item => ['trimmed', 'focused', 'outline'].includes(item.mode)).length,
		},
	};
}
