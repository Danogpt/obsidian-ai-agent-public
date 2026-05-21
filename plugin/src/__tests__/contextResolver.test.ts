import { describe, it, expect } from 'vitest';
import { diversifyRetrievedHitsByPath, shouldUseLlmRerankForIntent } from '../context/contextResolver';

describe('shouldUseLlmRerankForIntent', () => {
	it('enables rerank for vault research with multiple hits', () => {
		expect(shouldUseLlmRerankForIntent('vault_research', false, 'broad project comparison', true, 3)).toBe(true);
	});

	it('disables rerank for narrow fact lookup with strong file context', () => {
		expect(shouldUseLlmRerankForIntent('fact_lookup', true, 'what is status', true, 3)).toBe(false);
	});

	it('enables rerank for broad fact lookup without strong file context', () => {
		expect(shouldUseLlmRerankForIntent('fact_lookup', false, 'compare project status across multiple notes', true, 3)).toBe(true);
	});

	it('disables rerank when no rerank function is available', () => {
		expect(shouldUseLlmRerankForIntent('vault_research', false, 'broad query', false, 3)).toBe(false);
	});
});

describe('diversifyRetrievedHitsByPath', () => {
	it('limits non-research retrieval to one hit per file', () => {
		const hits = [
			{ path: 'a.md', id: 1 },
			{ path: 'a.md', id: 2 },
			{ path: 'b.md', id: 3 },
		];
		const diversified = diversifyRetrievedHitsByPath(hits, 'fact_lookup', 3);
		expect(diversified).toEqual([
			{ path: 'a.md', id: 1 },
			{ path: 'b.md', id: 3 },
		]);
	});

	it('allows up to two hits per file for vault research', () => {
		const hits = [
			{ path: 'a.md', id: 1 },
			{ path: 'a.md', id: 2 },
			{ path: 'a.md', id: 3 },
			{ path: 'b.md', id: 4 },
		];
		const diversified = diversifyRetrievedHitsByPath(hits, 'vault_research', 4);
		expect(diversified).toEqual([
			{ path: 'a.md', id: 1 },
			{ path: 'a.md', id: 2 },
			{ path: 'b.md', id: 4 },
		]);
	});

	it('respects the overall limit after diversification', () => {
		const hits = [
			{ path: 'a.md', id: 1 },
			{ path: 'b.md', id: 2 },
			{ path: 'c.md', id: 3 },
		];
		const diversified = diversifyRetrievedHitsByPath(hits, 'fact_lookup', 2);
		expect(diversified).toEqual([
			{ path: 'a.md', id: 1 },
			{ path: 'b.md', id: 2 },
		]);
	});
});
