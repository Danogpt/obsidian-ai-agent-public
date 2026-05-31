import { describe, expect, it } from 'vitest';
import { buildOpenAIInput, extractNativeToolCalls } from '../providers/openai';

describe('OpenAI native tool calls', () => {
	it('normalizes Responses API function_call items', () => {
		const calls = extractNativeToolCalls({
			output: [
				{
					type: 'function_call',
					call_id: 'call_1',
					name: 'read_file',
					arguments: '{"path":"Dolomiten/Tagesplan.md","maxChars":1200}',
				},
			],
		});

		expect(calls).toEqual([
			{
				id: 'call_1',
				tool: 'read_file',
				args: { path: 'Dolomiten/Tagesplan.md', maxChars: 1200 },
			},
		]);
	});

	it('ignores unknown native tool names', () => {
		const calls = extractNativeToolCalls({
			output: [
				{
					type: 'function_call',
					call_id: 'call_1',
					name: 'unknown_tool',
					arguments: '{}',
				},
			],
		});

		expect(calls).toEqual([]);
	});

	it('falls back to empty args for malformed JSON', () => {
		const calls = extractNativeToolCalls({
			output: [
				{
					type: 'function_call',
					call_id: 'call_1',
					name: 'read_file',
					arguments: '{',
				},
			],
		});

		expect(calls[0]?.args).toEqual({});
	});

	it('returns native tool results as function_call_output items instead of prompt text', () => {
		const [input] = buildOpenAIInput({
			provider: 'openai',
			model: 'gpt-5.4-mini',
			auth: { api_key: 'test' },
			message: 'Tausche die Tage in der aktuellen Datei.',
			history: [],
			context: [],
			tool_results: [
				{
					id: 'call_read_1',
					tool: 'read_active_file',
					args: {},
					ok: true,
					result: { path: 'Dolomiten/Tagesplan.md', content: '# Tag 1\n...' },
				},
			],
			options: {
				thinking_mode: false,
				web_search: false,
				vault_tools_enabled: true,
				stream: false,
				max_context_chars: 4000,
				agent_mode: 'agent',
				execution_phase: 'normal',
				native_tool_calling: true,
			},
		});

		expect(input).toContainEqual({
			type: 'function_call',
			call_id: 'call_read_1',
			name: 'read_active_file',
			arguments: '{}',
		});
		expect(input).toContainEqual({
			type: 'function_call_output',
			call_id: 'call_read_1',
			output: '{"path":"Dolomiten/Tagesplan.md","content":"# Tag 1\\n..."}',
		});
		expect(JSON.stringify(input)).not.toContain('<tool_results>');
	});

	it('continues previous Responses API tool calls with outputs only', () => {
		const [input] = buildOpenAIInput({
			provider: 'openai',
			model: 'gpt-5.4-mini',
			auth: { api_key: 'test' },
			message: 'Weiter.',
			history: [],
			context: [],
			tool_results: [
				{
					id: 'call_failed_read',
					tool: 'read_file',
					args: { path: 'missing.md' },
					ok: false,
					error: 'File not found: missing.md',
					provider_context: { openai_response_id: 'resp_123' },
				},
			],
			options: {
				thinking_mode: false,
				web_search: false,
				vault_tools_enabled: true,
				stream: false,
				max_context_chars: 4000,
				agent_mode: 'agent',
				execution_phase: 'normal',
				native_tool_calling: true,
			},
		});

		expect(input).not.toContainEqual({
			type: 'function_call',
			call_id: 'call_failed_read',
			name: 'read_file',
			arguments: '{"path":"missing.md"}',
		});
		expect(input).not.toContainEqual(expect.objectContaining({ role: 'user' }));
		expect(input).toContainEqual({
			type: 'function_call_output',
			call_id: 'call_failed_read',
			output: 'File not found: missing.md',
		});
	});

	it('returns write-guard failures using the original call_id during Responses continuation', () => {
		const [input] = buildOpenAIInput({
			provider: 'openai',
			model: 'gpt-5.4-mini',
			auth: { api_key: 'test' },
			message: 'Weiter.',
			history: [],
			context: [],
			tool_results: [
				{
					id: 'call_write_file',
					tool: 'write_file',
					args: { path: 'A.md', content: 'neu' },
					ok: false,
					error: 'Write-Guard: write_file requires a fresh read_file result.',
					provider_context: { openai_response_id: 'resp_123' },
				},
			],
			options: {
				thinking_mode: false,
				web_search: false,
				vault_tools_enabled: true,
				stream: false,
				max_context_chars: 4000,
				agent_mode: 'agent',
				execution_phase: 'normal',
				native_tool_calling: true,
			},
		});

		expect(input).toContainEqual({
			type: 'function_call_output',
			call_id: 'call_write_file',
			output: 'Write-Guard: write_file requires a fresh read_file result.',
		});
		expect(JSON.stringify(input)).not.toContain('call_write_file_plan_guard');
		expect(JSON.stringify(input)).not.toContain('write_guard');
	});

	it('only returns outputs for the latest previous_response_id group', () => {
		const [input] = buildOpenAIInput({
			provider: 'openai',
			model: 'gpt-5.4-mini',
			auth: { api_key: 'test' },
			message: 'Weiter.',
			history: [{ role: 'user', content: 'Alter Verlauf' }],
			context: [],
			tool_results: [
				{
					id: 'old_call',
					tool: 'read_file',
					args: { path: 'old.md' },
					ok: true,
					result: 'old',
					provider_context: { openai_response_id: 'resp_old' },
				},
				{
					id: 'latest_call_1',
					tool: 'read_file',
					args: { path: 'A.md' },
					ok: true,
					result: 'A',
					provider_context: { openai_response_id: 'resp_latest' },
				},
				{
					id: 'latest_call_2',
					tool: 'read_file',
					args: { path: 'B.md' },
					ok: false,
					error: 'File not found: B.md',
					provider_context: { openai_response_id: 'resp_latest' },
				},
			],
			options: {
				thinking_mode: false,
				web_search: false,
				vault_tools_enabled: true,
				stream: false,
				max_context_chars: 4000,
				agent_mode: 'agent',
				execution_phase: 'normal',
				native_tool_calling: true,
			},
		});

		expect(input).toEqual([
			{ type: 'function_call_output', call_id: 'latest_call_1', output: 'A' },
			{ type: 'function_call_output', call_id: 'latest_call_2', output: 'File not found: B.md' },
		]);
		expect(JSON.stringify(input)).not.toContain('old_call');
		expect(JSON.stringify(input)).not.toContain('Alter Verlauf');
	});

	it('keeps host feedback in prompt text while local tools stay native', () => {
		const [input] = buildOpenAIInput({
			provider: 'openai',
			model: 'gpt-5.4-mini',
			auth: { api_key: 'test' },
			message: 'Bearbeite weiter.',
			history: [],
			context: [],
			tool_results: [
				{
					id: 'loop_guard_1',
					tool: 'loop_guard',
					ok: false,
					error: 'Wiederholtes Lesen erkannt.',
				},
				{
					id: 'call_read_1',
					tool: 'read_file',
					args: { path: 'A.md' },
					ok: true,
					result: { path: 'A.md', content: 'Hallo' },
					provider_context: { openai_response_id: 'resp_123' },
				},
			],
			options: {
				thinking_mode: false,
				web_search: false,
				vault_tools_enabled: true,
				stream: false,
				max_context_chars: 4000,
				agent_mode: 'agent',
				execution_phase: 'normal',
				native_tool_calling: true,
			},
		});

		expect(JSON.stringify(input)).toContain('Host feedback for the next step');
		expect(JSON.stringify(input)).toContain('Wiederholtes Lesen erkannt.');
		expect(input).toContainEqual({
			type: 'function_call_output',
			call_id: 'call_read_1',
			output: '{"path":"A.md","content":"Hallo"}',
		});
	});
});
