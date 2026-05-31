import { describe, expect, it } from 'vitest';
import { classifyTaskComplexity, shouldReplanFromToolResults, shouldUsePlanner } from '../agent/planner';
import type { ContextItem, ToolResult } from '../agent/types';

const activeFileContext: ContextItem[] = [
	{ type: 'active_file', path: 'SGCP-Agent/idee.md', label: 'idee', content: '# Idee' },
];

describe('shouldReplanFromToolResults', () => {
	it('ignores stale planning failures after an accepted plan and successful write', () => {
		const results: ToolResult[] = [
			{
				id: 'blocked-write',
				tool: 'write_file',
				ok: false,
				error: 'Planning phase: write_file is not allowed yet.',
			},
			{
				id: 'accepted-plan',
				tool: 'task_plan',
				ok: true,
				result: {
					goal: 'Rewrite note',
					complexity: 'compound',
					steps: [{ id: '1', description: 'Write note', type: 'write', status: 'pending' }],
				},
			},
			{
				id: 'write',
				tool: 'write_file',
				ok: true,
				result: { action: 'modified', path: 'Dolomiten/Tagesplan.md' },
			},
		];

		expect(shouldReplanFromToolResults(results)).toEqual({ required: false });
	});

	it('still requests a replan for failed execution after an accepted plan', () => {
		const results: ToolResult[] = [
			{
				id: 'accepted-plan',
				tool: 'task_plan',
				ok: true,
				result: {
					goal: 'Patch note',
					complexity: 'compound',
					steps: [{ id: '1', description: 'Patch note', type: 'patch', status: 'pending' }],
				},
			},
			{
				id: 'patch',
				tool: 'patch_file',
				ok: false,
				error: 'patch_file failed: oldText not found in target.md',
			},
		];

		expect(shouldReplanFromToolResults(results)).toEqual({
			required: true,
			reason: 'patch_file failed: patch_file failed: oldText not found in target.md',
		});
	});
});

describe('planner complexity routing', () => {
	it('keeps ordinary single-file edits out of the plan phase', () => {
		expect(classifyTaskComplexity('bearbeite die Datei schöner', activeFileContext)).toBe('simple');
		expect(shouldUsePlanner('bearbeite die Datei schöner', activeFileContext)).toBe(false);
	});

	it('uses the planner for multi-step or multi-file edit work', () => {
		expect(classifyTaskComplexity('bearbeite erst diese Datei und dann die zweite', activeFileContext)).toBe('compound');
		expect(shouldUsePlanner('bearbeite erst diese Datei und dann die zweite', activeFileContext)).toBe(true);
		expect(classifyTaskComplexity('recherchiere und aktualisiere die Datei danach', activeFileContext)).toBe('complex');
		expect(shouldUsePlanner('recherchiere und aktualisiere die Datei danach', activeFileContext)).toBe(true);
		expect(classifyTaskComplexity('mache einen neuen Ordner Admin-UI und füge die einzelnen Pages ein', activeFileContext)).toBe('complex');
		expect(shouldUsePlanner('mache einen neuen Ordner Admin-UI und füge die einzelnen Pages ein', activeFileContext)).toBe(true);
	});
});
