import { semanticScoreText } from './semantic';
import type { VaultNoteRecord, VaultSearchResult } from './types';

export type LlmCallFn = (prompt: string) => Promise<string>;

function normalize(text: string): string {
	return text
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function countOverlap(haystack: string, needles: string[]): number {
	const text = normalize(haystack);
	let score = 0;
	for (const needle of needles) {
		if (needle && text.includes(needle)) score += 1;
	}
	return score;
}

function buildRerankText(hit: VaultSearchResult, note?: VaultNoteRecord): string {
	const notePreview = note?.chunks
		.filter(chunk => chunk.id === hit.chunk_id || chunk.heading === hit.heading)
		.slice(0, 2)
		.map(chunk => chunk.content.slice(0, 1000))
		.join(' ') ?? '';

	return [
		hit.title,
		hit.heading,
		...(hit.sectionPath ?? []),
		...(hit.aliases ?? []),
		...(hit.tags ?? []),
		typeof hit.frontmatter['type'] === 'string' ? hit.frontmatter['type'] : '',
		typeof hit.frontmatter['status'] === 'string' ? hit.frontmatter['status'] : '',
		hit.snippet,
		notePreview,
	].filter(Boolean).join(' ');
}

export function rerankSearchResults(
	query: string,
	hits: VaultSearchResult[],
	noteMap: Map<string, VaultNoteRecord>,
	topK = 20,
): VaultSearchResult[] {
	if (!query.trim() || hits.length <= 1) return hits;

	const terms = Array.from(new Set(
		normalize(query).match(/[\p{L}\p{N}_-]{2,}/gu) ?? [],
	));

	const reranked = hits.slice(0, topK).map((hit, index) => {
		const note = noteMap.get(hit.path);
		const rerankText = buildRerankText(hit, note);
		const semantic = semanticScoreText(rerankText, query);
		const titleOverlap = countOverlap(`${hit.title} ${(hit.sectionPath ?? []).join(' ')}`, terms);
		const snippetOverlap = countOverlap(hit.snippet, terms);
		const structural =
			titleOverlap * 0.12 +
			snippetOverlap * 0.05 +
			(index === 0 ? 0.02 : 0);
		const rerankBoost = Math.max(0, semantic) * 0.18 + structural;
		return {
			...hit,
			score: hit.score + rerankBoost,
			reasons: Array.from(new Set([...(hit.reasons ?? []), rerankBoost > 0.18 ? 'rerank' : 'rerank-lite'])),
			retrieval_scores: {
				...(hit.retrieval_scores ?? {}),
				final: hit.score + rerankBoost,
				rerank: rerankBoost,
			} as VaultSearchResult['retrieval_scores'] & { rerank?: number },
		};
	});

	const tail = hits.slice(topK);
	return [...reranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)), ...tail];
}

export async function llmRerankSearchResults(
	query: string,
	hits: VaultSearchResult[],
	callFn: LlmCallFn,
	topK = 8,
): Promise<VaultSearchResult[]> {
	if (!query.trim() || hits.length <= 1) return hits;

	const candidates = hits.slice(0, topK);
	const tail = hits.slice(topK);

	const numbered = candidates.map((hit, i) =>
		`${i}. Titel: ${hit.title}${hit.heading ? ` > ${hit.heading}` : ''}\n   Snippet: ${hit.snippet.slice(0, 200)}`,
	).join('\n');

	const prompt = [
		`Suchanfrage: "${query}"`,
		'',
		'Ordne diese Suchergebnisse nach Relevanz zur Suchanfrage.',
		'Antworte NUR mit einem JSON-Array der Indizes vom relevantesten zum wenigsten relevanten, z.B.: [2,0,3,1]',
		'Erlaeuterungen sind NICHT gewuenscht.',
		'',
		'Ergebnisse:',
		numbered,
	].join('\n');

	try {
		const raw = await callFn(prompt);
		const match = raw.match(/\[[\d,\s]+\]/);
		if (!match) return hits;
		const order = JSON.parse(match[0]) as number[];
		if (!Array.isArray(order) || order.length === 0) return hits;

		const validIndices = order.filter(i => Number.isInteger(i) && i >= 0 && i < candidates.length);
		const seen = new Set<number>(validIndices);
		const remaining = candidates.map((_, i) => i).filter(i => !seen.has(i));
		const reordered = [...validIndices, ...remaining].map(i => ({
			...candidates[i]!,
			reasons: Array.from(new Set([...(candidates[i]!.reasons ?? []), 'llm-rerank'])),
			retrieval_scores: {
				...(candidates[i]!.retrieval_scores ?? {}),
				llm_rerank_pos: validIndices.indexOf(i),
			} as VaultSearchResult['retrieval_scores'] & { llm_rerank_pos?: number },
		}));

		return [...reordered, ...tail];
	} catch {
		return hits;
	}
}
