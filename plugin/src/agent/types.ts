import type { ModelReasoningConfig, ProviderName } from '../models/modelRegistry';
import type { AgentMode } from '../tools/toolTypes';
import type { UIMode } from '../chat/chatStore';

export type { ProviderName };

export interface ProviderAuth {
	api_key?: string | null;
	base_url?: string | null;
}

export interface ChatOptions {
	thinking_mode: boolean;
	reasoning?: ModelReasoningConfig;
	web_search: boolean;
	vault_tools_enabled: boolean;
	stream: boolean;
	max_context_chars: number;
	max_output_tokens?: number;
	agent_mode?: AgentMode;
	execution_phase?: 'normal' | 'plan' | 'execute';
	style_profile?: string;
	template_hint?: string;
	edit_format_hint?: string;
	embedding_backend?: 'local' | 'openai' | 'gemini' | 'ollama';
	enable_style_critique?: boolean;
	native_tool_calling?: boolean;
	ui_mode?: UIMode;
	allowed_tool_names?: string[];
}

export type ContextItemType =
	| 'agent_md'
	| 'agent_memory'
	| 'working_memory'
	| 'working_memory_structured'
	| 'pending_task_plan'
	| 'user_preferences'
	| 'active_file'
	| 'selected_text'
	| 'manual_file'
	| 'input_reference'
	| 'retrieved_chunk'
	| 'frontmatter_context'
	| 'backlink_context'
	| 'forward_link_context'
	| 'folder'
	| 'vault_index'
	| 'vault_map'
	| 'web_result';

export interface ContextFile {
	path: string;
	name?: string;
	content?: string;
	snippet?: string;
	chunk_id?: string;
	block_type?: string;
	heading?: string;
	section_path?: string[];
	line_range?: [number, number];
	retrieval_reasons?: string[];
	retrieval_scores?: Record<string, number | undefined>;
}

export interface ContextItem {
	type: ContextItemType;
	label: string;
	path?: string;
	content?: string;
	files?: ContextFile[];
	summary?: string;
	reasons?: string[];
	stats?: Record<string, string | number | boolean | undefined>;
}

export interface HistoryMessage {
	role: 'user' | 'assistant';
	content: string;
}

export interface ToolCall {
	id: string;
	tool: string;
	args: Record<string, unknown>;
	reason?: string;
	thought_signature?: string;
	provider_context?: Record<string, unknown>;
}

export interface ToolResult {
	id: string;
	tool: string;
	args?: Record<string, unknown>;
	thought_signature?: string;
	provider_context?: Record<string, unknown>;
	ok: boolean;
	result?: unknown;
	error?: string;
	cancelled?: boolean;
	severity?: 'info' | 'warning' | 'error';
}

export type StepType = 'read' | 'search' | 'analyze' | 'write' | 'patch' | 'delete' | 'verify';
export type TaskComplexity = 'simple' | 'compound' | 'complex';
export type PlanStepType = StepType | 'query' | 'ask_user';

export interface TypedStep {
	id: string;
	description: string;
	type: PlanStepType;
	target?: string;
	status: 'pending' | 'done' | 'failed';
}

export interface PlanStepOutcome {
	step_id: string;
	status: 'done' | 'failed' | 'skipped';
	tool?: string;
	detail?: string;
}

export interface EditPlan {
	target_files: string[];
	operation: string;
	preferred_tool: 'patch_file' | 'write_file';
	safety: 'low' | 'medium' | 'high';
	reasoning?: string;
	risk_notes?: string[];
	complexity?: TaskComplexity;
	steps?: TypedStep[];
}

export interface TaskPlan {
	goal: string;
	complexity: TaskComplexity;
	steps: TypedStep[];
	outcomes?: PlanStepOutcome[];
	target_files?: string[];
	operation?: string;
	preferred_tool?: 'patch_file' | 'write_file';
	safety?: 'low' | 'medium' | 'high';
	reasoning?: string;
	risk_notes?: string[];
}

export interface PlanOutcome {
	plan: TaskPlan;
	status: 'ready' | 'needs_replan' | 'completed';
	reason?: string;
}

export interface DataviewQueryResult {
	kind: 'table' | 'list' | 'task' | 'scalar' | 'unknown';
	columns?: string[];
	rows?: Array<Record<string, unknown>>;
	items?: unknown[];
	count?: number;
	raw?: unknown;
}

export interface ChatEvent {
	type: string;
	text: string;
}

export interface ChatRequestPayload {
	provider: ProviderName;
	model: string;
	auth: ProviderAuth;
	message: string;
	history: HistoryMessage[];
	context: ContextItem[];
	tool_results: ToolResult[];
	options: ChatOptions;
}

export interface ProviderUsage {
	inputTokens?: number;
	outputTokens?: number;
	reasoningTokens?: number;
	cachedTokens?: number;
	webSearchRequests?: number;
	toolCallCount?: number;
	durationMs?: number;
}

export interface ChatResponsePayload {
	answer: string | null;
	tool_calls: ToolCall[];
	provider: ProviderName;
	model: string;
	events: ChatEvent[];
	sources: string[];
	response_id?: string;
	usage?: ProviderUsage;
}
