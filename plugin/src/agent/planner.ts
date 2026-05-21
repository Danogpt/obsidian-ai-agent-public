import type { ContextItem, PlanStepOutcome, TaskPlan, ToolResult, TypedStep, TaskComplexity } from './types';

function hasStrongEditVerb(text: string): boolean {
	return /\b(aendere|ändere|bearbeite|ueberarbeite|überarbeite|schreibe|ergaenze|ergänze|aktualisiere|loesche|lösche|ersetze|strukturiere|patch|rewrite)\b/u.test(text);
}

export function classifyTaskComplexity(message: string, context: ContextItem[]): TaskComplexity {
	const text = message.toLowerCase();
	const referencedFiles = context.filter(item =>
		item.type === 'active_file' || item.type === 'manual_file' || item.type === 'input_reference',
	).length;
	if (/\b(mehrere|alle dateien|für jede|fuer jede|danach|anschließend|anschliessend|schritt für schritt|step by step)\b/u.test(text)) {
		return 'complex';
	}
	if (referencedFiles > 1 || /\b(außerdem|ausserdem|zusätzlich|zusaetzlich|sowie|und dann)\b/u.test(text)) {
		return 'compound';
	}
	return hasStrongEditVerb(text) ? 'compound' : 'simple';
}

export function shouldUsePlanner(message: string, context: ContextItem[]): boolean {
	return classifyTaskComplexity(message, context) !== 'simple';
}

export function shouldReplanFromToolResults(results: ToolResult[]): { required: boolean; reason?: string } {
	const recent = results.slice(-3);
	for (const result of recent) {
		if (!result.ok) {
			return { required: true, reason: `${result.tool} failed: ${result.error ?? 'unknown error'}` };
		}
	}
	return { required: false };
}

export function buildFallbackPlan(message: string, context: ContextItem[]): TaskPlan {
	const steps: TypedStep[] = [];
	const referenced = context
		.filter(item => item.path && (item.type === 'active_file' || item.type === 'manual_file' || item.type === 'input_reference'))
		.map(item => item.path as string);
	if (referenced.length > 0) {
		steps.push({
			id: '1',
			description: `Relevante Datei(en) lesen: ${referenced.join(', ')}`,
			type: 'read',
			target: referenced[0],
			status: 'pending',
		});
	}
	steps.push({
		id: String(steps.length + 1),
		description: 'Kontext analysieren und nächste Aktion bestimmen',
		type: 'analyze',
		status: 'pending',
	});
	return {
		goal: message.trim(),
		complexity: classifyTaskComplexity(message, context),
		steps,
		outcomes: [],
	};
}

export function inferStepTypeFromTool(tool: string): TypedStep['type'] | null {
	const map: Record<string, TypedStep['type']> = {
		read_file: 'read',
		read_active_file: 'read',
		read_folder: 'read',
		expand_chunk: 'read',
		search_vault: 'search',
		list_files: 'search',
		query_dataview: 'query',
		ask_user: 'ask_user',
		write_file: 'write',
		patch_file: 'patch',
		delete_file: 'delete',
	};
	return map[tool] ?? null;
}

export function advanceTaskPlan(
	plan: TaskPlan,
	tool: string,
	ok: boolean,
	detail?: string,
): { plan: TaskPlan; outcome?: PlanStepOutcome } {
	const stepType = inferStepTypeFromTool(tool);
	if (!stepType) return { plan };

	const nextSteps = plan.steps.map(step => ({ ...step }));
	const nextOutcomes = [...(plan.outcomes ?? [])];
	const candidate = nextSteps.find(step => step.status === 'pending' && (step.type === stepType || step.type === 'analyze'));
	if (!candidate) return { plan: { ...plan, steps: nextSteps, outcomes: nextOutcomes } };

	candidate.status = ok ? 'done' : 'failed';
	const outcome: PlanStepOutcome = {
		step_id: candidate.id,
		status: ok ? 'done' : 'failed',
		tool,
		detail,
	};
	nextOutcomes.push(outcome);
	return {
		plan: {
			...plan,
			steps: nextSteps,
			outcomes: nextOutcomes.slice(-24),
		},
		outcome,
	};
}
