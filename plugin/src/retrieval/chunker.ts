import { tokenizeBm25 } from './bm25';
import type { VaultChunkRecord, VaultHeading, VaultNoteRecord } from './types';

function stableHash(text: string): string {
	let hash = 2166136261;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16);
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const HEADING_LINE_RE = /^(#{1,6})\s+(.*)$/;

type RawSection = {
	heading?: string;
	level?: number;
	lines: string[];
	startLine: number;
	endLine: number;
};

type RawBlock = {
	lines: string[];
	startLine: number;
	endLine: number;
};

function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, '\n');
}

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
	const normalized = normalizeLineEndings(content);
	const match = normalized.match(FRONTMATTER_RE);
	if (!match) return { frontmatter: '', body: normalized };
	return {
		frontmatter: match[0].trim(),
		body: normalized.slice(match[0].length),
	};
}

function splitSections(body: string): RawSection[] {
	const lines = body.split('\n');
	const sections: RawSection[] = [];
	let current: RawSection = { lines: [], startLine: 1, endLine: 1 };
	let inFence = false;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? '';
		if (/^```/.test(line.trim())) inFence = !inFence;

		const headingMatch = !inFence ? line.match(HEADING_LINE_RE) : null;
		if (headingMatch) {
			if (current.lines.length > 0) {
				current.endLine = index;
				sections.push(current);
			}
			current = {
				heading: (headingMatch[2] ?? '').trim(),
				level: (headingMatch[1] ?? '').length,
				lines: [line],
				startLine: index + 1,
				endLine: index + 1,
			};
			continue;
		}

		current.lines.push(line);
		current.endLine = index + 1;
	}

	if (current.lines.length > 0) sections.push(current);
	return sections;
}

function buildSearchText(parts: Array<string | undefined>): string {
	return parts.filter(Boolean).join(' ').toLowerCase();
}

function isBulletLine(line: string): boolean {
	return /^\s*([-*+]|\d+\.)\s+/.test(line);
}

function isTableLine(line: string): boolean {
	return /^\s*\|.*\|\s*$/.test(line);
}

function isCalloutLine(line: string): boolean {
	return /^\s*>\s*\[[!][^\]]+\]/.test(line);
}

function isQuotedLine(line: string): boolean {
	return /^\s*>/.test(line);
}

function splitBlocks(section: RawSection): RawBlock[] {
	const blocks: RawBlock[] = [];
	let currentLines: string[] = [];
	let currentStart = section.startLine;
	let inFence = false;

	const flush = (endLine: number) => {
		const content = currentLines.join('\n').trim();
		if (!content) {
			currentLines = [];
			currentStart = endLine + 1;
			return;
		}
		blocks.push({ lines: [...currentLines], startLine: currentStart, endLine });
		currentLines = [];
		currentStart = endLine + 1;
	};

	for (let index = 0; index < section.lines.length; index++) {
		const line = section.lines[index] ?? '';
		const absoluteLine = section.startLine + index;
		const next = section.lines[index + 1] ?? '';
		const trimmed = line.trim();

		if (/^```/.test(trimmed)) {
			if (!currentLines.length) currentStart = absoluteLine;
			currentLines.push(line);
			inFence = !inFence;
			if (!inFence) flush(absoluteLine);
			continue;
		}

		if (inFence) {
			if (!currentLines.length) currentStart = absoluteLine;
			currentLines.push(line);
			continue;
		}

		if (!trimmed) {
			flush(absoluteLine);
			continue;
		}

		const listLike = isBulletLine(line);
		const tableLike = isTableLine(line);
		const calloutLike = isCalloutLine(line);
		const quoteLike = isQuotedLine(line);

		if (
			currentLines.length > 0 &&
			!listLike &&
			!tableLike &&
			!calloutLike &&
			!quoteLike &&
			!isBulletLine(currentLines[0] ?? '') &&
			!isTableLine(currentLines[0] ?? '') &&
			!isCalloutLine(currentLines[0] ?? '') &&
			!isQuotedLine(currentLines[0] ?? '')
		) {
			currentLines.push(line);
			if (!next.trim()) flush(absoluteLine);
			continue;
		}

		if (!currentLines.length) currentStart = absoluteLine;
		currentLines.push(line);

		if (listLike && !isBulletLine(next) && next.trim()) flush(absoluteLine);
		if (tableLike && !isTableLine(next)) flush(absoluteLine);
		if (calloutLike && !isQuotedLine(next)) flush(absoluteLine);
		if (quoteLike && !isQuotedLine(next)) flush(absoluteLine);
	}

	flush(section.endLine);
	return blocks;
}

function makeChunk(input: {
	path: string;
	name: string;
	title: string;
	basename: string;
	sectionPath: string[];
	heading?: string;
	blockType: 'frontmatter' | 'section' | 'block';
	content: string;
	startLine: number;
	endLine: number;
	tags: string[];
	aliases: string[];
}): VaultChunkRecord {
	const breadcrumb = [input.title, ...input.sectionPath, input.heading ?? input.blockType].filter(Boolean).join(' > ');
	const searchText = buildSearchText([
		input.basename,
		input.path,
		breadcrumb,
		input.heading,
		input.sectionPath.join(' '),
		input.content,
		...input.tags,
		...input.aliases,
	]);
	const hash = stableHash(`${input.path}\n${input.blockType}\n${input.startLine}:${input.endLine}\n${input.content}`);
	return {
		id: `${input.path}::${hash}`,
		hash,
		path: input.path,
		name: input.name,
		title: input.title,
		sectionPath: input.sectionPath,
		heading: input.heading,
		blockType: input.blockType,
		content: input.content,
		searchText,
		tokenCount: tokenizeBm25(searchText).length,
		startLine: input.startLine,
		endLine: input.endLine,
	};
}

export function buildNoteRecord(input: {
	path: string;
	name: string;
	basename: string;
	title?: string;
	folder: string;
	mtime: number;
	size: number;
	content: string;
	headings: VaultHeading[];
	tags: string[];
	aliases: string[];
	links: string[];
	frontmatter: Record<string, unknown>;
}): VaultNoteRecord {
	const title = input.title ?? input.basename;
	const { frontmatter, body } = splitFrontmatter(input.content);
	const rawSections = splitSections(body);
	const headingStack: VaultHeading[] = [];
	const chunks: VaultChunkRecord[] = [];

	if (frontmatter) {
		chunks.push(makeChunk({
			path: input.path,
			name: input.name,
			title,
			basename: input.basename,
			sectionPath: [],
			heading: 'frontmatter',
			blockType: 'frontmatter',
			content: frontmatter,
			startLine: 1,
			endLine: frontmatter.split('\n').length,
			tags: input.tags,
			aliases: input.aliases,
		}));
	}

	for (const section of rawSections) {
		if (section.heading && section.level) {
			while (headingStack.length >= section.level) headingStack.pop();
			headingStack.push({ level: section.level, text: section.heading });
		}

		const content = section.lines.join('\n').trim();
		if (!content) continue;

		const sectionPath = headingStack.map(heading => heading.text);
		chunks.push(makeChunk({
			path: input.path,
			name: input.name,
			title,
			basename: input.basename,
			sectionPath,
			heading: section.heading,
			blockType: section.heading ? 'section' : 'block',
			content,
			startLine: section.startLine,
			endLine: section.endLine,
			tags: input.tags,
			aliases: input.aliases,
		}));

		for (const block of splitBlocks(section)) {
			const blockContent = block.lines.join('\n').trim();
			if (!blockContent || blockContent === content) continue;
			chunks.push(makeChunk({
				path: input.path,
				name: input.name,
				title,
				basename: input.basename,
				sectionPath,
				heading: section.heading,
				blockType: 'block',
				content: blockContent,
				startLine: block.startLine,
				endLine: block.endLine,
				tags: input.tags,
				aliases: input.aliases,
			}));
		}
	}

	const totalTokenCount = chunks
		.filter(chunk => chunk.blockType !== 'block')
		.reduce((sum, chunk) => sum + chunk.tokenCount, 0);

	return {
		path: input.path,
		name: input.name,
		title,
		basename: input.basename,
		folder: input.folder,
		mtime: input.mtime,
		size: input.size,
		tags: input.tags,
		aliases: input.aliases,
		headings: input.headings,
		links: input.links,
		frontmatter: input.frontmatter,
		summary: '',
		chunks,
		totalTokenCount,
	};
}

function scoreChunk(chunk: VaultChunkRecord, queryTokens: string[]): number {
	if (!queryTokens.length) return 0;
	let score = 0;
	for (const token of queryTokens) {
		if (chunk.searchText.includes(token)) score += 2;
		if (chunk.heading?.toLowerCase().includes(token)) score += 4;
		if (chunk.sectionPath.some(part => part.toLowerCase().includes(token))) score += 2;
	}
	if (chunk.blockType === 'frontmatter') score += 1;
	if (chunk.blockType === 'block') score += 0.5;
	return score;
}

function tokenizeQuery(query: string): string[] {
	return Array.from(new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? []));
}

export function selectRelevantNoteContent(note: VaultNoteRecord, query: string, maxChars: number): string {
	const full = note.chunks
		.filter(chunk => chunk.blockType !== 'block')
		.map(chunk => chunk.content)
		.join('\n\n');
	if (full.length <= maxChars) return full;

	const queryTokens = tokenizeQuery(query);
	const scored = note.chunks.map((chunk, index) => ({
		chunk,
		index,
		score: scoreChunk(chunk, queryTokens) + (index === 0 ? 100 : 0),
	}));

	scored.sort((a, b) => b.score - a.score || a.index - b.index);

	const selected: typeof scored = [];
	let used = 0;

	for (const item of scored) {
		if (used >= maxChars) break;
		const remaining = maxChars - used;
		if (remaining < 240) break;

		const sectionLabel = item.chunk.sectionPath.length
			? item.chunk.sectionPath.join(' > ')
			: note.title;
		const prefix = `[${sectionLabel} | ${item.chunk.blockType}]\n`;
		const available = Math.max(0, remaining - prefix.length - 2);
		const body = item.chunk.content.length > available
			? item.chunk.content.slice(0, available) + '...'
			: item.chunk.content;

		selected.push({
			...item,
			chunk: {
				...item.chunk,
				content: prefix + body,
			},
		});
		used += prefix.length + body.length + 2;
	}

	selected.sort((a, b) => a.index - b.index);

	const totalChunks = note.chunks.length;
	const selectedChunks = selected.length;
	const header = totalChunks > selectedChunks
		? `[${selectedChunks}/${totalChunks} Abschnitte oder Bloecke - relevant fuer: "${query.slice(0, 80)}"]\n\n`
		: '';

	return header + selected.map(item => item.chunk.content).join('\n\n---\n\n');
}
