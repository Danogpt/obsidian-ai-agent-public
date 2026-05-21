import { embedText, embedTextLocal, type EmbeddingConfig } from './embeddings';
import type { IndexWorkerJob, IndexWorkerResult } from './workerProtocol';

function buildLocalWorkerSource(): string {
	return `
function hashFeature(feature) {
	let hash = 2166136261;
	for (let index = 0; index < feature.length; index++) {
		hash ^= feature.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return Math.abs(hash >>> 0) % 384;
}
function normalize(text) {
	return text.toLowerCase().normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').replace(/\\s+/g, ' ').trim();
}
function embedTextLocal(text) {
	const vector = Array.from({ length: 384 }, () => 0);
	const normalized = normalize(text);
	if (!normalized) return vector;
	const tokens = normalized.match(/[\\p{L}\\p{N}_-]{2,}/gu) ?? [];
	for (const token of tokens) vector[hashFeature('tok:' + token)] += 1.2;
	for (let i = 0; i < tokens.length - 1; i++) vector[hashFeature('bi:' + tokens[i] + ' ' + tokens[i + 1])] += 1.0;
	const compact = normalized.replace(/\\s+/g, ' ');
	for (let i = 0; i < compact.length - 2; i++) vector[hashFeature('tri:' + compact.slice(i, i + 3))] += 0.35;
	for (let i = 0; i < compact.length - 3; i++) vector[hashFeature('four:' + compact.slice(i, i + 4))] += 0.22;
	for (let i = 0; i < compact.length - 4; i++) vector[hashFeature('five:' + compact.slice(i, i + 5))] += 0.12;
	let norm = 0;
	for (const value of vector) norm += value * value;
	norm = Math.sqrt(norm) || 1;
	return vector.map(value => value / norm);
}
self.onmessage = (event) => {
	try {
		const job = event.data;
		if (job.type === 'chunk') {
			self.postMessage({ type: 'chunked', path: job.path });
			return;
		}
		if (job.type === 'embed') {
			self.postMessage({ type: 'embedded', hash: job.hash, vector: embedTextLocal(job.text) });
			return;
		}
		if (job.type === 'embed_batch') {
			self.postMessage({
				type: 'embedded_batch',
				items: job.items.map(item => ({ hash: item.hash, vector: embedTextLocal(item.text) })),
			});
			return;
		}
		self.postMessage({ type: 'reindexed', path: job.path });
	} catch (error) {
		self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
	}
};`;
}

async function runIndexWorkerJobFallback(job: IndexWorkerJob, embeddingConfig?: EmbeddingConfig): Promise<IndexWorkerResult> {
	try {
		if (job.type === 'chunk') return { type: 'chunked', path: job.path };
		if (job.type === 'embed') {
			if (job.backend === 'local') {
				return { type: 'embedded', hash: job.hash, vector: embedTextLocal(job.text) };
			}
			const vector = await embedText(job.text, {
				...(embeddingConfig ?? {}),
				backend: job.backend,
			});
			return { type: 'embedded', hash: job.hash, vector };
		}
		if (job.type === 'embed_batch') {
			if (job.backend === 'local') {
				return {
					type: 'embedded_batch',
					items: job.items.map(item => ({ hash: item.hash, vector: embedTextLocal(item.text) })),
				};
			}
			const vectors = await Promise.all(job.items.map(item => embedText(item.text, {
				...(embeddingConfig ?? {}),
				backend: job.backend,
			})));
			return {
				type: 'embedded_batch',
				items: job.items.map((item, index) => ({ hash: item.hash, vector: vectors[index] ?? [] })),
			};
		}
		return { type: 'reindexed', path: job.path };
	} catch (error) {
		return { type: 'error', message: error instanceof Error ? error.message : String(error) };
	}
}

export class IndexWorkerManager {
	private worker: Worker | null = null;

	private ensureWorker(): Worker | null {
		if (this.worker) return this.worker;
		if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') return null;
		try {
			const blob = new Blob([buildLocalWorkerSource()], { type: 'text/javascript' });
			this.worker = new Worker(URL.createObjectURL(blob));
			return this.worker;
		} catch {
			return null;
		}
	}

	async run(job: IndexWorkerJob, embeddingConfig?: EmbeddingConfig): Promise<IndexWorkerResult> {
		if ((job.type !== 'embed' && job.type !== 'embed_batch') || job.backend !== 'local') {
			return runIndexWorkerJobFallback(job, embeddingConfig);
		}

		const worker = this.ensureWorker();
		if (!worker) return runIndexWorkerJobFallback(job, embeddingConfig);

		return new Promise<IndexWorkerResult>((resolve) => {
			const onMessage = (event: MessageEvent<IndexWorkerResult>) => {
				cleanup();
				resolve(event.data);
			};
			const onError = (event: ErrorEvent) => {
				cleanup();
				resolve({ type: 'error', message: event.message });
			};
			const cleanup = () => {
				worker.removeEventListener('message', onMessage as EventListener);
				worker.removeEventListener('error', onError as EventListener);
			};
			worker.addEventListener('message', onMessage as EventListener);
			worker.addEventListener('error', onError as EventListener);
			worker.postMessage(job);
		});
	}

	async runBatch(
		jobs: Array<Extract<IndexWorkerJob, { type: 'embed' }>>,
		embeddingConfig?: EmbeddingConfig,
	): Promise<Array<{ hash: string; vector: number[] }>> {
		if (!jobs.length) return [];
		const backend = jobs[0]?.backend ?? 'local';
		const result = await this.run({
			type: 'embed_batch',
			backend,
			items: jobs.map(job => ({ hash: job.hash, text: job.text, path: job.path })),
		}, embeddingConfig);
		if (result.type === 'embedded_batch') return result.items;
		if (result.type === 'embedded') return [{ hash: result.hash, vector: result.vector }];
		return [];
	}

	terminate() {
		this.worker?.terminate();
		this.worker = null;
	}
}

let singleton: IndexWorkerManager | null = null;

export function getIndexWorkerManager(): IndexWorkerManager {
	if (singleton) return singleton;
	singleton = new IndexWorkerManager();
	return singleton;
}
