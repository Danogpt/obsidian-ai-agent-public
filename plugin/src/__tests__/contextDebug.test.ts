import { describe, expect, it } from 'vitest';
import { buildContextDebugSnapshot } from '../context/contextDebug';

describe('buildContextDebugSnapshot', () => {
	it('compares raw and compacted context items', () => {
		const snapshot = buildContextDebugSnapshot({
			rawContext: [
				{ type: 'active_file', label: 'A', path: 'A.md', content: 'a'.repeat(100) },
				{ type: 'retrieved_chunk', label: 'B', path: 'B.md', content: 'b'.repeat(100), stats: { retrieval_confidence: 'low' } },
			],
			finalContext: [
				{ type: 'active_file', label: 'A', path: 'A.md', content: `a${'\n\n[... truncated by context budget ...]'}` },
			],
			contextModes: ['active_file'],
			query: 'test',
			maxContextChars: 5000,
			estimatedTokens: 1200,
			mode: 'ask',
			modeReason: 'test route',
			intentConfidence: 'high',
			intentSignals: ['unit'],
		});

		expect(snapshot.summary.rawItems).toBe(2);
		expect(snapshot.summary.finalItems).toBe(1);
		expect(snapshot.summary.droppedItems).toBe(1);
		expect(snapshot.items[0]?.mode).toBe('trimmed');
		expect(snapshot.items[1]).toMatchObject({
			type: 'retrieved_chunk',
			included: false,
			mode: 'dropped',
		});
	});

	it('surfaces retrieval stats and reasons for included items', () => {
		const snapshot = buildContextDebugSnapshot({
			rawContext: [
				{
					type: 'retrieved_chunk',
					label: 'Hit',
					path: 'Hit.md',
					content: 'content',
					reasons: ['keyword'],
					stats: { retrieval_confidence: 'medium', confidence_score: 0.61 },
				},
			],
			finalContext: [
				{
					type: 'retrieved_chunk',
					label: 'Hit',
					path: 'Hit.md',
					content: 'content',
					reasons: ['keyword'],
					stats: { retrieval_confidence: 'medium', confidence_score: 0.61 },
				},
			],
			contextModes: ['vault'],
			query: 'hit',
			maxContextChars: 5000,
			estimatedTokens: 800,
			mode: 'agent',
			modeReason: 'research',
			intentConfidence: 'medium',
		});

		expect(snapshot.items[0]?.stats.retrieval_confidence).toBe('medium');
		expect(snapshot.items[0]?.reasons).toEqual(['keyword']);
	});
});
