import type { EmbeddingBackend } from './embeddings';
import type { StoredVector } from './vectorStore';

export type IndexWorkerJob =
	| { type: 'chunk'; path: string; content: string }
	| { type: 'embed'; hash: string; text: string; backend: EmbeddingBackend; path?: string }
	| { type: 'embed_batch'; items: Array<{ hash: string; text: string; path?: string }>; backend: EmbeddingBackend }
	| { type: 'reindex'; path: string };

export type IndexWorkerResult =
	| { type: 'chunked'; path: string }
	| { type: 'embedded'; hash: string; vector: number[] }
	| { type: 'embedded_batch'; items: Array<{ hash: string; vector: number[] }> }
	| { type: 'reindexed'; path: string }
	| { type: 'error'; message: string };

export type PersistedEmbeddingCache = {
	items: StoredVector[];
};
