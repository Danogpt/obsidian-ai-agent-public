import type { ProviderName } from '../models/modelRegistry';
import type { ContextItem, ProviderUsage, ToolCall } from '../agent/types';
import type { VaultToolName } from '../tools/toolTypes';

export type JSONSchemaObject = {
	type: 'object';
	properties: Record<string, unknown>;
	required?: string[];
	additionalProperties?: boolean;
};

export type CanonicalMessage =
	| { role: 'system'; content: string }
	| { role: 'user'; content: string }
	| { role: 'assistant'; content: string | null; tool_calls?: CanonicalToolCall[]; thinking?: string; thought_signature?: string }
	| { role: 'tool'; tool_call_id: string; content: string };

export type CanonicalToolCall = {
	id: string;
	type: 'function';
	function: {
		name: VaultToolName;
		arguments: string;
	};
};

export type ProviderCapabilities = {
	nativeTools: boolean;
	parallelTools: boolean;
	streamingTools: boolean;
	thinking: boolean;
	webSearch: boolean;
	requiresThoughtSignature?: boolean;
	supportsToolChoiceRequired?: boolean;
	supportsAllowedTools?: boolean;
};

export type NormalizedProviderTurn = {
	answer?: string | null;
	toolCalls: ToolCall[];
	provider: ProviderName;
	model: string;
	events?: Array<{ type: string; text: string }>;
	sources?: string[];
	usage?: ProviderUsage;
	responseId?: string;
	raw?: unknown;
};

export type ProviderChatRequest = {
	model: string;
	messages: CanonicalMessage[];
	context: ContextItem[];
	tools?: Array<{
		name: VaultToolName;
		description: string;
		parameters: JSONSchemaObject;
	}>;
	toolChoice?: 'auto' | 'required' | 'none' | { name: VaultToolName };
};
