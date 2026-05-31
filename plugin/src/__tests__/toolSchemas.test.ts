import { describe, expect, it } from 'vitest';
import { getAllowedToolSchemas, toGeminiFunctionDeclarations, toOpenAITools, TOOL_SCHEMA_DEFINITIONS } from '../tools/toolSchemas';

describe('tool schema registry', () => {
	it('keeps tool names unique', () => {
		const names = TOOL_SCHEMA_DEFINITIONS.map(tool => tool.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it('blocks write and delete tools in ask mode', () => {
		const names = getAllowedToolSchemas({ mode: 'ask', phase: 'normal', agentMode: 'agent' }).map(tool => tool.name);
		expect(names).toContain('read_file');
		expect(names).toContain('search_vault');
		expect(names).not.toContain('write_file');
		expect(names).not.toContain('patch_file');
		expect(names).not.toContain('delete_file');
		expect(names).not.toContain('create_agent_md');
		expect(names).not.toContain('save_memory');
	});

	it('allows edit writes but not deletes', () => {
		const names = getAllowedToolSchemas({ mode: 'edit', phase: 'normal', agentMode: 'edit' }).map(tool => tool.name);
		expect(names).toContain('write_file');
		expect(names).toContain('patch_file');
		expect(names).toContain('create_agent_md');
		expect(names).not.toContain('delete_file');
	});

	it('applies request-level tool allowlists', () => {
		const names = getAllowedToolSchemas({
			mode: 'edit',
			phase: 'normal',
			agentMode: 'agent',
			allowedToolNames: ['read_active_file', 'read_file', 'patch_file', 'write_file'],
		}).map(tool => tool.name);
		expect(names).toEqual(['read_file', 'read_active_file', 'write_file', 'patch_file']);
		expect(names).not.toContain('search_vault');
		expect(names).not.toContain('read_folder');
	});

	it('blocks create_agent_md in plan phase', () => {
		const names = getAllowedToolSchemas({ mode: 'plan', phase: 'plan', agentMode: 'agent' }).map(tool => tool.name);
		expect(names).toContain('read_file');
		expect(names).not.toContain('create_agent_md');
		expect(names).not.toContain('write_file');
		expect(names).not.toContain('patch_file');
	});

	it('exports OpenAI function tool definitions', () => {
		const [tool] = toOpenAITools(getAllowedToolSchemas({ mode: 'agent', phase: 'execute', agentMode: 'agent' }));
		expect(tool).toMatchObject({
			type: 'function',
			name: expect.any(String),
			description: expect.any(String),
			parameters: { type: 'object' },
		});
	});

	it('strips unsupported additionalProperties from Gemini declarations recursively', () => {
		const declarations = toGeminiFunctionDeclarations(getAllowedToolSchemas({ mode: 'agent', phase: 'normal', agentMode: 'agent' }));
		const json = JSON.stringify(declarations);
		expect(json).not.toContain('additionalProperties');

		const searchVault = declarations.find(tool => tool.name === 'search_vault');
		expect(searchVault).toMatchObject({
			name: 'search_vault',
			parameters: {
				type: 'object',
				properties: {
					filters: {
						type: 'object',
						description: 'Optional frontmatter/path/date filters.',
					},
				},
			},
		});
	});
});
