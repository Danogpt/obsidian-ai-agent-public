import { describe, expect, it } from 'vitest';
import { isLikelyEditRequest, parseSlashCommand, routeIntent } from '../agent/intentRouter';

describe('parseSlashCommand', () => {
	it('strips mode slash commands', () => {
		expect(parseSlashCommand('/agent aktualisiere die Datei')).toEqual({
			command: 'agent',
			stripped: 'aktualisiere die Datei',
		});
	});

	it('supports slash-only mode switching', () => {
		expect(parseSlashCommand('/plan')).toEqual({ command: 'plan', stripped: '' });
	});

	it('supports slash commands as standalone tokens at the end', () => {
		expect(parseSlashCommand('ok bearbeite das mal bitte /agent')).toEqual({
			command: 'agent',
			stripped: 'ok bearbeite das mal bitte',
		});
	});
});

describe('routeIntent', () => {
	it('lets slash commands win over current UI mode', () => {
		const result = routeIntent('/agent suche und schreibe', 'ask');
		expect(result.mode).toBe('agent');
		expect(result.reason).toBe('Slash /agent');
		expect(result.allowWrites).toBe(true);
	});

	it('keeps default ask for normal questions', () => {
		const result = routeIntent('was steht in dieser Datei?', 'ask', { hasActiveFile: true });
		expect(result.mode).toBe('ask');
		expect(result.allowWrites).toBe(false);
		expect(result.needsPlanner).toBe(false);
	});

	it('does not mark default ask with active file as high confidence', () => {
		const result = routeIntent('hmm interessant', 'ask', { hasActiveFile: true });
		expect(result.mode).toBe('ask');
		expect(result.confidence).toBe('med');
	});

	it('routes edit verbs with file context to edit', () => {
		const result = routeIntent('aktualisiere die Überschrift', 'ask', { hasActiveFile: true });
		expect(result.mode).toBe('edit');
		expect(result.allowWrites).toBe(true);
		expect(result.maxRetrievedChunks).toBe(3);
	});

	it('routes write-back followups with active file context to edit', () => {
		const result = routeIntent('schreibe es in die datei', 'ask', { hasActiveFile: true });
		expect(result.mode).toBe('edit');
		expect(result.allowWrites).toBe(true);
		expect(result.confidence).toBe('high');
		expect(result.signals).toContain('writeback_phrase');
	});

	it('marks ambiguous followup tasks with file context as low confidence', () => {
		const result = routeIntent('ok mach das so', 'ask', { hasActiveFile: true });
		expect(result.mode).toBe('ask');
		expect(result.confidence).toBe('low');
		expect(result.signals).toContain('followup_task');
	});

	it('does not route write-back followups to edit without file context', () => {
		const result = routeIntent('schreibe es in die datei', 'ask');
		expect(result.mode).toBe('ask');
		expect(result.allowWrites).toBe(false);
	});

	it('routes formatting and beautifying requests on the active file to edit', () => {
		const result = routeIntent('kannst du die aktuelle Datei schöner und klarer strukturieren?', 'ask', { hasActiveFile: true });
		expect(result.mode).toBe('edit');
		expect(result.allowWrites).toBe(true);
	});

	it('routes professional rewording requests on the active file to edit', () => {
		const result = routeIntent('OK formuliere das erstmal professioneller und sinnvoller', 'ask', { hasActiveFile: true });
		expect(result.mode).toBe('edit');
		expect(result.allowWrites).toBe(true);
	});

	it('routes research plus file changes to agent', () => {
		const result = routeIntent('recherchiere dazu und ändere danach die Datei mit einem Vergleich', 'ask', { hasActiveFile: true });
		expect(result.mode).toBe('agent');
		expect(result.needsPlanner).toBe(true);
		expect(result.allowWrites).toBe(true);
	});

	it('does not let stale UI mode override automatic routing', () => {
		const result = routeIntent('was steht hier?', 'plan');
		expect(result.mode).toBe('ask');
		expect(result.needsPlanner).toBe(false);
		expect(result.allowWrites).toBe(false);
	});

	it('marks vague task wording with file context as low confidence', () => {
		const result = routeIntent('kannst du das mal ordentlich machen?', 'ask', { hasActiveFile: true });
		expect(result.mode).toBe('ask');
		expect(result.confidence).toBe('low');
		expect(result.signals).toContain('vague_task');
	});

	it('uses learned repeated classifier decisions', () => {
		const result = routeIntent('kannst du das mal ordentlich machen?', 'ask', {
			hasActiveFile: true,
			learnedIntentPatterns: [
				{
					key: 'ordentlich machen',
					example: 'kannst du das mal ordentlich machen?',
					counts: { edit: 3 },
					updatedAt: 1,
				},
			],
		});
		expect(result.mode).toBe('edit');
		expect(result.confidence).toBe('med');
		expect(result.signals).toContain('learned_intent');
	});

	it('does not let learned plan intent override a current multi-file edit request', () => {
		const result = routeIntent('Kannst du auch den Kontext einarbeiten und die einzelnen Plan-Dateien schöner machen und inhaltlich füllen', 'ask', {
			hasActiveFile: true,
			learnedIntentPatterns: [
				{
					key: 'kannst konzept mvp plan machen',
					example: 'Kannst du einen MVP Plan machen',
					counts: { plan: 4 },
					updatedAt: 1,
				},
			],
		});
		expect(result.mode).toBe('agent');
		expect(result.allowWrites).toBe(true);
		expect(result.signals).toContain('agent_phrase');
	});

	it('uses seeded English edit keywords with file context', () => {
		const result = routeIntent('please polish and clean up the current note', 'ask', { hasActiveFile: true });
		expect(result.mode).toBe('edit');
		expect(result.signals).toContain('seed_keyword');
	});

	it('uses seeded German agent keywords for research plus update', () => {
		const result = routeIntent('recherchiere und aktualisiere die Datei danach', 'ask', { hasActiveFile: true });
		expect(result.mode).toBe('agent');
		expect(result.signals).toContain('agent_phrase');
	});

	it('blocks seeded write intent without file context', () => {
		const result = routeIntent('please update this', 'ask');
		expect(result.mode).toBe('ask');
		expect(result.confidence).toBe('low');
		expect(result.signals).toContain('missing_file_context');
	});

	it('uses seeded planning keywords', () => {
		const result = routeIntent('make a plan before editing', 'ask', { hasActiveFile: true });
		expect(result.mode).toBe('plan');
		expect(result.signals).toContain('seed_keyword');
	});
});

describe('isLikelyEditRequest', () => {
	it('recognizes edit phrasing', () => {
		expect(isLikelyEditRequest('bitte ergänze den Abschnitt')).toBe(true);
	});

	it('does not treat plain questions as edits', () => {
		expect(isLikelyEditRequest('warum ist das so?')).toBe(false);
	});
});
