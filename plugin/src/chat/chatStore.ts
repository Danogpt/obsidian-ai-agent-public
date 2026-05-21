import type { ProviderName } from '../models/modelRegistry';

export type ContextMode = 'active_file' | 'selected_text' | 'manual_files' | 'folder' | 'vault' | 'none';

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
	contextMode?: ContextMode;
	manualFilePaths?: string[];
	folderPath?: string;
	includeAgentMd?: boolean;
	workingSummary?: string;
	workingSummaryUpdatedAt?: number;
	archivedMessageCount?: number;
	workingMemoryData?: WorkingMemoryData;

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
