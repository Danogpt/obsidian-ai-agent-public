import type { ToolResult } from '../agent/types';

export const MAX_AGENT_STEPS = 8;

export const PLAN_ALLOWED_TOOLS = new Set([
	'list_files', 'read_file', 'read_active_file', 'read_folder',
	'search_vault', 'expand_chunk', 'create_agent_md', 'query_dataview',
	'read_user_preferences', 'ask_user', 'recall_memory',
]);

export const READ_ONLY_TOOLS = new Set([
	'read_file', 'read_active_file', 'read_folder', 'expand_chunk',
	'search_vault', 'list_files', 'query_dataview', 'read_user_preferences',
]);

// Tools that return only metadata/paths — excluded from the consecutive read-only
// round counter because they represent discovery progress, not stuck repetition.
export const METADATA_ONLY_TOOLS = new Set(['list_files', 'query_dataview', 'create_agent_md']);

export const WRITE_TOOLS = new Set(['write_file', 'patch_file', 'delete_file', 'update_user_preferences']);

export function hasFreshReadForPath(toolResults: ToolResult[], path: string): boolean {
	for (let index = toolResults.length - 1; index >= 0; index--) {
		const result = toolResults[index];
		if (!result) continue;
		if (!result.ok) continue;
		if (result.tool !== 'read_file' && result.tool !== 'read_active_file') continue;
		if (!result.result || typeof result.result !== 'object') continue;

		const maybePath = (result.result as { path?: unknown }).path;
		if (typeof maybePath === 'string' && maybePath === path) {
			return true;
		}
	}
	return false;
}

export function getReadPaths(toolResults: ToolResult[]): Set<string> {
	const paths = new Set<string>();
	for (const result of toolResults) {
		if (!result.ok) continue;
		if (result.tool !== 'read_file' && result.tool !== 'read_active_file') continue;
		if (!result.result || typeof result.result !== 'object') continue;
		const maybePath = (result.result as { path?: unknown }).path;
		if (typeof maybePath === 'string' && maybePath) {
			paths.add(maybePath);
		}
	}
	return paths;
}

export function getSearchResultCount(result: ToolResult): number {
	if (!result.result || !Array.isArray(result.result)) return 0;
	return result.result.length;
}

export function getDuplicateReadGuard(
	call: { tool: string; args: Record<string, unknown> },
	toolResults: ToolResult[],
	currentRoundReadPaths?: Set<string>,
): string | null {
	if (call.tool !== 'read_file') return null;
	const path = typeof call.args['path'] === 'string' ? call.args['path'] : '';
	if (!path) return null;
	if (currentRoundReadPaths?.has(path)) {
		return `Datei in derselben Runde bereits angefordert: ${path}. Lies sie nicht erneut, sondern arbeite mit dem vorhandenen Stand weiter.`;
	}
	if (!hasFreshReadForPath(toolResults, path)) return null;
	return `Datei bereits gelesen: ${path}. Nutze den vorhandenen Stand oder plane den naechsten Schreib-/Abschlussschritt.`;
}

export function getRoundLoopGuard(
	calls: Array<{ tool: string; args: Record<string, unknown> }>,
	toolResults: ToolResult[],
	consecutiveReadOnlyRounds: number,
	latestSearchHadZeroHits: boolean,
): string | null {
	const readOnlyRound = calls.every(call => READ_ONLY_TOOLS.has(call.tool));
	if (!readOnlyRound) return null;

	const metadataOnly = calls.every(call => METADATA_ONLY_TOOLS.has(call.tool));
	if (metadataOnly) return null;

	if (latestSearchHadZeroHits && calls.some(call => call.tool === 'read_file' || call.tool === 'read_folder')) {
		return 'Die letzte Vault-Suche hatte 0 Treffer. Lies jetzt nicht blind weitere Dateien. Rufe read_file auf einer konkreten Zieldatei auf, die du bereits kennst, oder gib einen Zwischenstand.';
	}

	if (consecutiveReadOnlyRounds >= 2) {
		return 'Es wurden bereits mehrere reine Lese-Runden ausgefuehrt. Rufe jetzt read_file auf der Zieldatei auf und fuehre danach patch_file oder write_file aus. Keine weiteren search_vault- oder list_files-Aufrufe.';
	}

	const repeatedPaths = calls
		.filter(call => call.tool === 'read_file')
		.map(call => typeof call.args['path'] === 'string' ? call.args['path'] : '')
		.filter(path => path && hasFreshReadForPath(toolResults, path));
	if (repeatedPaths.length > 0) {
		return `Wiederholtes Lesen ohne neuen Erkenntnisgewinn erkannt (${repeatedPaths.slice(0, 2).join(', ')}). Nutze den vorhandenen Inhalt weiter.`;
	}

	return null;
}
