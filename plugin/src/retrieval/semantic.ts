const DEFAULT_DIMS = 384;
const QUERY_CACHE_LIMIT = 256;

type SparseVector = Map<number, number>;

const textVectorCache = new Map<string, SparseVector>();

function normalizeText(text: string): string {
	return text
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function hashFeature(feature: string, dims: number): number {
	let hash = 2166136261;
	for (let index = 0; index < feature.length; index++) {
		hash ^= feature.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return Math.abs(hash >>> 0) % dims;
}

function pushFeature(vector: SparseVector, feature: string, weight: number, dims: number) {
	if (!feature) return;
	const bucket = hashFeature(feature, dims);
	vector.set(bucket, (vector.get(bucket) ?? 0) + weight);
}

function buildFeatures(text: string): SparseVector {
	const normalized = normalizeText(text);
	const vector: SparseVector = new Map();
	if (!normalized) return vector;

	const tokens = normalized.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
	for (const token of tokens) {
		pushFeature(vector, `tok:${token}`, 1.2, DEFAULT_DIMS);
	}
	for (let index = 0; index < tokens.length - 1; index++) {
		pushFeature(vector, `bi:${tokens[index]} ${tokens[index + 1]}`, 1.0, DEFAULT_DIMS);
	}

	const compact = normalized.replace(/\s+/g, ' ');
	for (let index = 0; index < compact.length - 2; index++) {
		pushFeature(vector, `tri:${compact.slice(index, index + 3)}`, 0.35, DEFAULT_DIMS);
	}
	// 4-grams: improves recall for compound words (e.g. "Projektmanagement" shares
	// 4-grams with both "Projekt" and "Management" — critical for German vaults).
	for (let index = 0; index < compact.length - 3; index++) {
		pushFeature(vector, `four:${compact.slice(index, index + 4)}`, 0.22, DEFAULT_DIMS);
	}
	// 5-grams: additional coverage for longer compound words at lower weight.
	for (let index = 0; index < compact.length - 4; index++) {
		pushFeature(vector, `five:${compact.slice(index, index + 5)}`, 0.12, DEFAULT_DIMS);
	}

	let norm = 0;
	for (const value of vector.values()) {
		norm += value * value;
	}
	norm = Math.sqrt(norm) || 1;
	for (const [bucket, value] of vector.entries()) {
		vector.set(bucket, value / norm);
	}
	return vector;
}

function getVector(text: string): SparseVector {
	const normalized = normalizeText(text);
	const cached = textVectorCache.get(normalized);
	if (cached) return cached;
	const vector = buildFeatures(normalized);
	textVectorCache.set(normalized, vector);
	if (textVectorCache.size > QUERY_CACHE_LIMIT) {
		let firstKey: string | undefined;
		for (const key of textVectorCache.keys()) {
			firstKey = key;
			break;
		}
		if (typeof firstKey === 'string') textVectorCache.delete(firstKey);
	}
	return vector;
}

function cosine(a: SparseVector, b: SparseVector): number {
	let dot = 0;
	const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
	for (const [bucket, value] of smaller.entries()) {
		dot += value * (larger.get(bucket) ?? 0);
	}
	return Math.max(0, dot);
}

export function semanticScoreText(documentText: string, queryText: string): number {
	if (!documentText || !queryText) return 0;
	const doc = getVector(documentText);
	const query = getVector(queryText);
	return cosine(doc, query);
}

export function buildSemanticNoteText(input: {
	title: string;
	aliases?: string[];
	tags?: string[];
	headings?: string[];
	summary?: string;
	frontmatter?: Record<string, unknown>;
	bodyPreview?: string;
}): string {
	const frontmatterBits = [
		typeof input.frontmatter?.['type'] === 'string' ? input.frontmatter['type'] : '',
		typeof input.frontmatter?.['status'] === 'string' ? input.frontmatter['status'] : '',
	].filter(Boolean);

	return [
		input.title,
		...(input.aliases ?? []),
		...(input.tags ?? []),
		...(input.headings ?? []),
		...frontmatterBits,
		input.summary ?? '',
		input.bodyPreview ?? '',
	].filter(Boolean).join(' ');
}
