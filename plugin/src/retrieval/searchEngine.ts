import {
	bm25ScoreText,
	buildBm25Stats,
	countTerm,
	RRF_K,
	rrfCombine,
	termIdf,
	tokenizeBm25,
	type Bm25Stats,
} from './bm25';
import { computePersonalizedRanks } from './linkGraph';
import { buildSemanticNoteText, semanticScoreText } from './semantic';
import type { VaultChunkRecord, VaultNoteRecord, VaultSearchFilters, VaultSearchResult } from './types';

export type { Bm25Stats };

// Asymmetric RRF k-values:
// BM25 list uses standard k=60; graph rank uses k=120 (half the influence).
// This means exact keyword matches dominate, but link graph helps for vague queries.
const RRF_K_BM25 = RRF_K;       // 60
const RRF_K_GRAPH = RRF_K * 2;  // 120
const RRF_K_SEMANTIC = Math.round(RRF_K * 1.5);

// ── Filters ────────────────────────────────────────────────────

function normalizeScalar(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value.trim().toLowerCase();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value).toLowerCase();
	return '';
}

function asTime(value: unknown): number | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : null;
}

function matchesFilters(note: VaultNoteRecord, filters?: VaultSearchFilters): boolean {
	if (!filters) return true;

	if (filters.type) {
		if (normalizeScalar(note.frontmatter['type']) !== normalizeScalar(filters.type)) return false;
	}
	if (filters.status) {
		if (normalizeScalar(note.frontmatter['status']) !== normalizeScalar(filters.status)) return false;
	}
	if (filters.alias) {
		const aliasNeedle = normalizeScalar(filters.alias);
		if (!note.aliases.some(alias => alias.toLowerCase().includes(aliasNeedle))) return false;
	}
	if (filters.folder) {
		const folderNeedle = normalizeScalar(filters.folder);
		if (!note.folder.toLowerCase().includes(folderNeedle)) return false;
	}
	if (filters.path) {
		const pathNeedle = normalizeScalar(filters.path);
		if (!note.path.toLowerCase().includes(pathNeedle)) return false;
	}
	if (filters.tag) {
		const requiredTags = Array.isArray(filters.tag) ? filters.tag : [filters.tag];
		const noteTags = note.tags.map(tag => tag.toLowerCase().replace(/^#/, ''));
		for (const tag of requiredTags) {
			const normalizedTag = normalizeScalar(tag).replace(/^#/, '');
			if (!noteTags.includes(normalizedTag)) return false;
		}
	}
	if (filters.after || filters.before) {
		const noteDate = [
			asTime(note.frontmatter['date']),
			asTime(note.frontmatter['created']),
			asTime(note.frontmatter['updated']),
		].find((value): value is number => value !== null) ?? null;
		if (filters.after) {
			const after = asTime(filters.after);
			if (after !== null && (noteDate === null || noteDate < after)) return false;
		}
		if (filters.before) {
			const before = asTime(filters.before);
			if (before !== null && (noteDate === null || noteDate > before)) return false;
		}
	}

	return true;
}

// ── Folder weight ──────────────────────────────────────────────

function getFolderWeight(note: VaultNoteRecord): number {
	const explicit = note.frontmatter['ai_folder_weight'] ?? note.frontmatter['folder_weight'];
	if (typeof explicit === 'number' && Number.isFinite(explicit)) {
		return Math.max(0, explicit);
	}
	const folder = note.folder.toLowerCase();
	if (!folder) return 1;
	if (folder.includes('archive')) return 0.55;
	if (folder.includes('template')) return 0.7;
	if (folder.includes('daily') || folder.includes('journal') || folder.includes('journals')) return 0.75;
	return 1;
}

// ── Note-level BM25F ──────────────────────────────────────────

/**
 * Score a note against query terms using BM25F-style multi-field scoring.
 *
 * Field weights applied via additive IDF boosts on top of content BM25:
 *   title      +2.0 × IDF per matching term
 *   tag/alias  +1.5 × IDF per matching term
 *   heading    +1.0 × IDF per matching term
 *   type/status+1.0 × IDF per matching term
 *
 * Content uses standard BM25 with global corpus IDF.
 */
function scoreNoteBm25(
	note: VaultNoteRecord,
	queryTerms: string[],
	noteStats: Bm25Stats,
): number {
	if (!queryTerms.length) return 0;

	const contentText = note.chunks
		.filter(chunk => chunk.blockType !== 'frontmatter' && chunk.blockType !== 'block')
		.map(chunk => chunk.searchText)
		.join(' ');
	const contentTokenCount = note.chunks
		.filter(chunk => chunk.blockType !== 'frontmatter' && chunk.blockType !== 'block')
		.reduce((sum, chunk) => sum + chunk.tokenCount, 0);

	let score = bm25ScoreText(contentText, contentTokenCount, queryTerms, noteStats);

	for (const term of queryTerms) {
		const idf = termIdf(term, noteStats);
		if (countTerm(note.title, term) > 0) score += idf * 2.0;
		if (note.tags.some(tag => countTerm(tag, term) > 0)) score += idf * 1.5;
		if (note.aliases.some(alias => countTerm(alias, term) > 0)) score += idf * 1.5;
		if (note.headings.some(h => countTerm(h.text, term) > 0)) score += idf * 1.0;
		if (
			countTerm(normalizeScalar(note.frontmatter['type']), term) > 0 ||
			countTerm(normalizeScalar(note.frontmatter['status']), term) > 0
		) score += idf * 1.0;
	}

	return score;
}

// ── Chunk-level BM25 ──────────────────────────────────────────

function scoreChunkBm25(
	chunk: VaultChunkRecord,
	queryTerms: string[],
	chunkStats: Bm25Stats,
): number {
	if (!queryTerms.length) return 0;

	let score = bm25ScoreText(chunk.searchText, chunk.tokenCount, queryTerms, chunkStats);

	for (const term of queryTerms) {
		const idf = termIdf(term, chunkStats);
		if (chunk.heading && countTerm(chunk.heading, term) > 0) score += idf * 1.2;
		if (chunk.sectionPath.some(part => countTerm(part, term) > 0)) score += idf * 0.8;
	}

	if (chunk.blockType === 'frontmatter') score += 0.5;
	if (chunk.startLine < 40) score += 0.3;
	return score;
}

function buildChunkSemanticText(chunk: VaultChunkRecord): string {
	return [
		chunk.title,
		chunk.heading,
		chunk.sectionPath.join(' '),
		chunk.content.slice(0, 1200),
	].filter(Boolean).join(' ');
}

// ── Main search ────────────────────────────────────────────────

export function searchVaultIndex(
	notes: VaultNoteRecord[],
	query: string,
	options?: {
		limit?: number;
		activePath?: string;
		referencedPaths?: string[];
		recentPaths?: string[];
		folderPath?: string;
		excludePaths?: string[];
		filters?: VaultSearchFilters;
		noteStats?: Bm25Stats;    // pre-built by VaultIndex; falls back to on-the-fly build
		chunkStats?: Bm25Stats;
	},
): VaultSearchResult[] {
	const queryTerms = Array.from(new Set(tokenizeBm25(query)));
	const hasStructuralFilter = Boolean(
		options?.filters?.type ||
		options?.filters?.status ||
		options?.filters?.tag ||
		options?.filters?.alias ||
		options?.filters?.folder ||
		options?.filters?.path ||
		options?.filters?.after ||
		options?.filters?.before,
	);
	if (!queryTerms.length && !hasStructuralFilter) return [];

	// Use pre-built corpus stats from VaultIndex, or build on the fly as a cold-start fallback
	let noteStats = options?.noteStats;
	let chunkStats = options?.chunkStats;
	if (!noteStats || !chunkStats) {
		const noteTexts = notes.map(note => note.chunks.map(c => c.searchText).join(' '));
		const chunkTexts = notes.flatMap(note => note.chunks.map(c => c.searchText));
		noteStats ??= buildBm25Stats(noteTexts);
		chunkStats ??= buildBm25Stats(chunkTexts);
	}

	const limit = options?.limit ?? 20;
	const excluded = new Set(options?.excludePaths ?? []);
	const byPath = new Map(notes.map(note => [note.path, note] as const));

	// ── Phase 1: BM25 note scoring ─────────────────────────────

	const bm25Candidates: Array<{ note: VaultNoteRecord; bm25: number }> = [];

	for (const note of notes) {
		if (excluded.has(note.path)) continue;
		if (!matchesFilters(note, options?.filters)) continue;

		let bm25 = queryTerms.length
			? scoreNoteBm25(note, queryTerms, noteStats)
			: 1;

		if (options?.folderPath && note.path.startsWith(`${options.folderPath}/`)) bm25 *= 1.5;
		bm25 *= getFolderWeight(note);

		if (bm25 <= 0) continue;
		bm25Candidates.push({ note, bm25 });
	}

	bm25Candidates.sort((a, b) => b.bm25 - a.bm25 || a.note.path.localeCompare(b.note.path));
	const bm25RankIndex = new Map(bm25Candidates.map(({ note }, i) => [note.path, i]));

	// Phase 1b: semantic note scoring (local hashed semantic sketch)
	const semanticCandidates: Array<{ note: VaultNoteRecord; semantic: number }> = [];
	for (const note of notes) {
		if (excluded.has(note.path)) continue;
		if (!matchesFilters(note, options?.filters)) continue;

		const bodyPreview = note.chunks
			.filter(chunk => chunk.blockType !== 'frontmatter')
			.slice(0, 2)
			.map(chunk => chunk.content.slice(0, 500))
			.join(' ');
		const semanticText = buildSemanticNoteText({
			title: note.title,
			aliases: note.aliases,
			tags: note.tags,
			headings: note.headings.map(heading => heading.text),
			summary: note.summary,
			frontmatter: note.frontmatter,
			bodyPreview,
		});
		let semantic = semanticScoreText(semanticText, query);
		if (options?.folderPath && note.path.startsWith(`${options.folderPath}/`)) semantic *= 1.2;
		semantic *= getFolderWeight(note);
		if (semantic > 0) semanticCandidates.push({ note, semantic });
	}
	semanticCandidates.sort((a, b) => b.semantic - a.semantic || a.note.path.localeCompare(b.note.path));
	const semanticRankIndex = new Map(semanticCandidates.map(({ note }, i) => [note.path, i]));

	// ── Phase 2: Personalized PageRank ────────────────────────

	const graphRanks = computePersonalizedRanks(notes, {
		activePath: options?.activePath,
		referencedPaths: options?.referencedPaths,
		recentPaths: options?.recentPaths,
	});

	// Graph rank over the same filtered candidates only
	const graphCandidates = bm25Candidates
		.map(({ note }) => ({ note, graphScore: graphRanks.get(note.path) ?? 0 }))
		.sort((a, b) => b.graphScore - a.graphScore || a.note.path.localeCompare(b.note.path));
	const graphRankIndex = new Map(graphCandidates.map(({ note }, i) => [note.path, i]));

	// ── Phase 3: RRF fusion ───────────────────────────────────

	const activeTags = options?.activePath
		? new Set(byPath.get(options.activePath)?.tags.map(tag => tag.toLowerCase().replace(/^#/, '')) ?? [])
		: new Set<string>();
	const activeFolder = options?.activePath ? (byPath.get(options.activePath)?.folder ?? '') : '';

	const shortlistSize = Math.max(limit * 5, 30);
	const candidateSet = new Set<string>();
	bm25Candidates.slice(0, shortlistSize).forEach(({ note }) => candidateSet.add(note.path));
	graphCandidates.slice(0, shortlistSize).forEach(({ note }) => candidateSet.add(note.path));
	semanticCandidates.slice(0, shortlistSize).forEach(({ note }) => candidateSet.add(note.path));

	const rrfScored: Array<{ note: VaultNoteRecord; rrf: number }> = [];

	for (const path of candidateSet) {
		const note = byPath.get(path);
		if (!note) continue;

		const bm25Rank = bm25RankIndex.get(path) ?? shortlistSize;
		const graphRank = graphRankIndex.get(path) ?? shortlistSize;
		const semanticRank = semanticRankIndex.get(path) ?? shortlistSize;

		let rrfScore = rrfCombine([bm25Rank], RRF_K_BM25)
			+ rrfCombine([graphRank], RRF_K_GRAPH)
			+ rrfCombine([semanticRank], RRF_K_SEMANTIC);

		// Contextual boosts applied after RRF (multiplicative to stay calibrated)
		const sharedTags = note.tags
			.map(tag => tag.toLowerCase().replace(/^#/, ''))
			.filter(tag => activeTags.has(tag)).length;
		if (sharedTags > 0) rrfScore *= 1 + Math.min(sharedTags * 0.2, 0.6);
		if (activeFolder && note.folder === activeFolder) rrfScore *= 1.15;
		if (options?.activePath && note.path === options.activePath) rrfScore *= 1.2;

		rrfScored.push({ note, rrf: rrfScore });
	}

	rrfScored.sort((a, b) => b.rrf - a.rrf || a.note.path.localeCompare(b.note.path));
	const shortlisted = rrfScored.slice(0, limit * 3);

	// ── Phase 4: Chunk-level BM25 ─────────────────────────────

	const hits: VaultSearchResult[] = [];

	for (const { note, rrf } of shortlisted) {
		let bestChunk: VaultChunkRecord | null = null;
		let bestChunkScore = -Infinity;
		let bestChunkSemantic = 0;

		for (const chunk of note.chunks) {
			const chunkBm25 = queryTerms.length
				? scoreChunkBm25(chunk, queryTerms, chunkStats)
				: chunk.blockType === 'frontmatter' ? 1 : 0.5;
			const chunkSemantic = semanticScoreText(buildChunkSemanticText(chunk), query);
			const chunkScore = chunkBm25 + chunkSemantic * 4;
			if (chunkScore > bestChunkScore) {
				bestChunkScore = chunkScore;
				bestChunk = chunk;
				bestChunkSemantic = chunkSemantic;
			}
		}

		if (!bestChunk) continue;

		const reasons: string[] = [];
		const semanticRank = semanticRankIndex.get(note.path);
		const graphRank = graphRankIndex.get(note.path);
		const sharedTags = note.tags
			.map(tag => tag.toLowerCase().replace(/^#/, ''))
			.filter(tag => activeTags.has(tag)).length;
		if ((bm25RankIndex.get(note.path) ?? shortlistSize) < shortlistSize / 2) reasons.push('keyword');
		if (typeof semanticRank === 'number' && semanticRank < shortlistSize / 2) reasons.push('semantic');
		if (typeof graphRank === 'number' && graphRank < shortlistSize / 2) reasons.push('graph');
		if (sharedTags > 0) reasons.push(`shared_tags:${sharedTags}`);
		if (activeFolder && note.folder === activeFolder) reasons.push('same_folder');
		if (bestChunk.heading) reasons.push(`heading:${bestChunk.heading}`);
		if (bestChunkSemantic > 0.2) reasons.push('semantic_chunk');

		// RRF is the primary score; chunk BM25 provides tie-breaking
		hits.push({
			path: note.path,
			name: note.name,
			title: note.title,
			score: rrf + Math.max(bestChunkScore, 0) * 0.05,
			chunk_id: bestChunk.id,
			block_type: bestChunk.blockType,
			heading: bestChunk.heading,
			sectionPath: bestChunk.sectionPath,
			line_range: [bestChunk.startLine, bestChunk.endLine],
			snippet: bestChunk.content.slice(0, 900),
			tags: note.tags,
			aliases: note.aliases,
			frontmatter: note.frontmatter,
			chunkCount: note.chunks.length,
			reasons: Array.from(new Set(reasons)),
			retrieval_scores: {
				final: rrf + Math.max(bestChunkScore, 0) * 0.05,
				graph: graphRankIndex.get(note.path) !== undefined ? (graphRanks.get(note.path) ?? 0) : undefined,
				dense: semanticRank !== undefined ? shortlistSize - semanticRank : undefined,
				chunk: bestChunkScore,
			},
		});
	}

	hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	return hits.slice(0, limit);
}
