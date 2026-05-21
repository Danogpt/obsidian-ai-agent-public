export interface VaultHeading {
	level: number;
	text: string;
}

export interface VaultChunkRecord {
	id: string;
	hash?: string;
	path: string;
	name: string;
	title: string;
	sectionPath: string[];
	heading?: string;
	blockType: 'frontmatter' | 'section' | 'block';
	content: string;
	searchText: string;
	tokenCount: number;   // pre-computed for BM25 length normalization
	startLine: number;
	endLine: number;
}

export interface LinkedNoteSummary {
	path: string;
	title: string;
	summary: string;
	tags: string[];
	linkCount?: number;
}

export interface VaultNoteRecord {
	path: string;
	name: string;
	title: string;
	basename: string;
	folder: string;
	mtime: number;
	size: number;
	tags: string[];
	aliases: string[];
	headings: VaultHeading[];
	links: string[];
	frontmatter: Record<string, unknown>;
	summary: string;
	chunks: VaultChunkRecord[];
	totalTokenCount: number;   // sum of chunk tokenCounts for note-level BM25
}

export interface VaultSearchResult {
	path: string;
	name: string;
	title: string;
	score: number;
	chunk_id?: string;
	block_type?: VaultChunkRecord['blockType'];
	heading?: string;
	sectionPath?: string[];
	line_range?: [number, number];
	snippet: string;
	tags: string[];
	aliases: string[];
	frontmatter: Record<string, unknown>;
	chunkCount?: number;
	reasons?: string[];
	retrieval_scores?: {
		final: number;
		bm25?: number;
		graph?: number;
		dense?: number;
		rerank?: number;
		chunk?: number;
	};
}

export interface VaultSearchFilters {
	type?: string;
	status?: string;
	tag?: string | string[];
	alias?: string;
	folder?: string;
	path?: string;
	after?: string;
	before?: string;
}
