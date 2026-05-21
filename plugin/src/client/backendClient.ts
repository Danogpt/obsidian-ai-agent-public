// Re-exports for backward compatibility — all types live in agent/types.ts now.
export type {
	ProviderName,
	ProviderAuth,
	ChatOptions,
	ContextItemType,
	ContextFile,
	ContextItem,
	HistoryMessage,
	ToolCall,
	ToolCall as BackendToolCall,
	ToolResult,
	ChatEvent,
	ChatRequestPayload,
	ChatResponsePayload,
} from '../agent/types';
