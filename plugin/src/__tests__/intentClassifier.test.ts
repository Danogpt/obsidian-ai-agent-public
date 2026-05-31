import { describe, expect, it } from 'vitest';
import {
	applyClassifierResult,
	buildIntentClassifierPrompt,
	learnIntentPattern,
	normalizeIntentPattern,
	parseIntentClassifierResult,
	shouldRunIntentClassifier,
} from '../agent/intentClassifier';
import type { RouterResult } from '../agent/intentRouter';

const lowAskRoute: RouterResult = {
	mode: 'ask',
	needsPlanner: false,
	allowWrites: false,
	maxRetrievedChunks: 5,
	reason: 'Unklar',
	confidence: 'low',
	signals: ['vague_task'],
};

describe('intentClassifier', () => {
	it('builds a small prompt without vault content', () => {
		const prompt = buildIntentClassifierPrompt({
			message: 'mach das ordentlich',
			hasActiveFile: true,
			webSearchEnabled: true,
		});
		expect(prompt).toContain('"hasActiveFile":true');
		expect(prompt).toContain('mach das ordentlich');
		expect(prompt).not.toContain('<active_file>');
	});

	it('parses structured classifier JSON', () => {
		const parsed = parseIntentClassifierResult('{"mode":"edit","confidence":0.82,"reason":"Datei verbessern","signals":["active_file"]}');
		expect(parsed).toEqual({
			mode: 'edit',
			confidence: 0.82,
			reason: 'Datei verbessern',
			signals: ['active_file'],
		});
	});

	it('accepts classifier escalation only with writable context', () => {
		const next = applyClassifierResult(
			lowAskRoute,
			{ mode: 'edit', confidence: 0.8, reason: 'Formatierung', signals: ['formatting_request'] },
			{ message: 'mach das sauber', hasActiveFile: true },
		);
		expect(next.mode).toBe('edit');
		expect(next.allowWrites).toBe(true);
		expect(next.signals).toContain('llm_classifier');
	});

	it('blocks classifier write escalation without file context', () => {
		const next = applyClassifierResult(
			lowAskRoute,
			{ mode: 'agent', confidence: 0.95, reason: 'Agent', signals: ['research_edit'] },
			{ message: 'mach das sauber' },
		);
		expect(next.mode).toBe('ask');
		expect(next.allowWrites).toBe(false);
		expect(next.signals).toContain('classifier_blocked_no_file_context');
	});

	it('allows high-confidence classifier escalation from medium default ask with file context', () => {
		const next = applyClassifierResult(
			{
				mode: 'ask',
				needsPlanner: false,
				allowWrites: false,
				maxRetrievedChunks: 5,
				reason: 'Standard: Ask',
				confidence: 'med',
				signals: ['default_ask'],
			},
			{ mode: 'edit', confidence: 0.9, reason: 'Text professioneller formulieren', signals: ['rewrite_request'] },
			{ message: 'formuliere das professioneller', hasActiveFile: true },
		);
		expect(next.mode).toBe('edit');
		expect(next.allowWrites).toBe(true);
		expect(next.signals).toContain('llm_classifier');
	});

	it('learns normalized formulation counts', () => {
		const key = normalizeIntentPattern('Kannst du das mal ordentlich machen?');
		const once = learnIntentPattern([], 'Kannst du das mal ordentlich machen?', 'edit', 0.7, 1);
		const twice = learnIntentPattern(once, 'kannst du das ordentlich machen', 'edit', 0.7, 2);
		expect(key).toBe('ordentlich machen');
		expect(twice[0]?.counts.edit).toBe(2);
	});

	it('learns high-confidence classifier results faster', () => {
		const learned = learnIntentPattern([], 'übernimm das in die Datei', 'edit', 0.92, 1);
		expect(learned[0]?.counts.edit).toBe(2);
	});

	it('runs classifier for ambiguous ask followups with file context', () => {
		expect(shouldRunIntentClassifier(lowAskRoute, {
			message: 'schreib das in die datei',
			hasActiveFile: true,
		})).toBe(true);
	});

	it('does not run classifier for plain high-confidence questions', () => {
		expect(shouldRunIntentClassifier({
			mode: 'ask',
			needsPlanner: false,
			allowWrites: false,
			maxRetrievedChunks: 5,
			reason: 'Standard',
			confidence: 'high',
		}, {
			message: 'was steht in der Datei?',
			hasActiveFile: true,
		})).toBe(false);
	});
});
