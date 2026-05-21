import type { ContextItem } from '../agent/types';

export function estimateTokens(text: string): number {
	if (!text) return 0;
	// ~3 chars per token (conservative for German + code + markdown)
	return Math.ceil(text.length / 3);
}

type DegradeMode = 'full' | 'trimmed' | 'outline' | 'focused' | 'drop';
type ContextBudgetProfile = {
	hardCap: number;
	softCap: number;
	elasticity: number;
	degradeMode: DegradeMode;
};

const TYPE_BUDGET: Partial<Record<string, ContextBudgetProfile>> = {
	agent_md: { hardCap: 2400, softCap: 4000, elasticity: 0.4, degradeMode: 'trimmed' },
	working_memory: { hardCap: 1800, softCap: 3000, elasticity: 0.5, degradeMode: 'trimmed' },
	working_memory_structured: { hardCap: 1400, softCap: 2200, elasticity: 0.4, degradeMode: 'trimmed' },
	user_preferences: { hardCap: 1000, softCap: 1800, elasticity: 0.35, degradeMode: 'trimmed' },
	selected_text: { hardCap: 6000, softCap: 20000, elasticity: 1, degradeMode: 'trimmed' },
	input_reference: { hardCap: 4000, softCap: 15000, elasticity: 0.9, degradeMode: 'outline' },
	retrieved_chunk: { hardCap: 3500, softCap: 12000, elasticity: 0.8, degradeMode: 'trimmed' },
	frontmatter_context: { hardCap: 1500, softCap: 3200, elasticity: 0.45, degradeMode: 'trimmed' },
	backlink_context: { hardCap: 1200, softCap: 3000, elasticity: 0.35, degradeMode: 'trimmed' },
	forward_link_context: { hardCap: 1200, softCap: 3000, elasticity: 0.35, degradeMode: 'trimmed' },
	active_file: { hardCap: 5000, softCap: 15000, elasticity: 1, degradeMode: 'outline' },
	manual_file: { hardCap: 4000, softCap: 15000, elasticity: 0.9, degradeMode: 'outline' },
	vault_map: { hardCap: 1200, softCap: 3000, elasticity: 0.3, degradeMode: 'trimmed' },
};
const MAX_FOLDER_FILES           = 5;
const MAX_FOLDER_CHARS_PER_FILE  = 8_000;
const MAX_VAULT_INDEX_FILES      = 500;

// For edit tasks: target file gets budget first, secondary context is tightly capped
const CONTEXT_PRIORITY: Record<string, number> = {
	agent_md: 0, working_memory: 1, working_memory_structured: 2, selected_text: 3, input_reference: 4,
	user_preferences: 3, frontmatter_context: 4, retrieved_chunk: 5, active_file: 6, manual_file: 7, backlink_context: 8, forward_link_context: 9, folder: 10, vault_index: 11, vault_map: 12, web_result: 13,
};

const CONTEXT_PRIORITY_EDIT: Record<string, number> = {
	active_file: 0, manual_file: 1, selected_text: 2, input_reference: 3,
	working_memory_structured: 4, working_memory: 5, agent_md: 6, user_preferences: 7,
	retrieved_chunk: 8, frontmatter_context: 9,
	backlink_context: 20, forward_link_context: 20, folder: 30, vault_index: 30, vault_map: 99, web_result: 30,
};

// Tighter caps for secondary context in edit tasks — the file being edited matters most
const EDIT_BUDGET_OVERRIDES: Partial<Record<string, Partial<ContextBudgetProfile>>> = {
	active_file:               { hardCap: 8000, softCap: 18000, degradeMode: 'focused' },
	manual_file:               { hardCap: 7000, softCap: 18000, degradeMode: 'focused' },
	working_memory_structured: { hardCap: 600,  softCap: 900   },
	working_memory:            { hardCap: 800,  softCap: 1200  },
	agent_md:                  { hardCap: 800,  softCap: 1200  },
	user_preferences:          { hardCap: 600,  softCap: 900   },
};

function trimText(text: string, maxChars: number): string {
	if (!text || text.length <= maxChars) return text;
	return text.slice(0, maxChars) + '\n\n[... truncated by context budget ...]';
}

function outlineText(text: string, maxChars: number): string {
	const lines = text.split('\n');
	const kept: string[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? '';
		if (/^#{1,6}\s/.test(line) || index < 6) kept.push(line);
		else if (line.trim() && kept.length > 0 && kept[kept.length - 1]?.trim().startsWith('#')) kept.push(line.trim().split(/(?<=[.!?])\s+/)[0] ?? line.trim());
		if (kept.join('\n').length >= maxChars) break;
	}
	const joined = kept.join('\n').trim();
	return joined.length > maxChars ? trimText(joined, maxChars) : `${joined}\n\n[outline mode]`;
}

// Query-centric extract: keeps sections relevant to the query plus heading-only lines for others.
function focusedText(text: string, query: string, maxChars: number): string {
	const queryTerms = query
		.toLowerCase()
		.replace(/[^\w\s]/g, ' ')
		.split(/\s+/)
		.filter(t => t.length > 3);

	if (!queryTerms.length) return outlineText(text, maxChars);

	// Split into heading-bounded sections
	const lines = text.split('\n');
	const sections: Array<{ startLine: number; content: string }> = [];
	let secStart = 0;

	for (let i = 1; i <= lines.length; i++) {
		const line = lines[i] ?? '';
		if (i === lines.length || /^#{1,6}\s/.test(line)) {
			sections.push({ startLine: secStart, content: lines.slice(secStart, i).join('\n') });
			secStart = i;
		}
	}

	// Score each section by query term overlap
	const scored = sections.map((sec, idx) => ({
		idx,
		sec,
		score: queryTerms.reduce((s, t) => s + (sec.content.toLowerCase().includes(t) ? 1 : 0), 0),
	}));

	if (scored.every(s => s.score === 0)) return outlineText(text, maxChars);

	// Include relevant sections and their immediate neighbors for context
	const fullSet = new Set<number>();
	for (const { idx, score } of scored) {
		if (score > 0) {
			fullSet.add(Math.max(0, idx - 1));
			fullSet.add(idx);
			fullSet.add(Math.min(sections.length - 1, idx + 1));
		}
	}

	const parts: string[] = [];
	let usedChars = 0;
	let prevFull = false;

	for (let i = 0; i < sections.length; i++) {
		if (usedChars >= maxChars) break;
		const sec = sections[i]!;
		if (fullSet.has(i)) {
			if (!prevFull && parts.length > 0) parts.push('[...]');
			const available = maxChars - usedChars;
			const chunk = sec.content.length <= available ? sec.content : trimText(sec.content, available);
			parts.push(chunk);
			usedChars += chunk.length;
			prevFull = true;
		} else {
			// Show only the heading line for skipped sections
			const firstLine = sec.content.split('\n')[0] ?? '';
			if (/^#{1,6}\s/.test(firstLine)) {
				parts.push(firstLine);
				usedChars += firstLine.length + 1;
			}
			prevFull = false;
		}
	}

	const result = parts.join('\n').trim();
	return result.length > maxChars
		? trimText(result, maxChars)
		: `${result}\n\n[focused mode]`;
}

function degradeText(text: string, profile: ContextBudgetProfile, maxChars: number, query?: string): string | undefined {
	if (!text) return text;
	if (profile.degradeMode === 'drop') return undefined;
	if (profile.degradeMode === 'outline') return outlineText(text, maxChars);
	if (profile.degradeMode === 'focused') return focusedText(text, query ?? '', maxChars);
	if (profile.degradeMode === 'trimmed') return trimText(text, maxChars);
	return text;
}

export type CompactBudgetOptions = {
	intent?: string;
	query?: string;
};

export function compactContextForBudget(context: ContextItem[], maxContextChars: number, options?: CompactBudgetOptions): ContextItem[] {
	const isEdit = options?.intent === 'edit';
	const query = options?.query ?? '';

	// Drop vault_map entirely for edit tasks — it wastes budget on navigation context
	const filtered = isEdit
		? context.filter(item => item.type !== 'vault_map')
		: context;

	const priorityTable = isEdit ? CONTEXT_PRIORITY_EDIT : CONTEXT_PRIORITY;
	const sorted = [...filtered].sort(
		(a, b) => (priorityTable[a.type] ?? 99) - (priorityTable[b.type] ?? 99),
	);

	const packed: ContextItem[] = [];
	let used = 0;
	let softProfiles: Array<{ index: number; profile: ContextBudgetProfile }> = [];
	let retrievedChunkCount = 0;

	for (const item of sorted) {
		if (used >= maxContextChars) break;

		// Edit tasks need targeted chunks, not broad retrieval
		if (isEdit && item.type === 'retrieved_chunk') {
			if (retrievedChunkCount >= 2) continue;
			retrievedChunkCount++;
		}

		const clone: ContextItem = { ...item };
		const baseProfile = TYPE_BUDGET[item.type];
		const profile: ContextBudgetProfile | undefined = isEdit && baseProfile
			? { ...baseProfile, ...(EDIT_BUDGET_OVERRIDES[item.type] ?? {}) } as ContextBudgetProfile
			: baseProfile;

		if (profile && clone.content) {
			const effectiveMode = profile.degradeMode === 'full' ? 'trimmed' : profile.degradeMode;
			clone.content = degradeText(clone.content, { ...profile, degradeMode: effectiveMode }, profile.hardCap, query);
		}

		if (clone.type === 'folder' && clone.files) {
			clone.files = clone.files.slice(0, MAX_FOLDER_FILES).map(f => ({
				...f,
				content: f.content ? trimText(f.content, MAX_FOLDER_CHARS_PER_FILE) : undefined,
			}));
		}

		if (clone.type === 'vault_index' && clone.files) {
			clone.files = clone.files
				.slice(0, MAX_VAULT_INDEX_FILES)
				.map(f => ({ path: f.path, name: f.name }));
		}

		const size = JSON.stringify(clone).length;
		if (used + size > maxContextChars) break;
		used += size;
		packed.push(clone);
		// Don't soft-expand focused items — they're already query-targeted
		if (profile && profile.degradeMode !== 'focused') softProfiles.push({ index: packed.length - 1, profile });
	}

	const remaining = Math.max(0, maxContextChars - used);
	if (remaining <= 0) return packed;

	const totalElasticity = softProfiles.reduce((sum, item) => sum + item.profile.elasticity, 0) || 1;
	for (const item of softProfiles) {
		const contextItem = packed[item.index];
		if (!contextItem?.content) continue;
		const allocation = Math.floor(remaining * (item.profile.elasticity / totalElasticity));
		const targetChars = Math.min(item.profile.softCap, item.profile.hardCap + allocation);
		contextItem.content = degradeText(contextItem.content, item.profile, targetChars, query);
	}

	return packed;
}

export function estimatePayloadTokens(payload: {
	message: string;
	history: Array<{ content: string }>;
	context: ContextItem[];
	toolResults?: unknown[];
	systemPrompt?: string;
	maxOutputTokens?: number;
}): number {
	return (
		estimateTokens(payload.systemPrompt ?? '') +
		estimateTokens(payload.message) +
		payload.history.reduce((sum, m) => sum + estimateTokens(m.content), 0) +
		estimateTokens(JSON.stringify(payload.context)) +
		estimateTokens(JSON.stringify(payload.toolResults ?? [])) +
		(payload.maxOutputTokens ?? 0)
	);
}
