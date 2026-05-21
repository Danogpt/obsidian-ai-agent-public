import type { VaultNoteRecord } from './types';

export type LinkGraphRankOptions = {
	activePath?: string;
	referencedPaths?: string[];
	recentPaths?: string[];
	iterations?: number;
	damping?: number;
};

export type WeightedOutgoingGraph = Map<string, Map<string, number>>;

function buildOutgoing(notes: VaultNoteRecord[]): WeightedOutgoingGraph {
	const validPaths = new Set(notes.map(note => note.path));
	const outgoing = new Map<string, Map<string, number>>();
	const byFolder = new Map<string, VaultNoteRecord[]>();
	const byTag = new Map<string, VaultNoteRecord[]>();

	for (const note of notes) {
		const folderKey = note.folder || '/';
		const folderBucket = byFolder.get(folderKey) ?? [];
		folderBucket.push(note);
		byFolder.set(folderKey, folderBucket);

		for (const rawTag of note.tags) {
			const tag = rawTag.toLowerCase().replace(/^#/, '');
			const tagBucket = byTag.get(tag) ?? [];
			tagBucket.push(note);
			byTag.set(tag, tagBucket);
		}
	}

	for (const note of notes) {
		const weights = new Map<string, number>();
		for (const link of note.links) {
			if (!validPaths.has(link)) continue;
			weights.set(link, (weights.get(link) ?? 0) + 1);
		}

		// Weak contextual edges: same folder and shared tags add light graph mass
		// without overpowering explicit wikilinks.
		for (const sibling of byFolder.get(note.folder || '/') ?? []) {
			if (sibling.path === note.path) continue;
			weights.set(sibling.path, (weights.get(sibling.path) ?? 0) + 0.15);
		}
		for (const rawTag of note.tags) {
			const tag = rawTag.toLowerCase().replace(/^#/, '');
			for (const tagged of (byTag.get(tag) ?? []).slice(0, 24)) {
				if (tagged.path === note.path) continue;
				weights.set(tagged.path, (weights.get(tagged.path) ?? 0) + 0.1);
			}
		}
		outgoing.set(note.path, weights);
	}

	return outgoing;
}

function buildIncoming(outgoing: WeightedOutgoingGraph): Map<string, Map<string, number>> {
	const incoming = new Map<string, Map<string, number>>();

	for (const [source, targets] of outgoing.entries()) {
		for (const [target, weight] of targets.entries()) {
			const sources = incoming.get(target) ?? new Map<string, number>();
			sources.set(source, (sources.get(source) ?? 0) + weight);
			incoming.set(target, sources);
		}
	}

	return incoming;
}

function buildPersonalization(
	notes: VaultNoteRecord[],
	options?: LinkGraphRankOptions,
): Map<string, number> {
	const base = new Map<string, number>();
	const noteCount = Math.max(notes.length, 1);
	const defaultWeight = 1 / noteCount;

	for (const note of notes) {
		base.set(note.path, defaultWeight);
	}

	const boosts = new Map<string, number>();
	const addBoost = (path: string | undefined, weight: number) => {
		if (!path) return;
		boosts.set(path, (boosts.get(path) ?? 0) + weight);
	};

	addBoost(options?.activePath, 10);
	for (const path of options?.referencedPaths ?? []) addBoost(path, 8);
	for (const path of options?.recentPaths ?? []) addBoost(path, 5);

	for (const [path, weight] of boosts) {
		if (!base.has(path)) continue;
		base.set(path, (base.get(path) ?? 0) + weight);
	}

	const total = Array.from(base.values()).reduce((sum, value) => sum + value, 0) || 1;

	for (const [path, value] of base) {
		base.set(path, value / total);
	}

	return base;
}

export function computePersonalizedRanks(
	notes: VaultNoteRecord[],
	options?: LinkGraphRankOptions,
): Map<string, number> {
	if (!notes.length) return new Map();

	const iterations = options?.iterations ?? 18;
	const damping = options?.damping ?? 0.85;
	const outgoing = buildOutgoing(notes);
	const incoming = buildIncoming(outgoing);
	const personalization = buildPersonalization(notes, options);
	const notePaths = notes.map(note => note.path);

	let ranks = new Map<string, number>();
	for (const path of notePaths) {
		ranks.set(path, personalization.get(path) ?? (1 / notePaths.length));
	}

	for (let i = 0; i < iterations; i++) {
		const next = new Map<string, number>();
		for (const path of notePaths) {
			let linkMass = 0;
			for (const [source, weight] of incoming.get(path)?.entries() ?? []) {
				const outWeights = outgoing.get(source);
				const outDegree = Array.from(outWeights?.values() ?? []).reduce((sum, value) => sum + value, 0);
				if (outDegree === 0) continue;
				linkMass += ((ranks.get(source) ?? 0) * weight) / outDegree;
			}

			const teleport = personalization.get(path) ?? 0;
			next.set(path, ((1 - damping) * teleport) + (damping * linkMass));
		}
		ranks = next;
	}

	return ranks;
}

export function getWeightedOutgoingTargets(note: VaultNoteRecord, validPaths?: Set<string>): Array<{ path: string; weight: number }> {
	const counts = new Map<string, number>();
	for (const link of note.links) {
		if (validPaths && !validPaths.has(link)) continue;
		counts.set(link, (counts.get(link) ?? 0) + 1);
	}

	return Array.from(counts.entries())
		.map(([path, weight]) => ({ path, weight }))
		.sort((a, b) => b.weight - a.weight || a.path.localeCompare(b.path));
}
