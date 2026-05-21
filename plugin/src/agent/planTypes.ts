import type { TaskComplexity, TaskPlan, TypedStep } from './types';

export type PlanStep = TypedStep;
export type PlanStepType = TypedStep['type'];
export type ReplanDecision = {
	required: boolean;
	reason?: string;
};
export type PlannerClassification = {
	complexity: TaskComplexity;
	requiresPlan: boolean;
};

export type { TaskPlan };
