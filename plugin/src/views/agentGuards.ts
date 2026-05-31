import type { ToolResult } from '../agent/types';

export const MAX_AGENT_STEPS = 8;

export const PLAN_ALLOWED_TOOLS = new Set([
	'list_files', 'read_file', 'read_active_file', 'read_folder',
	'search_vault', 'expand_chunk', 'query_dataview',
	'read_user_preferences', 'ask_user', 'recall_memory',
]);

export const READ_ONLY_TOOLS = new Set([
	'read_file', 'read_active_file', 'read_folder', 'expand_chunk',
	'search_vault', 'list_files', 'query_dataview', 'read_user_preferences',
]);

// Tools that return only metadata/paths — excluded from the consecutive read-only
// round counter because they represent discovery progress, not stuck repetition.
export const METADATA_ONLY_TOOLS = new Set(['list_files', 'query_dataview']);

export const WRITE_TOOLS = new Set(['write_file', 'patch_file', 'delete_file', 'update_user_preferences', 'save_memory', 'create_agent_md']);

export function hasExplicitBroadDiscoveryIntent(userMessage: string): boolean {
	return /\b(suche|such|recherchier|recherche|vault|ganzer\s+vault|global|quer\s+ueber|quer\s+über|alle\s+dateien|mehrere\s+dateien|ordner\s+(?:prüfen|pruefen|durchgehen|lesen|anschauen)|folder|search|research|entire\s+vault|all\s+files|multiple\s+files)\b/i.test(userMessage);
}

export function isPathWithinFolderScope(path: string, folderPath: string): boolean {
	const normalizedPath = path.replace(/^\/+|\/+$/g, '');
	const normalizedFolder = folderPath.replace(/^\/+|\/+$/g, '');
	return normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}/`);
}

export function validateReadFolderScope(options: {
	path: string;
	folderPath?: string;
	userMessage: string;
	mode: string;
}): string | null {
	if (options.mode !== 'edit') return null;
	if (!options.path) return 'read_folder without folder path.';
	if (hasExplicitBroadDiscoveryIntent(options.userMessage)) return null;
	if (!options.folderPath) {
		return 'Edit mode: read_folder is only allowed when folder context is selected or the user explicitly asks for folder/vault research. Prefer read_active_file/read_file, then patch_file or write_file.';
	}
	if (!isPathWithinFolderScope(options.path, options.folderPath)) {
		return `Edit mode: read_folder path ${options.path} is outside the selected folder context ${options.folderPath}. Use the selected folder context or ask the user before broadening scope.`;
	}
	return null;
}

export function getEditReadLoopGuard(
	calls: Array<{ tool: string; args: Record<string, unknown> }>,
	toolResults: ToolResult[],
	userMessage: string,
	mode: string,
): string | null {
	if (mode !== 'edit') return null;
	if (hasExplicitBroadDiscoveryIntent(userMessage)) return null;
	const hasBroadReadCall = calls.some(call => call.tool === 'search_vault' || call.tool === 'read_folder' || call.tool === 'list_files');
	if (!hasBroadReadCall) return null;
	const alreadyDidBroadRead = toolResults.some(result =>
		result.ok && (result.tool === 'search_vault' || result.tool === 'read_folder' || result.tool === 'list_files')
	);
	if (!alreadyDidBroadRead) return null;
	return 'Edit mode already performed broad discovery. Stop searching/reading folders now. Use the active file and already loaded folder context; call read_active_file/read_file only for the exact target, then patch_file or write_file.';
}

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

export function getLatestReadContentForPath(toolResults: ToolResult[], path: string): string | null {
	for (let index = toolResults.length - 1; index >= 0; index--) {
		const result = toolResults[index];
		if (!result?.ok) continue;
		if (result.tool !== 'read_file' && result.tool !== 'read_active_file') continue;
		if (!result.result || typeof result.result !== 'object') continue;
		const readPath = (result.result as { path?: unknown }).path;
		const content = (result.result as { content?: unknown }).content;
		if (readPath === path && typeof content === 'string') return content;
	}
	return null;
}

export function validateOverwriteContentSafety(options: {
	path: string;
	nextContent: string;
	previousContent: string | null;
	userMessage: string;
}): string | null {
	if (!options.previousContent) {
		return `write_file overwrite for existing file ${options.path} requires a fresh read_file/read_active_file result in this turn. Read the full file first, then write or patch.`;
	}

	const destructiveIntent = /(kürz|kuerz|shorten|truncate|zusammenfass|summary|entfern|remove|lösche|loesche|delete|nur\s+noch|replace\s+with|ersetze\s+alles)/i.test(options.userMessage);
	const oldComparable = options.previousContent.replace(/\s+/g, '');
	const newComparable = options.nextContent.replace(/\s+/g, '');
	if (!destructiveIntent && oldComparable.length >= 1000 && newComparable.length < Math.floor(oldComparable.length * 0.85)) {
		return `write_file would shrink ${options.path} from about ${oldComparable.length} to ${newComparable.length} non-whitespace characters. This looks like accidental data loss. Use patch_file or write the complete document.`;
	}

	return null;
}

export function isLikelyNewFileCreationIntent(userMessage: string, operation: string): boolean {
	const text = `${userMessage}\n${operation}`.toLowerCase();
	return /\b(neu(?:e|en|er|es)?\s+(?:ordner|folder|datei|dateien|page|pages|seite|seiten)|(?:ordner|folder|datei|dateien|page|pages|seite|seiten)\s+(?:anlegen|erstellen|erzeugen|machen)|anlegen|erstelle|erstellen|erzeug(?:e|en)?|einfügen|einfuegen|create|new\s+(?:folder|file|files|page|pages)|scaffold)\b/u.test(text);
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
