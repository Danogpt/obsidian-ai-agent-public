import type { ContextItem, TaskPlan } from './types';

export function isPendingPlanExecutionRequest(message: string): boolean {
	const text = message.toLowerCase().trim();
	if (isPendingPlanRevisionRequest(text)) return false;
	return /^(ja|yes|yep|genau|ok|okay|passt|go|mach|mache|fuehr|führ|fuehre|führe|umsetzen|setze|start|starte)\b/.test(text) &&
		/\b(das|den\s+plan|so|umsetzen|setzen|aus|ausfuehren|ausführen|mach|machen|kannste|kannst|go|starten|starte|bitte)\b/.test(text);
}

export function isPendingPlanRevisionRequest(message: string): boolean {
	const text = message.toLowerCase();
	return /\b(plan|schritt|punkt|vorgehen|roadmap)\b/.test(text) &&
		/\b(aendere|ändere|anpassen|passe|ergänze|ergaenze|streiche|entferne|anders|nochmal|überarbeite|ueberarbeite|stattdessen)\b/.test(text);
}

export function clonePendingTaskPlan(plan: TaskPlan): TaskPlan {
	return {
		...plan,
		steps: plan.steps.map(step => ({ ...step, status: 'pending' as const })),
		outcomes: [],
		target_files: plan.target_files ? [...plan.target_files] : undefined,
		risk_notes: plan.risk_notes ? [...plan.risk_notes] : undefined,
	};
}

export function buildPendingPlanContext(plan: TaskPlan): ContextItem {
	const lines = [
		'# Pending Task Plan',
		`Goal: ${plan.goal}`,
		`Complexity: ${plan.complexity}`,
		plan.operation ? `Operation: ${plan.operation}` : '',
		plan.preferred_tool ? `Preferred tool: ${plan.preferred_tool}` : '',
		plan.safety ? `Safety: ${plan.safety}` : '',
		plan.target_files?.length ? `Target files: ${plan.target_files.join(', ')}` : '',
		'',
		'Steps:',
		...plan.steps.map((step, index) =>
			`${index + 1}. [${step.type}] ${step.description}${step.target ? ` -> ${step.target}` : ''}`,
		),
	].filter(Boolean);
	return {
		type: 'pending_task_plan',
		label: 'Gespeicherter ausfuehrbarer Plan',
		content: lines.join('\n'),
	};
}
