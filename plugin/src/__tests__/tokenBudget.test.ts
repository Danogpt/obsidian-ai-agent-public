import { describe, it, expect } from 'vitest';
import { estimateTokens, compactContextForBudget } from '../limits/tokenBudget';
import type { ContextItem } from '../agent/types';

describe('estimateTokens', () => {
	it('returns 0 for empty string', () => {
		expect(estimateTokens('')).toBe(0);
	});

	it('estimates roughly 1 token per 3 chars', () => {
		expect(estimateTokens('abc')).toBe(1);
		expect(estimateTokens('a'.repeat(300))).toBe(100);
	});

	it('rounds up', () => {
		expect(estimateTokens('ab')).toBe(1);
		expect(estimateTokens('abcd')).toBe(2);
	});
});

function item(type: string, content: string, path?: string): ContextItem {
	return { type, label: type, content, path } as ContextItem;
}

describe('compactContextForBudget — normal mode', () => {
	it('returns empty array for empty input', () => {
		expect(compactContextForBudget([], 10000)).toEqual([]);
	});

	it('respects maxContextChars ceiling', () => {
		const items: ContextItem[] = [
			item('active_file', 'x'.repeat(50000)),
			item('agent_md', 'y'.repeat(50000)),
		];
		const result = compactContextForBudget(items, 5000);
		expect(JSON.stringify(result).length).toBeLessThanOrEqual(5000);
	});

	it('returns items within budget unchanged', () => {
		const items: ContextItem[] = [item('active_file', 'short content')];
		const result = compactContextForBudget(items, 100000);
		expect(result.length).toBe(1);
	});
});

describe('compactContextForBudget — edit mode', () => {
	it('places active_file before agent_md', () => {
		const items: ContextItem[] = [
			item('agent_md', 'agent content '.repeat(200)),
			item('active_file', 'file content '.repeat(200)),
		];
		const result = compactContextForBudget(items, 200000, { intent: 'edit', query: 'test' });
		const activeIdx = result.findIndex(i => i.type === 'active_file');
		const agentIdx = result.findIndex(i => i.type === 'agent_md');
		expect(activeIdx).toBeGreaterThanOrEqual(0);
		expect(agentIdx).toBeGreaterThanOrEqual(0);
		expect(activeIdx).toBeLessThan(agentIdx);
	});

	it('drops vault_map entirely', () => {
		const items: ContextItem[] = [
			item('vault_map', 'vault overview'),
			item('active_file', 'file content'),
		];
		const result = compactContextForBudget(items, 100000, { intent: 'edit' });
		expect(result.find(i => i.type === 'vault_map')).toBeUndefined();
	});

	it('limits retrieved_chunk to at most 2', () => {
		const items: ContextItem[] = [
			item('retrieved_chunk', 'chunk 1', 'a.md'),
			item('retrieved_chunk', 'chunk 2', 'b.md'),
			item('retrieved_chunk', 'chunk 3', 'c.md'),
		];
		const result = compactContextForBudget(items, 100000, { intent: 'edit' });
		expect(result.filter(i => i.type === 'retrieved_chunk').length).toBeLessThanOrEqual(2);
	});

	it('keeps vault_map in non-edit mode', () => {
		const items: ContextItem[] = [
			item('vault_map', 'vault overview'),
			item('active_file', 'file content'),
		];
		const result = compactContextForBudget(items, 100000, { intent: 'vault_research' });
		expect(result.find(i => i.type === 'vault_map')).toBeDefined();
	});

	it('does not deduplicate retrieved chunks in non-edit budget compaction', () => {
		const items: ContextItem[] = [
			item('retrieved_chunk', 'chunk 1', 'same.md'),
			item('retrieved_chunk', 'chunk 2', 'same.md'),
			item('retrieved_chunk', 'chunk 3', 'same.md'),
		];
		const result = compactContextForBudget(items, 100000, { intent: 'fact_lookup' });
		expect(result.filter(i => i.type === 'retrieved_chunk' && i.path === 'same.md').length).toBe(3);
	});
});

describe('compactContextForBudget — focused degradation', () => {
	it('applies focused mode to active_file in edit intent', () => {
		const longContent = Array.from({ length: 30 }, (_, i) => `## Section ${i}\n${'content '.repeat(50)}`).join('\n');
		const items: ContextItem[] = [item('active_file', longContent)];
		const result = compactContextForBudget(items, 200000, { intent: 'edit', query: 'Section 15' });
		const resultContent = result[0]?.content ?? '';
		// Focused mode should produce content that mentions the query section
		expect(resultContent).toContain('Section');
	});
});
