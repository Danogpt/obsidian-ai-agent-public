import { computePersonalizedRanks, getWeightedOutgoingTargets } from './linkGraph';
import type { VaultNoteRecord } from './types';

export function buildVaultMapText(
	notes: VaultNoteRecord[],
	options?: {
		activePath?: string;
		referencedPaths?: string[];
		recentPaths?: string[];
		limit?: number;
	},
): string {
	if (!notes.length) return '';

	const byPath = new Map(notes.map(note => [note.path, note] as const));
	const ranks = computePersonalizedRanks(notes, options);
	const referenced = new Set(options?.referencedPaths ?? []);
	const activeTags = options?.activePath ? new Set(byPath.get(options.activePath)?.tags.map(tag => tag.toLowerCase().replace(/^#/, '')) ?? []) : new Set<string>();
	const activeFolder = options?.activePath ? (byPath.get(options.activePath)?.folder ?? '') : '';
	const folderCounts = new Map<string, number>();
	const typeCounts = new Map<string, number>();
	for (const note of notes) {
		const folder = note.folder || '/';
		folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);
		const type = typeof note.frontmatter['type'] === 'string' && note.frontmatter['type'].trim()
			? note.frontmatter['type'].trim()
			: 'unknown';
		typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
	}

	const ranked = notes
		.map(note => {
			let score = (ranks.get(note.path) ?? 0) * 100;
			if (options?.activePath && note.path === options.activePath) score += 8;
			if (referenced.has(note.path)) score += 6;
			const sharedTags = note.tags
				.map(tag => tag.toLowerCase().replace(/^#/, ''))
				.filter(tag => activeTags.has(tag)).length;
			if (sharedTags > 0) score *= 1 + Math.min(sharedTags * 0.25, 0.75);
			if (activeFolder && note.folder === activeFolder) score *= 1.2;
			score *= getFolderWeight(note);
			if (note.tags.length) score += 1;
			if (note.headings.length) score += 1;
			return { note, score };
		})
		.sort((a, b) => b.score - a.score || a.note.path.localeCompare(b.note.path))
		.slice(0, options?.limit ?? 12);

	const lines = ranked.map(({ note }) => {
		const weightedTargets = getWeightedOutgoingTargets(note, new Set(byPath.keys()))
			.slice(0, 3)
			.map(target => {
				const title = byPath.get(target.path)?.title ?? target.path;
				return target.weight > 1 ? `${title} x${target.weight}` : title;
			});
		const parts = [
			note.path,
			typeof note.frontmatter['type'] === 'string' ? `type: ${note.frontmatter['type']}` : '',
			note.tags.length ? `tags: ${note.tags.slice(0, 4).join(' ')}` : '',
			note.headings.length ? `sections: ${note.headings.slice(0, 3).map(h => h.text).join(' | ')}` : '',
			note.summary ? `summary: ${note.summary}` : '',
			weightedTargets.length ? `links: ${weightedTargets.join(', ')}` : '',
		].filter(Boolean);
		return `- ${parts.join('  |  ')}`;
	});

	const topFolders = Array.from(folderCounts.entries())
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 5)
		.map(([folder, count]) => `${folder} (${count})`);
	const topTypes = Array.from(typeCounts.entries())
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 6)
		.map(([type, count]) => `${type}: ${count}`);

	return [
		'Kompakte Vault-Map mit priorisierten Notizen:',
		topFolders.length ? `Top folders: ${topFolders.join(' | ')}` : '',
		topTypes.length ? `Note types: ${topTypes.join(' | ')}` : '',
		...lines,
	].filter(Boolean).join('\n');
}

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
