import type { ProviderName } from '../models/modelRegistry';
import type { TaskPlan } from '../agent/types';

export type ContextMode = 'active_file' | 'selected_text' | 'manual_files' | 'folder' | 'vault' | 'none';

export type UIMode = 'ask' | 'edit' | 'agent' | 'plan';

export type ChatMessage = {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	createdAt: number;
	modelId?: string;
	provider?: ProviderName;
};

export type WorkingMemoryDecision = {
	claim: string;
	rationale?: string;
	turn_id: string;
};

export type WorkingMemoryQuestion = {
	question: string;
	asked_of: 'user' | 'self';
	turn_id: string;
};

export type WorkingMemoryConstraint = {
	constraint: string;
	source: 'user' | 'agent_md' | 'inferred';
};

export type WorkingMemoryPreference = {
	preference: string;
	evidence_turn_id: string;
};

export type WorkingMemoryRelevantFile = {
	path: string;
	role: 'source' | 'target' | 'reference';
	last_touched?: number;
};

export type WorkingMemoryArtifact = {
	path: string;
	action: 'created' | 'modified' | 'patched' | 'deleted';
	summary: string;
};

export type WorkingMemoryNextStep = {
	step: string;
	status: 'pending' | 'in_progress' | 'blocked' | 'done';
};

export type WorkingMemoryData = {
	goal: string;
	sub_goal?: string;
	decisions: WorkingMemoryDecision[];
	open_questions: WorkingMemoryQuestion[];
	constraints: WorkingMemoryConstraint[];
	user_preferences: WorkingMemoryPreference[];
	relevant_files: WorkingMemoryRelevantFile[];
	artifacts: WorkingMemoryArtifact[];
	next_steps: WorkingMemoryNextStep[];
};

export type ChatThread = {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	archived: boolean;
	selectedModelId: string;

	// Context state (optional for backwards-compat with old saved threads)
	uiMode?: UIMode;
	contextMode?: ContextMode;       // legacy single-mode — use getEffectiveModes()
	contextModes?: ContextMode[];    // multi-mode (new); wins over contextMode when set
	activeFilePath?: string;         // optional pinned path — leave undefined to follow workspace
	manualFilePaths?: string[];
	folderPath?: string;
	includeAgentMd?: boolean;
	workingSummary?: string;
	workingSummaryUpdatedAt?: number;
	archivedMessageCount?: number;
	workingMemoryData?: WorkingMemoryData;
	pendingTaskPlan?: TaskPlan;
	pendingTaskPlanCreatedAt?: number;

	messages: ChatMessage[];
};

export type ChatStoreData = {
	activeThreadId: string | null;
	threads: ChatThread[];
};

export const DEFAULT_CHAT_STORE: ChatStoreData = {
	activeThreadId: null,
	threads: [],
};

export function newMessageId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/** Returns the active context modes for a thread, handling legacy single-mode threads. */
export function getEffectiveModes(thread: ChatThread): ContextMode[] {
	if (thread.contextModes?.length) return thread.contextModes;
	return [thread.contextMode ?? 'active_file'];
}

/** Persist a multi-mode selection, clearing the legacy field for consistency. */
export function setEffectiveModes(thread: ChatThread, modes: ContextMode[]): void {
	thread.contextModes = modes;
	thread.contextMode = modes[0];  // keep legacy field in sync for old code paths
}
