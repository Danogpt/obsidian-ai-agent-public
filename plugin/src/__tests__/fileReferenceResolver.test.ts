import { describe, it, expect } from 'vitest';
import { FileReferenceResolver } from '../context/fileReferenceResolver';
import { TFile } from 'obsidian';

// obsidian is aliased to __mocks__/obsidian.ts in vitest.config.ts

function mockFile(path: string): TFile {
	const name = path.split('/').pop() ?? path;
	// Safe cast: the mock TFile accepts (path, name), real TFile does not expose a constructor
	return new (TFile as unknown as new (p: string, n: string) => TFile)(path, name);
}

function makeApp(files: TFile[]) {
	return {
		vault: {
			getAbstractFileByPath: (p: string) => files.find(f => f.path === p) ?? null,
			getMarkdownFiles: () => files,
		},
		workspace: {
			getActiveFile: () => null,
		},
	} as never;
}

describe('FileReferenceResolver.resolveToFile', () => {
	it('returns null when no file matches', () => {
		const app = makeApp([mockFile('other.md')]);
		const resolver = new FileReferenceResolver(app);
		expect(resolver.resolveToFile('nonexistent.md')).toBeNull();
	});

	it('matches by exact path', () => {
		const file = mockFile('notes/specific.md');
		const app = makeApp([file, mockFile('other/specific.md')]);
		const resolver = new FileReferenceResolver(app);
		expect(resolver.resolveToFile('notes/specific.md')?.path).toBe('notes/specific.md');
	});

	it('matches by exact filename (case-insensitive)', () => {
		const file = mockFile('notes/MyNote.md');
		const app = makeApp([file]);
		const resolver = new FileReferenceResolver(app);
		expect(resolver.resolveToFile('mynote.md')?.path).toBe('notes/MyNote.md');
	});

	it('matches by path suffix', () => {
		const file = mockFile('deep/folder/target.md');
		const app = makeApp([file]);
		const resolver = new FileReferenceResolver(app);
		expect(resolver.resolveToFile('folder/target.md')?.path).toBe('deep/folder/target.md');
	});

	it('prefers shallower path when names are equal', () => {
		const shallow = mockFile('notes.md');
		const deep = mockFile('a/b/c/notes.md');
		const app = makeApp([deep, shallow]); // deep listed first
		const resolver = new FileReferenceResolver(app);
		expect(resolver.resolveToFile('notes.md')?.path).toBe('notes.md');
	});

	it('prefers file in same folder as active file (proximity boost)', () => {
		const near = mockFile('work/notes.md');
		const far = mockFile('personal/notes.md');
		const app = makeApp([far, near]); // far listed first
		const resolver = new FileReferenceResolver(app);
		expect(resolver.resolveToFile('notes.md', 'work/readme.md')?.path).toBe('work/notes.md');
	});
});

describe('FileReferenceResolver.findFileReferences', () => {
	const app = makeApp([]);
	const resolver = new FileReferenceResolver(app);

	it('finds quoted .md references', () => {
		const refs = resolver.findFileReferences('see `notes/file.md` for details');
		expect(refs).toContain('notes/file.md');
	});

	it('finds loose .md references', () => {
		const refs = resolver.findFileReferences('check the file notes.md here');
		expect(refs.some(r => r.includes('notes.md'))).toBe(true);
	});

	it('ignores non-.md references', () => {
		const refs = resolver.findFileReferences('see image.png and script.js');
		expect(refs.length).toBe(0);
	});
});
