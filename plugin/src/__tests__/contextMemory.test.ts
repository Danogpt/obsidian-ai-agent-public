import { describe, it, expect } from 'vitest';
import { buildWorkingMemoryContext, compactToolResults, recordToolOutcome } from '../context/contextMemory';
import type { ChatThread } from '../chat/chatStore';

function makeThread(): ChatThread {
	return {
		id: 'thread-1',
		title: 'Test',
		createdAt: 1,
		updatedAt: 1,
		archived: false,
		selectedModelId: 'gpt-5.5',
		messages: [],
	};
}

describe('recordToolOutcome', () => {
	it('records successful write outcomes as artifacts, relevant files and decisions', () => {
		const thread = makeThread();
		recordToolOutcome(thread, {
			tool: 'write_file',
			ok: true,
			path: 'notes/target.md',
			turnId: 'turn-1',
		});

		expect(thread.workingMemoryData?.artifacts).toEqual([
			{ path: 'notes/target.md', action: 'created', summary: 'created via write_file' },
		]);
		expect(thread.workingMemoryData?.relevant_files).toEqual([
			{ path: 'notes/target.md', role: 'target', last_touched: expect.any(Number) },
		]);
		expect(thread.workingMemoryData?.decisions).toEqual([
			{ claim: 'write_file applied to notes/target.md', turn_id: 'turn-1' },
		]);
	});

	it('records blocked outcomes as next steps and decisions', () => {
		const thread = makeThread();
		recordToolOutcome(thread, {
			tool: 'patch_file',
			ok: false,
			path: 'notes/target.md',
			turnId: 'turn-2',
			error: 'oldText not found in notes/target.md',
		});

		expect(thread.workingMemoryData?.next_steps).toEqual([
			{ step: 'patch_file blocked for notes/target.md', status: 'blocked' },
		]);
		expect(thread.workingMemoryData?.decisions).toEqual([
			{ claim: 'oldText not found in notes/target.md', turn_id: 'turn-2' },
		]);
	});

	it('records task plan acceptance as an in-progress next step', () => {
		const thread = makeThread();
		recordToolOutcome(thread, {
			tool: 'task_plan',
			ok: true,
			turnId: 'turn-3',
		});

		expect(thread.workingMemoryData?.next_steps).toEqual([
			{ step: 'Task plan accepted', status: 'in_progress' },
		]);
		expect(thread.workingMemoryData?.decisions).toEqual([
			{ claim: 'Plan phase completed and execution started', turn_id: 'turn-3' },
		]);
	});

	it('builds working-memory context immediately from direct tool outcomes', () => {
		const thread = makeThread();
		recordToolOutcome(thread, {
			tool: 'write_file',
			ok: true,
			path: 'notes/target.md',
			turnId: 'turn-4',
		});

		const context = buildWorkingMemoryContext(thread);
		expect(context.length).toBe(2);
		expect(context[0]?.content).toContain('notes/target.md');
		expect(context[1]?.content).toContain('path: notes/target.md');
	});
});

describe('compactToolResults', () => {
	it('keeps all tool outputs from the latest OpenAI response together', () => {
		const compacted = compactToolResults([
			{ id: 'old_1', tool: 'read_folder', provider_context: { openai_response_id: 'resp_old' }, ok: true, result: 'old' },
			{ id: 'old_2', tool: 'search_vault', provider_context: { openai_response_id: 'resp_old' }, ok: true, result: 'old' },
			{ id: 'call_1', tool: 'read_file', provider_context: { openai_response_id: 'resp_latest' }, ok: true, result: '1' },
			{ id: 'call_2', tool: 'read_file', provider_context: { openai_response_id: 'resp_latest' }, ok: true, result: '2' },
			{ id: 'call_3', tool: 'read_file', provider_context: { openai_response_id: 'resp_latest' }, ok: true, result: '3' },
			{ id: 'call_4', tool: 'read_file', provider_context: { openai_response_id: 'resp_latest' }, ok: true, result: '4' },
			{ id: 'loop_guard_readonly_3', tool: 'loop_guard', ok: false, error: 'Too many read-only rounds.' },
		]);

		expect(compacted.map(result => result.id)).toEqual([
			'call_1',
			'call_2',
			'call_3',
			'call_4',
			'loop_guard_readonly_3',
		]);
	});

	it('still limits ordinary tool history when no OpenAI response group is pending', () => {
		const compacted = compactToolResults([
			{ id: 'a', tool: 'read_file', ok: true, result: 'a' },
			{ id: 'b', tool: 'read_file', ok: true, result: 'b' },
			{ id: 'c', tool: 'read_file', ok: true, result: 'c' },
			{ id: 'd', tool: 'read_file', ok: true, result: 'd' },
		]);

		expect(compacted.map(result => result.id)).toEqual(['b', 'c', 'd']);
	});
});
