export type VaultToolName =
	| 'list_files'
	| 'read_file'
	| 'read_active_file'
	| 'read_folder'
	| 'query_dataview'
	| 'read_user_preferences'
	| 'update_user_preferences'
	| 'expand_chunk'
	| 'create_agent_md'
	| 'write_file'
	| 'patch_file'
	| 'delete_file'
	| 'search_vault';

export type VaultToolCall = {
	id: string;
	tool: VaultToolName;
	args: Record<string, unknown>;
	reason?: string;
};

export type VaultToolResult = {
	id: string;
	tool: VaultToolName;
	ok: boolean;
	result?: unknown;
	error?: string;
};

export type AgentMode = 'read' | 'suggest' | 'agent';
