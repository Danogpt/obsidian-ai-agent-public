import { describe, expect, it } from 'vitest';
import { buildPendingPlanContext, clonePendingTaskPlan, isPendingPlanExecutionRequest, isPendingPlanRevisionRequest } from '../agent/pendingPlan';
import type { TaskPlan } from '../agent/types';

const plan: TaskPlan = {
	goal: 'Dateien ueberarbeiten',
	complexity: 'compound',
	operation: 'Plan-Dateien professioneller formulieren',
	preferred_tool: 'write_file',
	safety: 'medium',
	target_files: ['SGCP-Agent/plan/overview.md'],
	steps: [
		{ id: '1', type: 'read', description: 'Kontext lesen', target: 'SGCP-Agent/plan', status: 'done' },
		{ id: '2', type: 'write', description: 'Overview neu schreiben', target: 'SGCP-Agent/plan/overview.md', status: 'pending' },
	],
	outcomes: ['alte Runde'],
};

describe('pending plan helpers', () => {
	it('detects short execution confirmations', () => {
		expect(isPendingPlanExecutionRequest('ja, umsetzen')).toBe(true);
		expect(isPendingPlanExecutionRequest('mach das')).toBe(true);
		expect(isPendingPlanExecutionRequest('führ aus')).toBe(true);
		expect(isPendingPlanExecutionRequest('ok bearbeite das mal bitte')).toBe(true);
	});

	it('does not treat normal questions as execution confirmations', () => {
		expect(isPendingPlanExecutionRequest('was haeltst du vom Plan?')).toBe(false);
		expect(isPendingPlanExecutionRequest('ok, aber kannst du Schritt 2 anpassen?')).toBe(false);
	});

	it('detects plan revision requests', () => {
		expect(isPendingPlanRevisionRequest('ändere Schritt 2 und ergänze einen Check')).toBe(true);
		expect(isPendingPlanRevisionRequest('mach den Plan nochmal anders')).toBe(true);
	});

	it('clones plans back to executable pending state', () => {
		const cloned = clonePendingTaskPlan(plan);
		expect(cloned).not.toBe(plan);
		expect(cloned.steps.map(step => step.status)).toEqual(['pending', 'pending']);
		expect(cloned.outcomes).toEqual([]);
	});

	it('builds a compact context item for the next model round', () => {
		const context = buildPendingPlanContext(plan);
		expect(context.type).toBe('pending_task_plan');
		expect(context.content).toContain('Goal: Dateien ueberarbeiten');
		expect(context.content).toContain('Preferred tool: write_file');
		expect(context.content).toContain('2. [write] Overview neu schreiben -> SGCP-Agent/plan/overview.md');
	});
});
