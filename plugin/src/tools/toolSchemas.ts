import type { AgentMode } from './toolTypes';
import type { UIMode } from '../chat/chatStore';
import type { ChatOptions } from '../agent/types';
import type { JSONSchemaObject } from '../providers/types';
import type { VaultToolName } from './toolTypes';

export type ToolRisk = 'read' | 'write' | 'delete' | 'external' | 'memory';

export type ToolSchemaDefinition = {
	name: VaultToolName;
	description: string;
	risk: ToolRisk;
	parameters: JSONSchemaObject;
	allowedModes: UIMode[];
	allowedPhases: NonNullable<ChatOptions['execution_phase']>[];
};

const emptyObjectSchema: JSONSchemaObject = {
	type: 'object',
	properties: {},
	additionalProperties: false,
};

const stringProp = (description: string) => ({ type: 'string', description });
const numberProp = (description: string) => ({ type: 'number', description });
const booleanProp = (description: string) => ({ type: 'boolean', description });

export const TOOL_SCHEMA_DEFINITIONS: ToolSchemaDefinition[] = [
	{
		name: 'list_files',
		description: 'List all Markdown files in the Obsidian vault.',
		risk: 'read',
		parameters: emptyObjectSchema,
		allowedModes: ['ask', 'edit', 'agent', 'plan'],
		allowedPhases: ['normal', 'plan', 'execute'],
	},
	{
		name: 'read_file',
		description: 'Read a Markdown file by vault-relative path.',
		risk: 'read',
		parameters: {
			type: 'object',
			properties: {
				path: stringProp('Vault-relative file path.'),
				maxChars: numberProp('Maximum characters to read.'),
			},
			required: ['path'],
			additionalProperties: false,
		},
		allowedModes: ['ask', 'edit', 'agent', 'plan'],
		allowedPhases: ['normal', 'plan', 'execute'],
	},
	{
		name: 'read_active_file',
		description: 'Read the currently active file in Obsidian.',
		risk: 'read',
		parameters: {
			type: 'object',
			properties: { maxChars: numberProp('Maximum characters to read.') },
			additionalProperties: false,
		},
		allowedModes: ['ask', 'edit', 'agent', 'plan'],
		allowedPhases: ['normal', 'plan', 'execute'],
	},
	{
		name: 'read_folder',
		description: 'Read a folder listing and snippets from contained Markdown files.',
		risk: 'read',
		parameters: {
			type: 'object',
			properties: {
				path: stringProp('Vault-relative folder path.'),
				maxFiles: numberProp('Maximum number of files.'),
				maxCharsPerFile: numberProp('Maximum characters per file.'),
			},
			required: ['path'],
			additionalProperties: false,
		},
		allowedModes: ['ask', 'edit', 'agent', 'plan'],
		allowedPhases: ['normal', 'plan', 'execute'],
	},
	{
		name: 'search_vault',
		description: 'Search the Obsidian vault for relevant notes or chunks.',
		risk: 'read',
		parameters: {
			type: 'object',
			properties: {
				query: stringProp('Search query.'),
				limit: numberProp('Maximum number of results.'),
				filters: {
					type: 'object',
					description: 'Optional frontmatter/path/date filters.',
					additionalProperties: true,
				},
			},
			required: ['query'],
			additionalProperties: false,
		},
		allowedModes: ['ask', 'edit', 'agent', 'plan'],
		allowedPhases: ['normal', 'plan', 'execute'],
	},
	{
		name: 'expand_chunk',
		description: 'Expand a search result chunk into a larger section.',
		risk: 'read',
		parameters: {
			type: 'object',
			properties: {
				chunk_id: stringProp('Chunk id returned by search_vault.'),
				maxChars: numberProp('Maximum characters to return.'),
			},
			required: ['chunk_id'],
			additionalProperties: false,
		},
		allowedModes: ['ask', 'edit', 'agent', 'plan'],
		allowedPhases: ['normal', 'plan', 'execute'],
	},
	{
		name: 'query_dataview',
		description: 'Run a Dataview DQL query locally in Obsidian.',
		risk: 'read',
		parameters: {
			type: 'object',
			properties: { dql: stringProp('Dataview DQL query.') },
			required: ['dql'],
			additionalProperties: false,
		},
		allowedModes: ['ask', 'edit', 'agent', 'plan'],
		allowedPhases: ['normal', 'plan', 'execute'],
	},
	{
		name: 'read_user_preferences',
		description: 'Read persistent user preferences.',
		risk: 'memory',
		parameters: {
			type: 'object',
			properties: { maxChars: numberProp('Maximum characters to read.') },
			additionalProperties: false,
		},
		allowedModes: ['ask', 'edit', 'agent', 'plan'],
		allowedPhases: ['normal', 'plan', 'execute'],
	},
	{
		name: 'recall_memory',
		description: 'Read saved long-term agent memory.',
		risk: 'memory',
		parameters: {
			type: 'object',
			properties: {
				maxChars: numberProp('Maximum characters to read.'),
				query: stringProp('Optional memory search query.'),
			},
			additionalProperties: false,
		},
		allowedModes: ['ask', 'edit', 'agent', 'plan'],
		allowedPhases: ['normal', 'plan', 'execute'],
	},
	{
		name: 'ask_user',
		description: 'Ask the user a clarification question.',
		risk: 'read',
		parameters: {
			type: 'object',
			properties: {
				question: stringProp('Question to ask the user.'),
				options: {
					type: 'array',
					description: 'Optional short answer options.',
					items: { type: 'string' },
				},
			},
			required: ['question'],
			additionalProperties: false,
		},
		allowedModes: ['ask', 'edit', 'agent', 'plan'],
		allowedPhases: ['normal', 'plan', 'execute'],
	},
	{
		name: 'write_file',
		description: 'Create or overwrite a Markdown file.',
		risk: 'write',
		parameters: {
			type: 'object',
			properties: {
				path: stringProp('Vault-relative file path.'),
				content: stringProp('Complete file content to write.'),
				overwrite: booleanProp('Whether an existing file may be overwritten.'),
			},
			required: ['path', 'content'],
			additionalProperties: false,
		},
		allowedModes: ['edit', 'agent'],
		allowedPhases: ['normal', 'execute'],
	},
	{
		name: 'patch_file',
		description: 'Replace exact text in a Markdown file.',
		risk: 'write',
		parameters: {
			type: 'object',
			properties: {
				path: stringProp('Vault-relative file path.'),
				oldText: stringProp('Exact existing text to replace.'),
				newText: stringProp('Replacement text.'),
			},
			required: ['path', 'oldText', 'newText'],
			additionalProperties: false,
		},
		allowedModes: ['edit', 'agent'],
		allowedPhases: ['normal', 'execute'],
	},
	{
		name: 'delete_file',
		description: 'Move a file to the Obsidian trash.',
		risk: 'delete',
		parameters: {
			type: 'object',
			properties: { path: stringProp('Vault-relative file path.') },
			required: ['path'],
			additionalProperties: false,
		},
		allowedModes: ['agent'],
		allowedPhases: ['execute'],
	},
	{
		name: 'update_user_preferences',
		description: 'Update persistent user preferences.',
		risk: 'memory',
		parameters: {
			type: 'object',
			properties: {
				content: stringProp('Complete preferences file content.'),
				overwrite: booleanProp('Whether to overwrite existing preferences.'),
			},
			required: ['content'],
			additionalProperties: false,
		},
		allowedModes: ['edit', 'agent'],
		allowedPhases: ['normal', 'execute'],
	},
	{
		name: 'save_memory',
		description: 'Save durable agent memory for future conversations.',
		risk: 'memory',
		parameters: {
			type: 'object',
			properties: {
				content: stringProp('Memory content to save.'),
				label: stringProp('Optional short label.'),
			},
			required: ['content'],
			additionalProperties: false,
		},
		allowedModes: ['agent'],
		allowedPhases: ['normal', 'execute'],
	},
	{
		name: 'create_agent_md',
		description: 'Create the agent.md configuration file if it is missing.',
		risk: 'write',
		parameters: emptyObjectSchema,
		allowedModes: ['edit', 'agent'],
		allowedPhases: ['normal', 'execute'],
	},
];

export const TOOL_SCHEMA_BY_NAME = new Map(TOOL_SCHEMA_DEFINITIONS.map(tool => [tool.name, tool]));

export function getAllowedToolSchemas(options: {
	mode?: UIMode;
	phase?: NonNullable<ChatOptions['execution_phase']>;
	agentMode?: AgentMode;
	allowedToolNames?: string[];
}): ToolSchemaDefinition[] {
	const mode = options.mode ?? 'agent';
	const phase = options.phase ?? 'normal';
	const allowedToolNames = options.allowedToolNames ? new Set(options.allowedToolNames) : null;
	return TOOL_SCHEMA_DEFINITIONS.filter(tool => {
		if (allowedToolNames && !allowedToolNames.has(tool.name)) return false;
		if (!tool.allowedModes.includes(mode)) return false;
		if (!tool.allowedPhases.includes(phase)) return false;
		if (options.agentMode === 'read' && (tool.risk === 'write' || tool.risk === 'delete')) return false;
		if (options.agentMode !== 'agent' && tool.risk === 'delete') return false;
		return true;
	});
}

export function toOpenAITools(tools: ToolSchemaDefinition[]): Array<{
	type: 'function';
	name: VaultToolName;
	description: string;
	parameters: JSONSchemaObject;
}> {
	return tools.map(tool => ({
		type: 'function',
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
}

export function toAnthropicTools(tools: ToolSchemaDefinition[]): Array<{
	name: VaultToolName;
	description: string;
	input_schema: JSONSchemaObject;
}> {
	return tools.map(tool => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters,
	}));
}

type GeminiSchema = Record<string, unknown>;

export function toGeminiSchema(schema: unknown): GeminiSchema {
	if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return {};
	const source = schema as Record<string, unknown>;
	const converted: GeminiSchema = {};
	for (const [key, value] of Object.entries(source)) {
		if (key === 'additionalProperties') continue;
		if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
			converted.properties = Object.fromEntries(
				Object.entries(value as Record<string, unknown>).map(([propName, propSchema]) => [
					propName,
					toGeminiSchema(propSchema),
				]),
			);
			continue;
		}
		if (key === 'items') {
			converted.items = toGeminiSchema(value);
			continue;
		}
		converted[key] = value;
	}
	return converted;
}

export function toGeminiFunctionDeclarations(tools: ToolSchemaDefinition[]): Array<{
	name: VaultToolName;
	description: string;
	parameters: GeminiSchema;
}> {
	return tools.map(tool => ({
		name: tool.name,
		description: tool.description,
		parameters: toGeminiSchema(tool.parameters),
	}));
}

export function toOllamaTools(tools: ToolSchemaDefinition[]): Array<{
	type: 'function';
	function: {
		name: VaultToolName;
		description: string;
		parameters: JSONSchemaObject;
	};
}> {
	return tools.map(tool => ({
		type: 'function',
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	}));
}
