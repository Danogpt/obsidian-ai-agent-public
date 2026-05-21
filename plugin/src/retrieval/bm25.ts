// BM25 sparse retrieval + Reciprocal Rank Fusion
//
// BM25 parameters (Robertson & Zaragoza defaults):
//   k1 = 1.5 — term-frequency saturation (higher → slower saturation)
//   b  = 0.75 — length-normalization weight (1 = full, 0 = none)
//
// RRF (Cormack et al. 2009):
//   score = Σ 1 / (k + rank_i)   with k = 60

export const BM25_K1 = 1.5;
export const BM25_B = 0.75;
export const RRF_K = 60;

// ── Corpus statistics ──────────────────────────────────────────

export type Bm25Stats = {
	termDf: Map<string, number>;   // document frequency: how many docs contain term
	docCount: number;
	avgDocLength: number;          // average token count per document
};

// Tokenize text for BM25. Returns all tokens WITH repetitions (needed for TF).
export function tokenizeBm25(text: string): string[] {
	return (text.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])
		.filter(token => !/^\d+$/.test(token));
}

/**
 * Build corpus statistics from a set of document strings.
 * Called once at index build time; result is cached in VaultIndex.
 */
export function buildBm25Stats(docTexts: string[]): Bm25Stats {
	const termDf = new Map<string, number>();
	let totalTokens = 0;

	for (const text of docTexts) {
		const tokens = tokenizeBm25(text);
		totalTokens += tokens.length;
		// DF uses set membership (term appears ≥ 1 time in doc = counts once)
		for (const token of new Set(tokens)) {
			termDf.set(token, (termDf.get(token) ?? 0) + 1);
		}
	}

	return {
		termDf,
		docCount: docTexts.length,
		avgDocLength: docTexts.length > 0 ? totalTokens / docTexts.length : 1,
	};
}

// ── BM25 scoring ───────────────────────────────────────────────

/** Inverse document frequency — Robertson's smooth IDF formula. */
export function termIdf(term: string, stats: Bm25Stats): number {
	const df = stats.termDf.get(term) ?? 0;
	if (df === 0) {
		// Unseen term: return smoothed max IDF so it's not ignored
		return Math.log((stats.docCount + 0.5) / 0.5 + 1);
	}
	return Math.log((stats.docCount - df + 0.5) / (df + 0.5) + 1);
}

/** Count occurrences of a literal term in text (case-insensitive). */
export function countTerm(text: string, term: string): number {
	const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return (text.match(new RegExp(escaped, 'gi')) ?? []).length;
}

/**
 * Score a single document against a set of query terms using BM25.
 *
 * @param docText        The document's text (lowercased or mixed — countTerm is case-insensitive)
 * @param docTokenCount  Pre-computed token count for this document (for length normalization)
 * @param queryTerms     Tokenized query terms (each appears at most once)
 * @param stats          Corpus statistics built by buildBm25Stats()
 */
export function bm25ScoreText(
	docText: string,
	docTokenCount: number,
	queryTerms: string[],
	stats: Bm25Stats,
	k1 = BM25_K1,
	b = BM25_B,
): number {
	if (!queryTerms.length || !docText) return 0;
	const avgdl = Math.max(stats.avgDocLength, 1);
	const dl = Math.max(docTokenCount, 1);

	let score = 0;
	for (const term of queryTerms) {
		const tf = countTerm(docText, term);
		if (tf === 0) continue;
		const idf = termIdf(term, stats);
		const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl));
		score += idf * tfNorm;
	}
	return score;
}

// ── Reciprocal Rank Fusion ─────────────────────────────────────

/**
 * Fuse multiple 0-based rank positions into a single RRF score.
 * Higher score = better (appears earlier in more ranked lists).
 *
 * @param ranks   0-based rank positions from each ranked list
 * @param k       Smoothing constant (default: 60)
 */
export function rrfCombine(ranks: number[], k = RRF_K): number {
	return ranks.reduce((sum, rank) => sum + 1 / (k + rank + 1), 0);
}

// ── Field-weighted scoring ─────────────────────────────────────

export type FieldBoost = { text: string; weight: number; tokenCount: number };

/**
 * BM25F-style scoring: apply BM25 independently per field, then combine.
 * Each field has its own length-normalization using the field's avgDocLength.
 */
export function bm25ScoreFields(
	fields: FieldBoost[],
	queryTerms: string[],
	stats: Bm25Stats,
): number {
	if (!queryTerms.length || !fields.length) return 0;
	let total = 0;
	for (const { text, weight, tokenCount } of fields) {
		const fieldScore = bm25ScoreText(text, tokenCount, queryTerms, stats);
		total += weight * fieldScore;
	}
	return total;
}
