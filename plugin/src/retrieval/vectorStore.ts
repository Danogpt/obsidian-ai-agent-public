import { App } from 'obsidian';
import type { VaultChunkRecord } from './types';

export type StoredVector = {
	hash: string;
	chunk_id: string;
	path: string;
	section_path: string[];
	mtime: number;
	vector: number[];
	last_accessed: number;
};

type SerializedVectorStore = {
	version?: string;
	items: StoredVector[];
};

// Bump when embedding dimensions or feature schema change — triggers automatic cache invalidation.
const VECTOR_STORE_VERSION = '2';
const MAX_IN_MEMORY_VECTORS = 10_000;

function simpleHash(text: string): string {
	let hash = 2166136261;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16);
}

export function contentHashForChunk(chunk: VaultChunkRecord): string {
	return simpleHash(`${chunk.path}\n${chunk.heading ?? ''}\n${chunk.content}`);
}

export class VectorStore {
	private items = new Map<string, StoredVector>();
	private loaded = false;

	constructor(private app: App) {}

	private get storeFilePath(): string {
		return `${this.app.vault.configDir}/plugins/obsidian-ai-agent/vector-index.json`;
	}

	async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const exists = await this.app.vault.adapter.exists(this.storeFilePath);
			if (!exists) return;
			const json = await this.app.vault.adapter.read(this.storeFilePath);
			const data = JSON.parse(json) as SerializedVectorStore;
			if (data.version !== VECTOR_STORE_VERSION) return; // stale dims — discard silently
			for (const item of data.items ?? []) this.items.set(item.hash, item);
			this.evictIfNeeded();
		} catch {
			// ignore
		}
	}

	async save(): Promise<void> {
		await this.load();
		const payload: SerializedVectorStore = { version: VECTOR_STORE_VERSION, items: Array.from(this.items.values()) };
		await this.app.vault.adapter.write(this.storeFilePath, JSON.stringify(payload));
	}

	async get(hash: string): Promise<StoredVector | null> {
		await this.load();
		const item = this.items.get(hash) ?? null;
		if (item) item.last_accessed = Date.now();
		return item;
	}

	async set(item: StoredVector): Promise<void> {
		await this.load();
		this.items.set(item.hash, item);
		this.evictIfNeeded();
	}

	async deleteByPath(path: string): Promise<void> {
		await this.load();
		for (const [hash, item] of this.items.entries()) {
			if (item.path === path) this.items.delete(hash);
		}
	}

	private evictIfNeeded() {
		if (this.items.size <= MAX_IN_MEMORY_VECTORS) return;
		const items = Array.from(this.items.values()).sort((a, b) => a.last_accessed - b.last_accessed);
		for (const item of items.slice(0, this.items.size - MAX_IN_MEMORY_VECTORS)) {
			this.items.delete(item.hash);
		}
	}
}

const cache = new WeakMap<App, VectorStore>();

export function getVectorStore(app: App): VectorStore {
	const existing = cache.get(app);
	if (existing) return existing;
	const created = new VectorStore(app);
	cache.set(app, created);
	return created;
}
