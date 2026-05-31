import { describe, expect, it } from 'vitest';
import {
	getModelAvailability,
	getModelApiId,
	getModelConfigWithCustom,
	getModelsByProvider,
	isReasoningActive,
	migrateModelId,
} from '../models/modelRegistry';

describe('model registry variants', () => {
	it('keeps selectable OpenAI reasoning variants mapped to the real API model id', () => {
		const model = getModelConfigWithCustom('gpt-5.5#reasoning-medium');
		expect(model?.label).toBe('GPT-5.5 · medium');
		expect(model?.reasoning).toEqual({ provider: 'openai', effort: 'medium' });
		expect(model && getModelApiId(model)).toBe('gpt-5.5');
		expect(isReasoningActive(model?.reasoning)).toBe(true);
	});

	it('supports explicit off/none variants without marking reasoning active', () => {
		const openai = getModelConfigWithCustom('gpt-5.4#reasoning-none');
		const gemini = getModelConfigWithCustom('gemini-2.5-flash#thinking-off');
		const ollama = getModelConfigWithCustom('qwen3#thinking-off');

		expect(openai?.reasoning).toEqual({ provider: 'openai', effort: 'none' });
		expect(gemini?.reasoning).toEqual({ provider: 'gemini', mode: 'budget', budget: 0 });
		expect(ollama?.reasoning).toEqual({ provider: 'ollama', mode: 'think', think: false });
		expect(isReasoningActive(openai?.reasoning)).toBe(false);
		expect(isReasoningActive(gemini?.reasoning)).toBe(false);
		expect(isReasoningActive(ollama?.reasoning)).toBe(false);
	});

	it('maps Claude thinking variants to adaptive or budget configs', () => {
		const opus = getModelConfigWithCustom('claude-opus-4-8#thinking-xhigh');
		const haiku = getModelConfigWithCustom('claude-haiku-4-5-20251001#thinking-on');

		expect(opus?.reasoning).toEqual({ provider: 'anthropic', mode: 'adaptive', effort: 'xhigh' });
		expect(haiku?.reasoning).toEqual({ provider: 'anthropic', mode: 'manual', budgetTokens: 4096, effort: 'low' });
		expect(opus && getModelApiId(opus)).toBe('claude-opus-4-8');
		expect(haiku && getModelApiId(haiku)).toBe('claude-haiku-4-5-20251001');
	});

	it('hides unverified deprecated models from provider selections and migrates saved ids', () => {
		expect(getModelsByProvider('openai').some(model => model.id === 'gpt-5.3-codex')).toBe(false);
		expect(migrateModelId('gpt-5.3-codex#reasoning-high')).toBe('gpt-5.4#reasoning-high');
		expect(getModelsByProvider('anthropic').some(model => model.id === 'claude-opus-4-7')).toBe(false);
		expect(migrateModelId('claude-opus-4-7#thinking-xhigh')).toBe('claude-opus-4-8#thinking-xhigh');
		expect(migrateModelId('totally-unknown-model')).toBe('gpt-5.5');
	});

	it('tracks model availability without blocking preview and local models', () => {
		expect(getModelAvailability(getModelConfigWithCustom('gpt-5.5')!)).toBe('verified');
		expect(getModelAvailability(getModelConfigWithCustom('gemini-3-flash-preview')!)).toBe('preview');
		expect(getModelAvailability(getModelConfigWithCustom('gpt-5.3-codex')!)).toBe('legacy');
		expect(getModelAvailability(getModelConfigWithCustom('qwen3')!)).toBe('local');
	});

	it('adds Gemini 3.5 Flash with thinking variants mapped to the stable API id', () => {
		const model = getModelConfigWithCustom('gemini-3.5-flash#thinking-low');
		expect(model?.label).toBe('Gemini 3.5 Flash · thinking low');
		expect(model?.reasoning).toEqual({ provider: 'gemini', mode: 'level', level: 'low' });
		expect(model && getModelApiId(model)).toBe('gemini-3.5-flash');
	});
});
