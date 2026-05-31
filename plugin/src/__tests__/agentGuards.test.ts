import { describe, expect, it } from 'vitest';
import {
	getEditReadLoopGuard,
	getLatestReadContentForPath,
	hasExplicitBroadDiscoveryIntent,
	isLikelyNewFileCreationIntent,
	PLAN_ALLOWED_TOOLS,
	validateOverwriteContentSafety,
	validateReadFolderScope,
	WRITE_TOOLS,
} from '../views/agentGuards';
import type { ToolResult } from '../agent/types';

describe('agent write guards', () => {
	it('treats agent configuration and memory creation as write tools', () => {
		expect(WRITE_TOOLS.has('create_agent_md')).toBe(true);
		expect(WRITE_TOOLS.has('save_memory')).toBe(true);
		expect(PLAN_ALLOWED_TOOLS.has('create_agent_md')).toBe(false);
	});

	it('detects explicit broad discovery intent', () => {
		expect(hasExplicitBroadDiscoveryIntent('recherchiere im vault und ergänze die Datei')).toBe(true);
		expect(hasExplicitBroadDiscoveryIntent('formatiere die aktive Datei schöner')).toBe(false);
	});

	it('detects new file and folder creation intent', () => {
		expect(isLikelyNewFileCreationIntent('mache einen neuen Ordner Admin-UI und füge Pages ein', '')).toBe(true);
		expect(isLikelyNewFileCreationIntent('formatiere die bestehende Datei schöner', 'kleine Formatierung')).toBe(false);
	});

	it('blocks read_folder outside selected edit folder scope', () => {
		expect(validateReadFolderScope({
			path: 'Semester 6/Abschlussarbeit/Schreiben',
			folderPath: 'Semester 6/Abschlussarbeit',
			userMessage: 'formatiere die aktuelle Datei',
			mode: 'edit',
		})).toBeNull();
		expect(validateReadFolderScope({
			path: 'Semester 5/Finanzderivate',
			folderPath: 'Semester 6/Abschlussarbeit',
			userMessage: 'formatiere die aktuelle Datei',
			mode: 'edit',
		})).toContain('outside the selected folder context');
	});

	it('blocks repeated broad discovery in edit mode', () => {
		const guard = getEditReadLoopGuard(
			[{ tool: 'read_folder', args: { path: 'Semester 6/Abschlussarbeit/Schreiben' } }],
			[{ id: '1', tool: 'search_vault', ok: true, result: [] }],
			'formatiere die aktuelle Datei',
			'edit',
		);
		expect(guard).toContain('Stop searching/reading folders');
	});

	it('finds the latest read content for a target path', () => {
		const results: ToolResult[] = [
			{ id: '1', tool: 'read_file', ok: true, result: { path: 'A.md', content: 'old' } },
			{ id: '2', tool: 'read_file', ok: true, result: { path: 'B.md', content: 'other' } },
			{ id: '3', tool: 'read_file', ok: true, result: { path: 'A.md', content: 'new' } },
		];
		expect(getLatestReadContentForPath(results, 'A.md')).toBe('new');
	});

	it('blocks overwrite when no fresh read is available', () => {
		expect(validateOverwriteContentSafety({
			path: 'A.md',
			nextContent: 'new',
			previousContent: null,
			userMessage: 'sortiere die Blöcke',
		})).toContain('requires a fresh read_file');
	});

	it('blocks accidental shrink overwrites for reorder requests', () => {
		const previousContent = 'Tag 1\n'.repeat(1200);
		const nextContent = 'Tag 1\n'.repeat(100);
		expect(validateOverwriteContentSafety({
			path: 'A.md',
			nextContent,
			previousContent,
			userMessage: 'verschiebe die Blöcke und ordne sie korrekt an',
		})).toContain('accidental data loss');
	});

	it('allows intentional shortening requests', () => {
		const previousContent = 'Tag 1\n'.repeat(1200);
		const nextContent = 'Kurz\n'.repeat(100);
		expect(validateOverwriteContentSafety({
			path: 'A.md',
			nextContent,
			previousContent,
			userMessage: 'kürze die Datei stark und fasse sie zusammen',
		})).toBeNull();
	});
});
