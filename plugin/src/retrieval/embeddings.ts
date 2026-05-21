import { requestUrl } from 'obsidian';
import type { ProviderName } from '../models/modelRegistry';
import { ProviderError } from '../providers/http';

export type EmbeddingBackend = 'local' | 'openai' | 'gemini' | 'ollama';

export type EmbeddingConfig = {
	backend: EmbeddingBackend;
	apiKey?: string | null;
	baseUrl?: string | null;
	model?: string;
};

const LOCAL_DIMS = 384;

function hashFeature(feature: string): number {
	let hash = 2166136261;
	for (let index = 0; index < feature.length; index++) {
		hash ^= feature.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return Math.abs(hash >>> 0) % LOCAL_DIMS;
}

function normalize(text: string): string {
	return text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

function addToVec(vector: number[], idx: number, weight: number): void {
	const prev = vector[idx];
	if (prev !== undefined) vector[idx] = prev + weight;
}

export function embedTextLocal(text: string): number[] {
	const vector = Array.from({ length: LOCAL_DIMS }, () => 0);
	const normalized = normalize(text);
	if (!normalized) return vector;
	const tokens = normalized.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
	for (const token of tokens) addToVec(vector, hashFeature(`tok:${token}`), 1.2);
	for (let i = 0; i < tokens.length - 1; i++) {
		const t0 = tokens[i]; const t1 = tokens[i + 1];
		if (t0 && t1) addToVec(vector, hashFeature(`bi:${t0} ${t1}`), 1.0);
	}
	const compact = normalized.replace(/\s+/g, ' ');
	for (let i = 0; i < compact.length - 2; i++) addToVec(vector, hashFeature(`tri:${compact.slice(i, i + 3)}`), 0.35);
	for (let i = 0; i < compact.length - 3; i++) addToVec(vector, hashFeature(`four:${compact.slice(i, i + 4)}`), 0.22);
	for (let i = 0; i < compact.length - 4; i++) addToVec(vector, hashFeature(`five:${compact.slice(i, i + 5)}`), 0.12);
	let norm = 0;
	for (const value of vector) norm += value * value;
	norm = Math.sqrt(norm) || 1;
	return vector.map(value => value / norm);
}

async function embedOpenAI(input: string[], apiKey: string, model = 'text-embedding-3-small'): Promise<number[][]> {
	const response = await requestUrl({
		url: 'https://api.openai.com/v1/embeddings',
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({ model, input }),
		throw: false,
	});
	if (response.status < 200 || response.status >= 300) throw new ProviderError('openai', response.status, response.text);
	const data = response.json as { data?: Array<{ embedding: number[] }> };
	return (data.data ?? []).map(item => item.embedding);
}

async function embedGemini(input: string[], apiKey: string, model = 'text-embedding-004'): Promise<number[][]> {
	const output: number[][] = [];
	for (const text of input) {
		const response = await requestUrl({
			url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: { parts: [{ text }] } }),
			throw: false,
		});
		if (response.status < 200 || response.status >= 300) throw new ProviderError('gemini', response.status, response.text);
		const data = response.json as { embedding?: { values?: number[] } };
		output.push(data.embedding?.values ?? []);
	}
	return output;
}

async function embedOllama(input: string[], baseUrl: string, model = 'nomic-embed-text'): Promise<number[][]> {
	const output: number[][] = [];
	for (const prompt of input) {
		const response = await requestUrl({
			url: `${baseUrl.replace(/\/$/, '')}/api/embeddings`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model, prompt }),
			throw: false,
		});
		if (response.status < 200 || response.status >= 300) throw new ProviderError('ollama', response.status, response.text);
		const data = response.json as { embedding?: number[] };
		output.push(data.embedding ?? []);
	}
	return output;
}

export async function embedBatch(texts: string[], config: EmbeddingConfig): Promise<number[][]> {
	if (!texts.length) return [];
	if (config.backend === 'local') return texts.map(embedTextLocal);
	if (config.backend === 'openai') {
		if (!config.apiKey) throw new ProviderError('openai', 0, 'Embedding API key missing.');
		return embedOpenAI(texts, config.apiKey, config.model);
	}
	if (config.backend === 'gemini') {
		if (!config.apiKey) throw new ProviderError('gemini', 0, 'Embedding API key missing.');
		return embedGemini(texts, config.apiKey, config.model);
	}
	if (!config.baseUrl) throw new ProviderError('ollama', 0, 'Ollama base URL missing.');
	return embedOllama(texts, config.baseUrl, config.model);
}

export async function embedText(text: string, config: EmbeddingConfig): Promise<number[]> {
	const [embedding] = await embedBatch([text], config);
	return embedding ?? [];
}

export function getEmbeddingBackend(provider?: ProviderName | EmbeddingBackend): EmbeddingBackend {
	if (!provider) return 'local';
	if (provider === 'openai' || provider === 'gemini' || provider === 'ollama' || provider === 'local') return provider;
	return 'local';
}

export function cosineSimilarity(a: number[], b: number[]): number {
	if (!a.length || !b.length) return 0;
	const length = Math.min(a.length, b.length);
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let index = 0; index < length; index++) {
		const av = a[index] ?? 0;
		const bv = b[index] ?? 0;
		dot += av * bv;
		normA += av * av;
		normB += bv * bv;
	}
	return normA > 0 && normB > 0 ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}
