import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, buildUserContent } from '../agent/prompts';
import type { ChatRequestPayload, ContextItem } from '../agent/types';

function item(type: string, content: string, path?: string): ContextItem {
	return { type, label: type, content, path } as ContextItem;
}

function payload(context: ContextItem[]): ChatRequestPayload {
	return {
		provider: 'openai',
		model: 'gpt-test',
		auth: {},
		message: 'Bitte nutze die aktuelle Datei.',
		history: [],
		context,
		tool_results: [],
		options: {
			thinking_mode: false,
			web_search: false,
			vault_tools_enabled: false,
			stream: false,
			max_context_chars: 20000,
			agent_mode: 'agent',
			execution_phase: 'normal',
		},
	};
}

describe('buildUserContent context ordering', () => {
	it('places active file content before retrieved chunks in the provider prompt', () => {
		const [content] = buildUserContent(payload([
			item('retrieved_chunk', 'retrieved content', 'random.md'),
			item('active_file', 'active content', 'current.md'),
		]));

		expect(content.indexOf('Path: current.md')).toBeLessThan(content.indexOf('Path: random.md'));
	});
});

describe('buildSystemPrompt execution phase', () => {
	it('tells execute phase not to return another plan JSON', () => {
		const prompt = buildSystemPrompt(payload([]));
		expect(prompt).not.toContain('Gib in execute keine neue Plan-JSON-Antwort aus');

		const executePrompt = buildSystemPrompt({
			...payload([]),
			options: {
				...payload([]).options,
				execution_phase: 'execute',
			},
		});
		expect(executePrompt).toContain('Gib in execute keine neue Plan-JSON-Antwort aus');
	});
});
