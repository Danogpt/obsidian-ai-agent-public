import { App, TFile } from 'obsidian';

export class FileReferenceResolver {
	constructor(private app: App) {}

	findFileReferences(text: string): string[] {
		const refs = new Set<string>();

		const quoted = /[`"']([^`"'\n]+\.md)[`"']/gi;
		let match: RegExpExecArray | null;
		while ((match = quoted.exec(text)) !== null) {
			if (match[1]) this.addCandidates(refs, match[1]);
		}

		const loose = /\b([A-Za-z0-9_\-äöüÄÖÜß./\\ ]+?\.md)\b/gi;
		while ((match = loose.exec(text)) !== null) {
			const ref = match[1]?.trim();
			if (ref && !ref.includes('\n')) this.addCandidates(refs, ref);
		}

		return Array.from(refs);
	}

	// Ranked resolution: scores all candidates and returns the best match.
	// activePath is used to boost files in the same folder as the currently open file.
	resolveToFile(ref: string, activePath?: string): TFile | null {
		const normalized = ref.replace(/\\/g, '/').trim();

		// Fast path: exact vault path
		const direct = this.app.vault.getAbstractFileByPath(normalized);
		if (direct instanceof TFile) return direct;

		const files = this.app.vault.getMarkdownFiles();
		const lowerRef = normalized.toLowerCase();
		const activeFolder = activePath ? activePath.split('/').slice(0, -1).join('/') : '';

		let best: TFile | null = null;
		let bestScore = -1;

		for (const file of files) {
			const lowerPath = file.path.toLowerCase();
			const lowerName = file.name.toLowerCase();
			let score = 0;

			if (lowerName === lowerRef) {
				// Exact filename match (e.g. ref = "notes.md", file.name = "notes.md")
				score = 80;
			} else if (lowerPath.endsWith('/' + lowerRef) || lowerPath === lowerRef) {
				// Path ends with the ref (e.g. ref = "folder/notes.md")
				score = 60;
			} else if (lowerRef.endsWith('/' + lowerName)) {
				// ref is a sub-path ending with this filename
				score = 40;
			} else {
				continue;
			}

			// Proximity bonus: same folder as the active file
			const fileFolder = file.path.split('/').slice(0, -1).join('/');
			if (activeFolder && fileFolder === activeFolder) score += 15;

			// Shallower path → slightly prefer (less chance of being a duplicate)
			const depth = file.path.split('/').length;
			score += Math.max(0, 8 - depth);

			if (score > bestScore) {
				bestScore = score;
				best = file;
			}
		}

		return best;
	}

	private addCandidates(refs: Set<string>, raw: string) {
		const normalized = raw.replace(/\\/g, '/').replace(/\s+/g, ' ').trim();
		if (!normalized) return;

		refs.add(normalized);

		const basename = normalized.split('/').pop();
		if (basename && basename !== normalized) {
			refs.add(basename);
		}

		const parts = normalized.split(' ').filter(Boolean);
		for (let i = 1; i < parts.length; i++) {
			const suffix = parts.slice(i).join(' ');
			if (suffix.toLowerCase().endsWith('.md')) {
				refs.add(suffix);
			}
		}
	}
}
