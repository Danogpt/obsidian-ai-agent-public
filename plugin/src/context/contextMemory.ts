import { estimateTokens } from '../limits/tokenBudget';
import type { ContextItem, ToolResult } from '../agent/types';
import type {
	ChatMessage,
	ChatThread,
	WorkingMemoryArtifact,
	WorkingMemoryConstraint,
	WorkingMemoryData,
	WorkingMemoryDecision,
	WorkingMemoryNextStep,
	WorkingMemoryPreference,
	WorkingMemoryQuestion,
	WorkingMemoryRelevantFile,
} from '../chat/chatStore';

const RECENT_HISTORY_COUNT = 6;
const SUMMARY_TRIGGER_MESSAGES = 10;
const SUMMARY_TRIGGER_TOKENS = 2200;
const MAX_SUMMARY_CHARS = 2400;
const MAX_TOOL_RESULTS = 3;
const MAX_TOOL_TEXT = 4000;
const MAX_READ_TOOL_TEXT = 24000;
const MAX_TOOL_ERROR = 300;
const HISTORY_TOOL_BONUS = 500;

function trim(text: string, maxChars: number): string {
	return text.length > maxChars ? text.slice(0, maxChars) + '...' : text;
}

function ensureWorkingMemoryData(thread: ChatThread): WorkingMemoryData {
	return thread.workingMemoryData ?? {
		goal: '',
		decisions: [],
		artifacts: [],
		open_questions: [],
		constraints: [],
		user_preferences: [],
		relevant_files: [],
		next_steps: [],
	};
}

function inferArtifactActionFromTool(tool: string): WorkingMemoryArtifact['action'] {
	return tool === 'delete_file' ? 'deleted' :
		tool === 'write_file' ? 'created' :
		'patched';
}

function upsertArtifact(data: WorkingMemoryData, artifact: WorkingMemoryArtifact) {
	const existingIdx = data.artifacts.findIndex(a => a.path === artifact.path && a.action === artifact.action);
	if (existingIdx >= 0) {
		data.artifacts[existingIdx] = artifact;
	} else {
		data.artifacts = [...data.artifacts, artifact].slice(-10);
	}
}

function upsertRelevantFile(data: WorkingMemoryData, fileEntry: WorkingMemoryRelevantFile) {
	const fileIdx = data.relevant_files.findIndex(f => f.path === fileEntry.path);
	if (fileIdx >= 0) {
		data.relevant_files[fileIdx] = fileEntry;
	} else {
		data.relevant_files = [...data.relevant_files, fileEntry].slice(-10);
	}
}

function upsertDecision(data: WorkingMemoryData, decision: WorkingMemoryDecision) {
	const key = `${decision.turn_id}:${decision.claim}`;
	const existing = data.decisions.findIndex(item => `${item.turn_id}:${item.claim}` === key);
	if (existing >= 0) {
		data.decisions[existing] = decision;
	} else {
		data.decisions = [...data.decisions, decision].slice(-8);
	}
}

function upsertNextStep(data: WorkingMemoryData, nextStep: WorkingMemoryNextStep) {
	const key = `${nextStep.status}:${nextStep.step}`;
	const existing = data.next_steps.findIndex(item => `${item.status}:${item.step}` === key);
	if (existing >= 0) {
		data.next_steps[existing] = nextStep;
	} else {
		data.next_steps = [...data.next_steps, nextStep].slice(-4);
	}
}

type ToolOutcomeInput = {
	tool: string;
	ok: boolean;
	path?: string;
	turnId?: string;
	error?: string;
};

// Directly records structured tool outcomes into working memory
// without waiting for the next refreshWorkingSummary cycle.
export function recordToolOutcome(thread: ChatThread, input: ToolOutcomeInput): void {
	const data = ensureWorkingMemoryData(thread);
	const turnId = input.turnId ?? `tool:${Date.now()}`;
	const path = input.path?.trim();

	if (path) {
		if (input.ok && ['write_file', 'patch_file', 'delete_file'].includes(input.tool)) {
			const action = inferArtifactActionFromTool(input.tool);
			upsertArtifact(data, { path, action, summary: `${action} via ${input.tool}` });
			upsertRelevantFile(data, {
				path,
				role: action === 'deleted' ? 'reference' : 'target',
				last_touched: Date.now(),
			});
			upsertDecision(data, {
				claim: `${input.tool} applied to ${path}`,
				turn_id: turnId,
			});
		} else if (input.ok && (input.tool === 'read_file' || input.tool === 'read_active_file')) {
			upsertRelevantFile(data, {
				path,
				role: 'reference',
				last_touched: Date.now(),
			});
		}
	}

	if (input.ok && input.tool === 'task_plan') {
		upsertNextStep(data, {
			step: 'Task plan accepted',
			status: 'in_progress',
		});
		upsertDecision(data, {
			claim: 'Plan phase completed and execution started',
			turn_id: turnId,
		});
	}

	if (!input.ok) {
		const detail = path ? `${input.tool} blocked for ${path}` : `${input.tool} blocked`;
		upsertNextStep(data, {
			step: detail,
			status: 'blocked',
		});
		if (input.error) {
			upsertDecision(data, {
				claim: trim(input.error.replace(/\s+/g, ' ').trim(), 180),
				turn_id: turnId,
			});
		}
	}

	thread.workingMemoryData = data;
}

function extractFileRefs(text: string): string[] {
	return Array.from(text.matchAll(/\b([A-Za-z0-9_\-./\\ ]+?\.md)\b/gi))
		.map(match => match[1]?.trim() ?? '')
		.filter(Boolean)
		.slice(0, 12);
}

function uniqueByKey<T>(items: T[], getKey: (item: T) => string): T[] {
	const seen = new Set<string>();
	const output: T[] = [];
	for (const item of items) {
		const key = getKey(item);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		output.push(item);
	}
	return output;
}

function migrateWorkingMemory(existing: WorkingMemoryData | undefined): WorkingMemoryData | undefined {
	if (!existing) return undefined;
	return {
		goal: existing.goal,
		sub_goal: existing.sub_goal,
		decisions: (existing.decisions ?? []).map(item => typeof item === 'string'
			? { claim: item, turn_id: 'legacy' }
			: item),
		open_questions: (existing.open_questions ?? []).map(item => typeof item === 'string'
			? { question: item, asked_of: 'user', turn_id: 'legacy' }
			: item),
		constraints: (existing.constraints ?? []).map(item => typeof item === 'string'
			? { constraint: item, source: 'user' }
			: item),
		user_preferences: (existing.user_preferences ?? []).map(item => typeof item === 'string'
			? { preference: item, evidence_turn_id: 'legacy' }
			: item),
		relevant_files: (existing.relevant_files ?? []).map(item => typeof item === 'string'
			? { path: item, role: 'reference' }
			: item),
		artifacts: (existing.artifacts ?? []).map(item => typeof item === 'string'
			? { path: item, action: 'modified', summary: item }
			: item),
		next_steps: (existing.next_steps ?? []).map(item => typeof item === 'string'
			? { step: item, status: 'pending' }
			: item),
	};
}

function extractDecisions(messages: ChatMessage[]): WorkingMemoryDecision[] {
	return messages
		.filter(msg =>
			msg.role === 'assistant' &&
			/\b(geaendert|geändert|umgestellt|entfernt|hinzugefuegt|hinzugefügt|nutze|verwende|modus|patch|write_file|delete_file|erstellt|geschrieben)\b/i.test(msg.content),
		)
		.slice(-6)
		.map(msg => ({
			claim: trim(msg.content.replace(/\s+/g, ' ').trim(), 180),
			rationale: /\b(weil|da|deshalb|darum)\b/i.test(msg.content)
				? trim(msg.content.replace(/\s+/g, ' ').trim(), 220)
				: undefined,
			turn_id: msg.id,
		}));
}

function extractOpenQuestions(messages: ChatMessage[]): WorkingMemoryQuestion[] {
	return messages
		.filter(msg =>
			msg.role === 'user' &&
			(/\?$/.test(msg.content.trim()) || /offen|unklar|frage|warum|wie|was/i.test(msg.content)),
		)
		.slice(-4)
		.map(msg => ({
			question: trim(msg.content.replace(/\s+/g, ' ').trim(), 180),
			asked_of: 'user' as const,
			turn_id: msg.id,
		}));
}

function extractConstraints(messages: ChatMessage[]): WorkingMemoryConstraint[] {
	return messages
		.filter(msg =>
			msg.role === 'user' &&
			/\b(soll|muss|nur|niemals|ohne|nicht|immer|bitte keine|kein)\b/i.test(msg.content),
		)
		.slice(-5)
		.map(msg => ({
			constraint: trim(msg.content.replace(/\s+/g, ' ').trim(), 180),
			source: 'user' as const,
		}));
}

function extractUserPreferences(messages: ChatMessage[]): WorkingMemoryPreference[] {
	return messages
		.filter(msg =>
			msg.role === 'user' &&
			/\b(lieber|bevorzuge|mag|moechte|möchte|wuensche|wünsche|style|format|kurz|ausfuehrlich|ausführlich|deutsch|english)\b/i.test(msg.content),
		)
		.slice(-4)
		.map(msg => ({
			preference: trim(msg.content.replace(/\s+/g, ' ').trim(), 140),
			evidence_turn_id: msg.id,
		}));
}

function inferArtifactAction(text: string): WorkingMemoryArtifact['action'] {
	if (/delete_file|geloescht|gelöscht|entfernt/i.test(text)) return 'deleted';
	if (/created|erstellt/i.test(text)) return 'created';
	if (/patch_file|gepatcht/i.test(text)) return 'patched';
	return 'modified';
}

function extractArtifactObjects(messages: ChatMessage[]): WorkingMemoryArtifact[] {
	const artifacts: WorkingMemoryArtifact[] = [];
	for (const msg of messages) {
		if (msg.role !== 'assistant') continue;
		const matches = msg.content.matchAll(/\b(write_file|patch_file|delete_file)\b.*?`?([A-Za-z0-9_\-./\\ ]+?\.md)`?/gi);
		for (const match of matches) {
			const path = match[2]?.trim();
			if (!path) continue;
			artifacts.push({
				path,
				action: inferArtifactAction(match[1] ?? msg.content),
				summary: trim(msg.content.replace(/\s+/g, ' ').trim(), 180),
			});
		}
	}
	return artifacts;
}

function inferFileRoleFromContent(content: string): WorkingMemoryRelevantFile['role'] {
	if (/\b(zieldatei|target|schreibe in|aendere|ändere|patch|rewrite|update)\b/i.test(content)) return 'target';
	if (/\b(quelle|source|referenz|siehe|verwende)\b/i.test(content)) return 'source';
	return 'reference';
}

function extractRelevantFiles(messages: ChatMessage[]): WorkingMemoryRelevantFile[] {
	const files: WorkingMemoryRelevantFile[] = [];
	for (const msg of messages) {
		for (const path of extractFileRefs(msg.content)) {
			files.push({
				path,
				role: inferFileRoleFromContent(msg.content),
				last_touched: msg.createdAt,
			});
		}
	}
	return files;
}

function extractNextSteps(messages: ChatMessage[]): WorkingMemoryNextStep[] {
	const inferStatus = (msg: ChatMessage): WorkingMemoryNextStep['status'] => {
		if (msg.role !== 'assistant') return 'pending';
		if (/\b(als naechstes|als nächstes|next|danach|ich werde|plan)\b/i.test(msg.content)) return 'in_progress';
		if (/\b(erledigt|fertig|done|abgeschlossen)\b/i.test(msg.content)) return 'done';
		if (/\b(blockiert|warte|unklar|frage offen)\b/i.test(msg.content)) return 'blocked';
		return 'pending';
	};

	return messages
		.slice(-4)
		.map(msg => ({
			step: trim(msg.content.replace(/\s+/g, ' ').trim(), 160),
			status: inferStatus(msg),
		}))
		.filter(item => item.step);
}

function buildStructuredMemory(
	messages: ChatMessage[],
	existing: WorkingMemoryData | undefined,
): WorkingMemoryData {
	const migrated = migrateWorkingMemory(existing);
	const userMessages = messages.filter(msg => msg.role === 'user');

	const goal = migrated?.goal
		?? (userMessages[0]?.content ? trim(userMessages[0].content.replace(/\s+/g, ' ').trim(), 220) : '');

	const lastUserMsg = userMessages[userMessages.length - 1];
	const sub_goal = lastUserMsg && lastUserMsg !== userMessages[0]
		? trim(lastUserMsg.content.replace(/\s+/g, ' ').trim(), 180)
		: undefined;

	const decisions = uniqueByKey(
		[...(migrated?.decisions ?? []), ...extractDecisions(messages)],
		item => `${item.turn_id}:${item.claim}`,
	).slice(-8);

	const artifacts = uniqueByKey(
		[...(migrated?.artifacts ?? []), ...extractArtifactObjects(messages)],
		item => `${item.path}:${item.action}:${item.summary}`,
	).slice(-10);

	const open_questions = uniqueByKey(
		[...(migrated?.open_questions ?? []), ...extractOpenQuestions(messages)],
		item => `${item.turn_id}:${item.question}`,
	).slice(-4);

	const constraints = uniqueByKey(
		[...(migrated?.constraints ?? []), ...extractConstraints(messages)],
		item => `${item.source}:${item.constraint}`,
	).slice(-5);

	const user_preferences = uniqueByKey(
		[...(migrated?.user_preferences ?? []), ...extractUserPreferences(messages)],
		item => `${item.evidence_turn_id}:${item.preference}`,
	).slice(-4);

	const relevant_files = uniqueByKey(
		[...(migrated?.relevant_files ?? []), ...extractRelevantFiles(messages)],
		item => item.path,
	).slice(-10);

	const next_steps = uniqueByKey(
		[...(migrated?.next_steps ?? []), ...extractNextSteps(messages)],
		item => `${item.status}:${item.step}`,
	).slice(-4);

	return {
		goal,
		sub_goal,
		decisions,
		open_questions,
		constraints,
		user_preferences,
		relevant_files,
		artifacts,
		next_steps,
	};
}

function renderWorkingMemory(data: WorkingMemoryData): string {
	const stable: string[] = [];
	if (data.goal) stable.push(`Ziel: ${data.goal}`);
	if (data.decisions.length) stable.push(`Entscheidungen:\n- ${data.decisions.map(item => item.claim).join('\n- ')}`);
	if (data.artifacts.length) stable.push(`Bearbeitete Dateien:\n- ${data.artifacts.map(item => `${item.path} (${item.action})`).join('\n- ')}`);
	if (data.relevant_files.length) stable.push(`Relevante Dateien:\n- ${data.relevant_files.map(item => `${item.path} [${item.role}]`).join('\n- ')}`);

	const current: string[] = [];
	if (data.sub_goal) current.push(`Aktuelles Teilziel: ${data.sub_goal}`);
	if (data.open_questions.length) current.push(`Offene Fragen:\n- ${data.open_questions.map(item => item.question).join('\n- ')}`);
	if (data.constraints.length) current.push(`Constraints:\n- ${data.constraints.map(item => item.constraint).join('\n- ')}`);
	if (data.user_preferences.length) current.push(`Nutzerpraeferenzen:\n- ${data.user_preferences.map(item => item.preference).join('\n- ')}`);
	if (data.next_steps.length) current.push(`Naechste Schritte:\n- ${data.next_steps.map(item => `${item.step} [${item.status}]`).join('\n- ')}`);

	const parts: string[] = [];
	if (stable.length) parts.push(`<stable>\n${stable.join('\n\n')}\n</stable>`);
	if (current.length) parts.push(`<current>\n${current.join('\n\n')}\n</current>`);
	return trim(parts.join('\n'), MAX_SUMMARY_CHARS);
}

function renderStructuredWorkingMemory(data: WorkingMemoryData): string {
	const lines: string[] = [
		'goal:',
		`  ${data.goal || '-'}`,
		'sub_goal:',
		`  ${data.sub_goal || '-'}`,
		'decisions:',
	];
	for (const item of data.decisions) {
		lines.push(`  - claim: ${item.claim}`);
		lines.push(`    turn_id: ${item.turn_id}`);
		if (item.rationale) lines.push(`    rationale: ${item.rationale}`);
	}
	if (!data.decisions.length) lines.push('  -');

	lines.push('open_questions:');
	for (const item of data.open_questions) {
		lines.push(`  - question: ${item.question}`);
		lines.push(`    asked_of: ${item.asked_of}`);
		lines.push(`    turn_id: ${item.turn_id}`);
	}
	if (!data.open_questions.length) lines.push('  -');

	lines.push('constraints:');
	for (const item of data.constraints) {
		lines.push(`  - constraint: ${item.constraint}`);
		lines.push(`    source: ${item.source}`);
	}
	if (!data.constraints.length) lines.push('  -');

	lines.push('user_preferences:');
	for (const item of data.user_preferences) {
		lines.push(`  - preference: ${item.preference}`);
		lines.push(`    evidence_turn_id: ${item.evidence_turn_id}`);
	}
	if (!data.user_preferences.length) lines.push('  -');

	lines.push('relevant_files:');
	for (const item of data.relevant_files) {
		lines.push(`  - path: ${item.path}`);
		lines.push(`    role: ${item.role}`);
		if (item.last_touched) lines.push(`    last_touched: ${item.last_touched}`);
	}
	if (!data.relevant_files.length) lines.push('  -');

	lines.push('artifacts:');
	for (const item of data.artifacts) {
		lines.push(`  - path: ${item.path}`);
		lines.push(`    action: ${item.action}`);
		lines.push(`    summary: ${item.summary}`);
	}
	if (!data.artifacts.length) lines.push('  -');

	lines.push('next_steps:');
	for (const item of data.next_steps) {
		lines.push(`  - step: ${item.step}`);
		lines.push(`    status: ${item.status}`);
	}
	if (!data.next_steps.length) lines.push('  -');

	return trim(lines.join('\n'), MAX_SUMMARY_CHARS);
}

export function refreshWorkingSummary(thread: ChatThread): boolean {
	const conversational = thread.messages.filter(msg => msg.role === 'user' || msg.role === 'assistant');
	const olderMessages = conversational.slice(0, Math.max(0, conversational.length - RECENT_HISTORY_COUNT));
	const olderTokens = olderMessages.reduce((sum, msg) => sum + estimateTokens(msg.content), 0);
	const shouldSummarize = olderMessages.length >= SUMMARY_TRIGGER_MESSAGES || olderTokens >= SUMMARY_TRIGGER_TOKENS;

	if (!shouldSummarize) {
		const changed = Boolean(thread.workingSummary || thread.archivedMessageCount);
		thread.workingSummary = undefined;
		thread.workingSummaryUpdatedAt = undefined;
		thread.archivedMessageCount = undefined;
		thread.workingMemoryData = undefined;
		return changed;
	}

	const memoryData = buildStructuredMemory(olderMessages, thread.workingMemoryData);
	const summary = renderWorkingMemory(memoryData);
	const changed =
		thread.workingSummary !== summary ||
		thread.archivedMessageCount !== olderMessages.length;

	thread.workingMemoryData = memoryData;
	thread.workingSummary = summary;
	thread.workingSummaryUpdatedAt = Date.now();
	thread.archivedMessageCount = olderMessages.length;
	return changed;
}

export function buildWorkingMemoryContext(thread: ChatThread): ContextItem[] {
	if (!thread.workingMemoryData) return [];
	const summary = thread.workingSummary ?? renderWorkingMemory(thread.workingMemoryData);
	return [{
		type: 'working_memory',
		label: `Arbeitszusammenfassung (${thread.archivedMessageCount ?? 0} Nachrichten archiviert)`,
		content: summary,
		summary: thread.workingMemoryData.goal || undefined,
		stats: {
			decisions: thread.workingMemoryData.decisions.length,
			artifacts: thread.workingMemoryData.artifacts.length,
			next_steps: thread.workingMemoryData.next_steps.length,
		},
	}, {
		type: 'working_memory_structured',
		label: 'Strukturiertes Arbeitsgedaechtnis',
		content: renderStructuredWorkingMemory(thread.workingMemoryData),
		summary: thread.workingMemoryData.sub_goal || thread.workingMemoryData.goal || undefined,
	}];
}

export function buildCompactHistory(thread: ChatThread, maxTokenBudget = 2800) {
	const all: Array<{ role: 'user' | 'assistant'; content: string }> = thread.messages
		.filter(msg => msg.role === 'user' || msg.role === 'assistant')
		.map(msg => ({ role: msg.role, content: msg.content }));

	if (all.length === 0) return [];

	const guaranteed = all.slice(-Math.min(2, all.length));
	const candidates = all.slice(0, all.length - guaranteed.length);

	let usedTokens = guaranteed.reduce((sum, item) => sum + estimateTokens(item.content), 0);
	const older: typeof all = [];

	for (let i = candidates.length - 1; i >= 0; i--) {
		const msg = candidates[i];
		if (!msg) continue;
		const tokens = estimateTokens(msg.content);
		const containsToolFlow = /read_file|write_file|patch_file|delete_file|search_vault|query_dataview|task_plan|edit_plan|tool/i.test(msg.content);
		const effectiveBudget = containsToolFlow ? maxTokenBudget + HISTORY_TOOL_BONUS : maxTokenBudget;
		if (usedTokens + tokens > effectiveBudget) break;
		older.unshift(msg);
		usedTokens += tokens;
	}

	return [...older, ...guaranteed];
}

function compactUnknownResult(result: unknown, textLimit = MAX_TOOL_TEXT): unknown {
	if (typeof result === 'string') return trim(result, textLimit);
	if (!result || typeof result !== 'object') return result;
	if (Array.isArray(result)) {
		const arrayResult: unknown[] = result;
		return arrayResult.slice(-2).map(item => compactUnknownResult(item, textLimit));
	}

	const clone: Record<string, unknown> = { ...result };

	if (typeof clone['content'] === 'string') {
		clone['content'] = trim(clone['content'], textLimit);
	}

	if (Array.isArray(clone['files'])) {
		clone['files'] = (clone['files'] as Array<Record<string, unknown>>)
			.slice(0, 3)
			.map(file => ({
				path: file.path,
				name: file.name,
				content: typeof file.content === 'string' ? trim(file.content, 2000) : undefined,
				snippet: typeof file.snippet === 'string' ? trim(file.snippet, 500) : undefined,
			}));
	}

	return clone;
}

export function compactToolResults(results: ToolResult[]): ToolResult[] {
	const latestOpenAIResponseId = getLatestOpenAIResponseId(results);
	const keepFromIndex = Math.max(0, results.length - MAX_TOOL_RESULTS);
	return results.filter((result, index) => {
		if (index >= keepFromIndex) return true;
		if (!latestOpenAIResponseId) return false;
		return getOpenAIResponseId(result) === latestOpenAIResponseId;
	}).map(result => ({
		...result,
		error: result.error ? trim(result.error, MAX_TOOL_ERROR) : result.error,
		result: compactUnknownResult(
			result.result,
			result.tool === 'read_file' || result.tool === 'read_active_file' ? MAX_READ_TOOL_TEXT : MAX_TOOL_TEXT,
		),
	}));
}

function getOpenAIResponseId(result: ToolResult): string | undefined {
	const value = result.provider_context?.['openai_response_id'];
	return typeof value === 'string' && value ? value : undefined;
}

function getLatestOpenAIResponseId(results: ToolResult[]): string | undefined {
	for (let index = results.length - 1; index >= 0; index--) {
		const result = results[index];
		if (!result) continue;
		const responseId = getOpenAIResponseId(result);
		if (responseId) return responseId;
	}
	return undefined;
}
