import { describe, it, expect } from 'vitest';
import {
	applyRetrievalConfidenceGate,
	diversifyRetrievedHitsByPath,
	hasExplicitFolderScope,
	resolveRouteRetrievalPolicyForTest,
	scoreRetrievedHitConfidence,
	shouldCollectFrontmatterContextForMessage,
	shouldSkipAllAutomaticContext,
	shouldUseLlmRerankForIntent,
} from '../context/contextResolver';

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

describe('retrieval confidence gate', () => {
	it('scores strongly supported hits as high confidence', () => {
		const score = scoreRetrievedHitConfidence({
			score: 10,
			reasons: ['keyword', 'semantic_chunk', 'heading:Important'],
			retrieval_scores: { chunk: 12, final: 10 },
		}, 10);

		expect(score).toBeGreaterThanOrEqual(0.74);
	});

	it('filters low confidence hits before they enter prompt context', () => {
		const decisions = applyRetrievalConfidenceGate([
			{ score: 10, reasons: ['vector'], retrieval_scores: { final: 10 } },
			{ score: 8, reasons: [], retrieval_scores: { final: 8 } },
		], 'fact_lookup');

		expect(decisions.every(decision => decision.include)).toBe(false);
		expect(decisions.every(decision => decision.confidence === 'low')).toBe(true);
	});

	it('keeps medium confidence hits as short references only', () => {
		const [decision] = applyRetrievalConfidenceGate([
			{ score: 10, reasons: ['keyword', 'semantic'], retrieval_scores: { final: 10 } },
		], 'fact_lookup');

		expect(decision?.include).toBe(true);
		expect(decision?.confidence).toBe('medium');
		expect(decision?.shortReferenceOnly).toBe(true);
	});

	it('uses a lower medium floor for explicit vault research', () => {
		const [decision] = applyRetrievalConfidenceGate([
			{ score: 10, reasons: ['semantic'], retrieval_scores: { final: 10 } },
		], 'vault_research');

		expect(decision?.include).toBe(true);
		expect(decision?.confidence).toBe('medium');
	});
});

describe('explicit folder context scope', () => {
	it('treats a selected folder context mode as explicit folder scope', () => {
		expect(hasExplicitFolderScope(['active_file', 'folder'], 'Semester 6/Abschlussarbeit', [])).toBe(true);
	});

	it('does not treat folder mode without a folder path as explicit folder scope', () => {
		expect(hasExplicitFolderScope(['active_file', 'folder'], undefined, [])).toBe(false);
	});

	it('treats mentioned folder context items as explicit folder scope', () => {
		expect(hasExplicitFolderScope(['active_file'], undefined, [{ type: 'folder' }])).toBe(true);
	});
});

describe('frontmatter context trigger', () => {
	it('does not trigger structured frontmatter context for normal project wording', () => {
		expect(shouldCollectFrontmatterContextForMessage(
			'Das Projekt overall ist ein Terminal fuer paid Nutzer.',
			{ tags: [], vault: false },
		)).toBe(false);
	});

	it('triggers structured frontmatter context for explicit filters', () => {
		expect(shouldCollectFrontmatterContextForMessage(
			'Liste alle Notes mit project:SGCP und status:open',
			{ tags: [], vault: false },
		)).toBe(true);
	});
});

describe('route retrieval policy', () => {
	const route = (mode: 'ask' | 'edit' | 'agent' | 'plan') => ({
		mode,
		needsPlanner: mode === 'agent' || mode === 'plan',
		allowWrites: mode === 'edit' || mode === 'agent',
		maxRetrievedChunks: mode === 'edit' ? 3 : mode === 'ask' ? 5 : 10,
		reason: mode,
		confidence: 'med' as const,
	});

	it('keeps plan mode with active-file-only context on fallback retrieval', () => {
		const policy = resolveRouteRetrievalPolicyForTest(
			route('plan'),
			{ contextModes: ['active_file'] },
		);

		expect(policy.retrievalMode).toBe('fallback');
		expect(policy.includeVaultMap).toBe(false);
	});

	it('allows primary retrieval when vault context is explicitly selected for plan mode', () => {
		const policy = resolveRouteRetrievalPolicyForTest(
			route('plan'),
			{ contextModes: ['active_file', 'vault'] },
		);

		expect(policy.retrievalMode).toBe('primary');
		expect(policy.includeVaultMap).toBe(true);
	});

	it.each(['ask', 'edit', 'agent', 'plan'] as const)('uses no retrieval when context mode is none for %s', mode => {
		const policy = resolveRouteRetrievalPolicyForTest(
			route(mode),
			{ contextModes: ['none'] },
		);

		expect(policy.retrievalMode).toBe('none');
		expect(policy.includeVaultMap).toBe(false);
		expect(policy.includeLinkedContext).toBe(false);
		expect(policy.retrievedChunkCount).toBe(0);
	});

	it.each(['ask', 'edit', 'agent', 'plan'] as const)('keeps active-file-only context scoped for %s', mode => {
		const policy = resolveRouteRetrievalPolicyForTest(
			route(mode),
			{ contextModes: ['active_file'] },
		);

		expect(policy.retrievalMode).toBe('fallback');
		expect(policy.includeVaultMap).toBe(false);
		expect(policy.includeLinkedContext).toBe(false);
	});

	it.each(['ask', 'edit', 'agent', 'plan'] as const)('keeps selected folder context scoped for %s', mode => {
		const policy = resolveRouteRetrievalPolicyForTest(
			route(mode),
			{ contextModes: ['folder'], folderPath: 'Semester 6/Abschlussarbeit' },
		);

		expect(policy.retrievalMode).toBe('fallback');
		expect(policy.includeVaultMap).toBe(false);
		expect(policy.includeLinkedContext).toBe(false);
	});

	it.each(['ask', 'agent', 'plan'] as const)('allows primary retrieval when vault context is selected for %s', mode => {
		const policy = resolveRouteRetrievalPolicyForTest(
			route(mode),
			{ contextModes: ['vault'] },
		);

		expect(policy.retrievalMode).toBe('primary');
	});

	it('keeps edit scoped even if vault context is selected', () => {
		const policy = resolveRouteRetrievalPolicyForTest(
			route('edit'),
			{ contextModes: ['vault'] },
		);

		expect(policy.retrievalMode).toBe('fallback');
		expect(policy.includeVaultMap).toBe(false);
		expect(policy.retrievedChunkCount).toBe(3);
	});
});

describe('none context mode', () => {
	it('skips all automatic context when none is the only selected mode', () => {
		expect(shouldSkipAllAutomaticContext(['none'])).toBe(true);
	});

	it('does not skip context when none is not the only selected mode', () => {
		expect(shouldSkipAllAutomaticContext(['active_file'])).toBe(false);
		expect(shouldSkipAllAutomaticContext(['active_file', 'none'])).toBe(false);
	});
});
