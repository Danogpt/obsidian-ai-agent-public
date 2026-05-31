import type { ChatRequestPayload, ContextItem, EditPlan, TaskPlan, TypedStep, TaskComplexity } from './types';

const SYSTEM_PROMPT = [
	'<system_rules>',
	'Du bist ein KI-Agent in einem Obsidian Vault.',
	'Aufgaben:',
	'- Hilf beim Schreiben, Strukturieren, Recherchieren und Programmieren.',
	'- Nutze den bereitgestellten Kontext, aber erfinde keine Dateiinhalte.',
	'- Wenn Kontext fehlt, sage konkret, welche Datei oder Information fehlt.',
	'- Wenn du Änderungen vorschlägst, beschreibe sie klar.',
	'- Antworte in der Sprache des Nutzers.',
	'</system_rules>',
].join('\n');

const VAULT_TOOLS_PROMPT = [
	'<vault_tools>',
	'Du hast Zugriff auf den Obsidian Vault über Tools.',
	'Das Plugin führt die Tools lokal aus; du hast keinen direkten Dateizugriff.',
	'Wenn du ein Tool aufrufen möchtest, antworte NUR mit diesem JSON (kein anderer Text):',
	'{"tool_calls": [{"id": "1", "tool": "<tool>", "args": {<args>}, "reason": "<warum>"}]}',
	'Wenn du fertig bist oder keine Tools brauchst:',
	'{"tool_calls": [], "answer": "Deine finale Antwort hier"}',
	'Verfügbare Tools:',
	'- list_files() -> listet alle Markdown-Dateien',
	'- read_file(path: str) -> liest Dateiinhalt (max 60000 Zeichen)',
	'- read_active_file() -> liest die aktuell geöffnete Datei',
	'- search_vault(query: str, limit: int = 20, filters?: {type?: str, status?: str, tag?: str|str[], alias?: str, folder?: str, path?: str, after?: str, before?: str}) -> sucht im Vault; rufe es auf, wenn du relevante Notizen oder Dateien erst finden musst.',
	'- expand_chunk(chunk_id: str, maxChars: int = 12000) -> erweitert einen zuvor gefundenen Retrieval-Treffer auf den echten Abschnitt/Block mit Metadaten.',
	'- read_folder(path: str, maxFiles: int = 30) -> liest Dateien in einem Ordner; nutze es, wenn Ordnerkontext gebraucht wird.',
	'- write_file(path: str, content: str, overwrite: bool = false) -> erstellt/überschreibt Datei',
	'- patch_file(path: str, oldText: str, newText: str) -> ersetzt Text in Datei',
	'- delete_file(path: str) -> verschiebt Datei in den Papierkorb',
	'- create_agent_md() -> erstellt die agent.md Konfigurationsdatei',
	'- query_dataview(dql: str) -> fuehrt eine Dataview DQL-Abfrage aus (erfordert Dataview Plugin); unterstuetzt TABLE/LIST/TASK-Syntax und wird lokal strukturiert normalisiert.',
	'- read_user_preferences(maxChars: int = 12000) -> liest persistente Nutzerpraeferenzen aus user_preferences.md',
	'- update_user_preferences(content: str, overwrite: bool = true) -> aktualisiert persistente Nutzerpraeferenzen kontrolliert',
	'- save_memory(content: str, label?: str) -> speichert wichtige Erkenntnisse, Fakten oder Entscheidungen dauerhaft in .ai/agent_memory.md; nutze es wenn du etwas ueber den Nutzer, den Vault oder ein Projekt lernst, das du spaeter wieder brauchst',
	'- recall_memory(maxChars?: int) -> liest alle gespeicherten Agenten-Erinnerungen aus .ai/agent_memory.md',
	'- ask_user(question: str, options?: str[]) -> pausiert die Ausfuehrung und fragt den Nutzer direkt; liefert die Antwort als Tool-Resultat zurueck; nutze es wenn die Aufgabe mehrere plausible Interpretationen hat, wichtige Informationen fehlen oder eine Entscheidung noetig ist, die du nicht eigenstaendig treffen sollst',
	'Werkzeugregeln:',
	'- Lies immer zuerst Dateien, bevor du sie aenderst.',
	'- Rufe nur ein Tool gleichzeitig auf.',
	'- Erfinde keine Dateiinhalte; nutze read_file wenn du den Inhalt brauchst.',
	'- Wenn der Nutzer nach Inhalt, Zeichenanzahl, Zusammenfassung oder Bearbeitung einer bestimmten .md-Datei fragt und ihr Inhalt nicht schon im Kontext steht, musst du read_file aufrufen.',
	'- Antworte in diesem Fall nicht mit "ich kann die Datei nicht lesen", sondern fordere das passende Tool an.',
	'- Nutze search_vault, wenn der Nutzer ein Thema, eine unklare Datei oder bestehende Notizen im Vault meint, aber du den genauen Pfad noch nicht kennst.',
	'- Wenn der Nutzer nach Notizen mit bestimmtem type, status, tag, alias, Pfad oder Datumsbereich fragt, verwende search_vault mit filters statt nur Freitext.',
	'- Wenn der Nutzer eine aggregierte, tabellarische oder gruppierte Frage zu Frontmatter, Status, Typ, Tags, Projekten, Templates, Schemas oder Datumsbereichen stellt, bevorzuge query_dataview statt roher Volltextsuche.',
	'- Behandle Bases-/Dataview-aehnliche Fragen als strukturierte Query-Aufgaben, nicht als normale Volltextsuche.',
	'- Nutze search_vault als zweistufige Suche: erst passende Notizen finden, dann ueber den Rueckgabepfad gezielt read_file aufrufen, wenn du den genauen Inhalt brauchst.',
	'- Nutze expand_chunk, wenn search_vault den richtigen Abschnitt gefunden hat, du aber nicht die ganze Datei lesen musst.',
	'- Nutze read_active_file, wenn der Nutzer ausdruecklich von der aktuellen Datei spricht.',
	'- Wenn der Nutzer explizit sagt "merke dir", "in Zukunft immer", "bitte kuenftig", "remember this preference" oder eine dauerhafte Stilpraeferenz festlegen will, lies bei Bedarf read_user_preferences und aktualisiere sie dann mit update_user_preferences.',
	'- Nutze save_memory, wenn du im Gespraech etwas ueber den Nutzer, den Vault-Kontext oder ein Projekt lernst, das nicht in einer normalen Notiz steht und spaeter nuetzlich sein koennte (z.B. Projektkontext, Entscheidungen, Fakten). recall_memory laedt diese gespeicherten Erkenntnisse wieder.',
	'- Wenn die Nutzeranfrage mehrere plausible Interpretationen hat, wichtige Informationen fehlen oder du nicht sicher bist, welche Datei oder welcher Weg gemeint ist, rufe ask_user mit einer klaren Frage auf, statt blind zu raten.',
	'- Entweder rufe ein Tool auf oder gib eine finale Antwort. Beschreibe nicht nur, was du als naechstes tun wuerdest.',
	'- Lies dieselbe Datei nicht erneut, wenn sie bereits in den letzten Tool-Resultaten gelesen wurde, ausser du hast sie inzwischen geaendert oder es gab einen fehlgeschlagenen Patch auf genau dieser Datei.',
	'- Wenn search_vault 0 Treffer liefert, lies nicht blind weitere Dateien. Gib stattdessen einen kurzen Zwischenstand oder formuliere einen konkreten Plan fuer die wahrscheinlichsten Zieldateien.',
	'- Nach spaetestens 2 reinen Leserunden musst du entweder eine strukturierte Plan-Antwort liefern, einen Schreibschritt ausfuehren oder eine normale Antwort mit Zwischenstand geben.',
	'</vault_tools>',
].join('\n');

const NATIVE_VAULT_TOOLS_PROMPT = [
	'<vault_tools>',
	'Du hast Zugriff auf native Tool Calls fuer den Obsidian Vault.',
	'Nutze Tool Calls statt JSON im Text, wenn du Dateien lesen, suchen, schreiben oder Nutzerfragen klaeren musst.',
	'Werkzeugregeln:',
	'- Lies immer zuerst Dateien, bevor du sie aenderst.',
	'- Erfinde keine Dateiinhalte; nutze read_file wenn du den Inhalt brauchst.',
	'- Nutze search_vault, wenn der Nutzer ein Thema, eine unklare Datei oder bestehende Notizen im Vault meint, aber du den genauen Pfad noch nicht kennst.',
	'- Nach spaetestens 2 reinen Leserunden musst du entweder eine strukturierte Plan-Antwort liefern, einen Schreibschritt ausfuehren oder eine normale Antwort mit Zwischenstand geben.',
	'- Wenn du fertig bist oder keine Tools brauchst, antworte normal im Chat.',
	'</vault_tools>',
].join('\n');

function trimText(text: string, limit: number): string {
	if (!text || text.length <= limit) return text;
	return text.slice(0, limit) + '\n\n[... gekuerzt wegen Kontextlimit ...]';
}

function hasWritableTarget(req: ChatRequestPayload): boolean {
	return req.context.some(item =>
		(item.type === 'active_file' || item.type === 'manual_file' || item.type === 'input_reference') &&
		typeof item.path === 'string' &&
		item.path.length > 0,
	);
}

const CONTEXT_PRIORITY: Record<string, number> = {
	agent_md: 0,
	agent_memory: 1,
	working_memory: 2,
	working_memory_structured: 3,
	pending_task_plan: 4,
	user_preferences: 5,
	selected_text: 6,
	active_file: 7,
	manual_file: 8,
	input_reference: 9,
	frontmatter_context: 10,
	retrieved_chunk: 11,
	backlink_context: 12,
	forward_link_context: 13,
	folder: 14,
	vault_index: 15,
	vault_map: 16,
	web_result: 17,
};

function formatContextItem(item: ContextItem, remaining: number): [string, number, string[]] {
	const sources: string[] = [];
	let body = `\n<context_block type="${item.type}" label="${item.label.replace(/"/g, '\'')}">\n`;
	const closingTag = '\n</context_block>\n';
	if (item.path) {
		body += `Path: ${item.path}\n`;
		sources.push(item.path);
	}
	if (item.summary) {
		body += `Summary: ${item.summary}\n`;
	}
	if (item.reasons?.length) {
		body += `Reasons: ${item.reasons.join(', ')}\n`;
	}
	if (item.stats && Object.keys(item.stats).length > 0) {
		const statLine = Object.entries(item.stats)
			.filter(([, value]) => value !== undefined && value !== '')
			.map(([key, value]) => `${key}=${String(value)}`)
			.join(', ');
		if (statLine) body += `Stats: ${statLine}\n`;
	}
	if (item.content) {
		const allowed = Math.max(0, remaining - body.length);
		body += `\nContent:\n${trimText(item.content, allowed)}${closingTag}`;
		return [body, remaining - body.length, sources];
	}
	for (const file of item.files ?? []) {
		const remainingForFile = remaining - body.length - closingTag.length;
		if (remainingForFile <= 0) break;
		const fileHeader = `\nFile: ${file.path}\n`;
		const raw = file.content ?? file.snippet ?? '';
		const allowed = Math.max(0, Math.min(remainingForFile - fileHeader.length, 12000));
		if (allowed <= 0) break;
		const chunk = fileHeader + trimText(raw, allowed);
		body += chunk;
		sources.push(file.path);
	}
	body += closingTag;
	return [body, remaining - body.length, sources];
}

function formatToolResult(result: ChatRequestPayload['tool_results'][number]): string {
	const parts = [`- ${result.tool}: ${result.ok ? 'ok' : 'error'}`];
	if (result.error) {
		parts.push(`  error: ${trimText(result.error, 300)}`);
	}
	if (typeof result.result === 'string') {
		parts.push(`  result: ${trimText(result.result, 1200)}`);
	}
	if (result.result && typeof result.result === 'object') {
		const json = JSON.stringify(result.result, null, 2);
		parts.push(`  data: ${trimText(json, 2200)}`);
	}
	return parts.join('\n');
}

export function buildSystemPrompt(req: ChatRequestPayload): string {
	const parts = [SYSTEM_PROMPT];
	if (req.options.style_profile) {
		parts.push(`<style_profile>\n${req.options.style_profile}\n</style_profile>`);
	}
	if (req.options.template_hint) {
		parts.push(`<template_hint>\n${req.options.template_hint}\n</template_hint>`);
	}
	if (req.options.edit_format_hint) {
		parts.push(req.options.edit_format_hint);
	}
	if (req.options.execution_phase === 'plan') {
		parts.push('<execution_phase_rules>\nAusfuehrungsphase: plan.\nWenn die Anfrage eine Datei aendern, umschreiben, strukturieren, aktualisieren oder loeschen soll, darfst du noch KEINE write_file-, patch_file- oder delete_file-Calls ausfuehren.\nIn dieser Phase darfst du nur lesen, suchen, auflisten, query_dataview aufrufen und Kontext aufklaeren.\nErst wenn du genug Informationen hast, liefere als answer ein JSON-Objekt:\n{"goal":"...", "complexity":"simple|compound|complex", "steps":[{"id":"1","description":"...","type":"read|search|query|analyze|write|patch|delete|verify|ask_user","target":"path.md","status":"pending"}], "target_files":["path.md"],"operation":"kurze beschreibung","preferred_tool":"patch_file|write_file","safety":"low|medium|high","reasoning":"warum dieses tool","risk_notes":["..."]}\nWaehle complexity=simple fuer eine einzelne Aenderung, compound fuer mehrere Dateien oder Schritte, complex fuer sequentielle Abhaengigkeiten.\nBei reinen Recherche-/Aggregatfragen darf target_files fehlen; steps und goal sind dann Pflicht.\nWaehle preferred_tool=patch_file fuer kleine, eindeutige Aenderungen und preferred_tool=write_file fuer groessere Neufassungen oder wenn ein Patch voraussichtlich fragil waere.\nWenn noch Informationen fehlen, rufe ein passendes Lese-/Such-Tool auf.\nWenn du bereits 1-2 Dateien gelesen hast und die wahrscheinlichen Zieldateien kennst, liefere den Plan statt weiter blind zu lesen.\nVermeide doppelte read_file-Aufrufe auf denselben Pfad innerhalb derselben Anfrage.\n</execution_phase_rules>');
	}
	if (req.options.execution_phase === 'execute') {
		parts.push('<execution_phase_rules>\nAusfuehrungsphase: execute.\nNutze den vorhandenen strukturierten Arbeitsplan aus den Tool-Resultaten und fuehre jetzt die naechsten Planschritte aus.\nGib in execute keine neue Plan-JSON-Antwort aus, wenn bereits ein Plan in den Tool-Resultaten akzeptiert wurde. Fuehre stattdessen die naechsten read/write/patch Tools aus.\nVermeide lange Chat-Ausgaben vor der Aenderung. Bevorzuge Tool-Aufrufe.\nBei Dateioperationen folge bevorzugt dem Feld preferred_tool aus dem Plan.\nNutze patch_file fuer gezielte, eindeutige Aenderungen und write_file mit overwrite=true fuer groessere Neufassungen.\nWenn ein Patch zuvor fehlgeschlagen ist und ein frisch gelesener Dateistand vorliegt, passe den Plan an statt denselben kleinen Patch zu wiederholen.\nWenn vorherige Tool-Resultate einen Fehler zeigen, replane den restlichen Ablauf explizit statt blind weiterzumachen.\nWenn du nur noch weitere Dateien lesen wuerdest, ohne unmittelbar einen Schreibschritt oder eine klare Abschlussantwort vorzubereiten, stoppe und gib stattdessen einen kurzen Zwischenstand oder replane.\nWenn search_vault 0 Treffer hatte oder dieselbe Datei schon gelesen wurde, lies sie nicht einfach noch einmal.\n</execution_phase_rules>');
	}
	if (req.options.thinking_mode) {
		parts.push('<reasoning_mode>\nDenke Schritt fuer Schritt, bevor du antwortest.\n</reasoning_mode>');
	}
	if (req.options.vault_tools_enabled) {
		parts.push(req.options.native_tool_calling ? NATIVE_VAULT_TOOLS_PROMPT : VAULT_TOOLS_PROMPT);
	}
	if (req.options.agent_mode === 'read') {
		parts.push('<agent_mode_rules>\nAgent-Modus: read. Du darfst nur lesen, suchen und erklaeren. Keine write_file-, patch_file- oder delete_file-Calls.\n</agent_mode_rules>');
	}
	if (req.options.agent_mode === 'suggest') {
		parts.push('<agent_mode_rules>\nAgent-Modus: suggest. Wenn der Nutzer eine Datei aendern will, benutze die passenden Vault-Tools statt den kompletten Zieltext im Chat auszugeben.\n</agent_mode_rules>');
	}
	if (req.options.agent_mode === 'agent') {
		parts.push('<agent_mode_rules>\nAgent-Modus: agent. Wenn der Nutzer Inhalte fuer eine konkrete Datei erstellen, umschreiben, erweitern, strukturieren oder aktualisieren will und eine Zieldatei erkennbar ist, schreibe den Inhalt in die Datei statt ihn im Chat voll auszugeben.\nWenn du erfolgreich geschrieben oder gepatcht hast, antworte im Chat nur kurz mit Datei und Aenderung, nicht mit dem kompletten neuen Inhalt.\n</agent_mode_rules>');
	}
	if (req.options.agent_mode === 'agent' && hasWritableTarget(req)) {
		parts.push('<target_file_rule>\nEs gibt in diesem Request mindestens eine konkrete Zieldatei im Kontext. Bevorzuge Dateioperationen gegen diese Datei statt langer Chat-Ausgaben.\n</target_file_rule>');
	}
	if (req.options.style_profile) {
		parts.push('<style_focus>\nWende MUST-Regeln aus dem STYLE_PROFILE strikt an. Bevorzuge PREFERRED-Regeln, wenn sie nicht mit Tool-Sicherheit, Ausfuehrungsphase oder Kontextbudget kollidieren.\nNutze EXAMPLE_GOOD als Stilreferenz und vermeide EXAMPLE_BAD.\n</style_focus>');
	}
	if (req.options.enable_style_critique) {
		parts.push('<style_critique>\nVor der finalen Antwort wird ein billiger Stil-/Format-Check angewendet. Halte dich bereits jetzt an die MUST-Regeln, antworte klar und vermeide unnoetige Laenge.\n</style_critique>');
	}
	return parts.join('\n');
}

export function buildUserContent(req: ChatRequestPayload): [string, string[]] {
	let remaining = req.options.max_context_chars;
	const sources: string[] = [];
	const parts = [`<user_request>\n${req.message}\n</user_request>`];

	const sorted = [...req.context].sort(
		(a, b) => (CONTEXT_PRIORITY[a.type] ?? 99) - (CONTEXT_PRIORITY[b.type] ?? 99),
	);

	for (const item of sorted) {
		if (remaining <= 0) break;
		const [formatted, newRemaining, itemSources] = formatContextItem(item, remaining);
		parts.push(formatted);
		remaining = newRemaining;
		sources.push(...itemSources);
	}

	if (req.tool_results.length > 0) {
		parts.push('<tool_results>');
		parts.push(req.tool_results.map(formatToolResult).join('\n'));
		parts.push('</tool_results>');
	}

	return [parts.join('\n'), [...new Set(sources)]];
}

export type ApiMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export function buildMessages(req: ChatRequestPayload): [ApiMessage[], string[]] {
	const system = buildSystemPrompt(req);
	const messages: ApiMessage[] = [{ role: 'system', content: system }];
	for (const historyMessage of req.history.slice(-8)) {
		messages.push({ role: historyMessage.role, content: historyMessage.content });
	}
	const [userContent, sources] = buildUserContent(req);
	messages.push({ role: 'user', content: userContent });
	return [messages, sources];
}

export type ParsedToolCall = {
	id?: string;
	tool: string;
	args: Record<string, unknown>;
	reason?: string;
};

export function parseAgentJson(text: string): Record<string, unknown> | null {
	let cleaned = text.trim();
	if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7).trim();
	else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3).trim();
	if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3).trim();
	const match = cleaned.match(/\{[\s\S]*\}/);
	if (!match) return null;
	try {
		return JSON.parse(match[0]) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export function parseToolCalls(response: string): ParsedToolCall[] | null {
	const tryParse = (text: string): ParsedToolCall[] | null => {
		try {
			const data = JSON.parse(text) as { tool_calls?: unknown };
			const calls = data?.tool_calls;
			if (Array.isArray(calls) && calls.length > 0) return calls as ParsedToolCall[];
		} catch {
			// ignore
		}
		return null;
	};

	const top = parseAgentJson(response);
	if (top) {
		const calls = top['tool_calls'];
		if (Array.isArray(calls) && calls.length > 0) return calls as ParsedToolCall[];
	}

	for (const match of response.matchAll(/\{/g)) {
		let depth = 0;
		const start = match.index ?? 0;
		for (let index = start; index < response.length; index++) {
			if (response[index] === '{') depth++;
			else if (response[index] === '}') {
				depth--;
				if (depth === 0) {
					const result = tryParse(response.slice(start, index + 1));
					if (result) return result;
					break;
				}
			}
		}
	}
	return null;
}

export function normalizeFinalAnswer(text: string): string {
	const json = parseAgentJson(text);
	if (json && typeof json['answer'] === 'string') return json['answer'];
	return text.trim();
}

function isPreferredTool(value: unknown): value is EditPlan['preferred_tool'] {
	return value === 'patch_file' || value === 'write_file';
}

function isSafety(value: unknown): value is EditPlan['safety'] {
	return value === 'low' || value === 'medium' || value === 'high';
}

function isComplexity(value: unknown): value is TaskComplexity {
	return value === 'simple' || value === 'compound' || value === 'complex';
}

function parseTypedSteps(raw: unknown): TypedStep[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const VALID_STEP_TYPES = new Set(['read', 'search', 'query', 'analyze', 'write', 'patch', 'delete', 'verify', 'ask_user']);
	const steps: TypedStep[] = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object') continue;
		const obj = item as Record<string, unknown>;
		const id = typeof obj['id'] === 'string' ? obj['id'].trim() : String(steps.length + 1);
		const description = typeof obj['description'] === 'string' ? obj['description'].trim() : '';
		const type = typeof obj['type'] === 'string' && VALID_STEP_TYPES.has(obj['type']) ? obj['type'] as TypedStep['type'] : 'analyze';
		const target = typeof obj['target'] === 'string' ? obj['target'].trim() : undefined;
		if (description) steps.push({ id, description, type, target, status: 'pending' });
	}
	return steps.length ? steps : undefined;
}

export function parseStructuredEditPlan(text: string): EditPlan | null {
	const parsed = parseAgentJson(text);
	if (!parsed) return null;

	const targetFiles = Array.isArray(parsed['target_files'])
		? parsed['target_files'].map(item => String(item).trim()).filter(Boolean)
		: [];
	const operation = typeof parsed['operation'] === 'string' ? parsed['operation'].trim() : '';
	const preferredTool = parsed['preferred_tool'];
	const safety = parsed['safety'];
	const reasoning = typeof parsed['reasoning'] === 'string' ? parsed['reasoning'].trim() : undefined;
	const riskNotes = Array.isArray(parsed['risk_notes'])
		? parsed['risk_notes'].map(item => String(item).trim()).filter(Boolean)
		: undefined;
	const complexity = isComplexity(parsed['complexity']) ? parsed['complexity'] : undefined;
	const steps = parseTypedSteps(parsed['steps']);

	if (!targetFiles.length || !operation || !isPreferredTool(preferredTool) || !isSafety(safety)) {
		return null;
	}

	return {
		target_files: targetFiles,
		operation,
		preferred_tool: preferredTool,
		safety,
		reasoning,
		risk_notes: riskNotes?.length ? riskNotes : undefined,
		complexity,
		steps,
	};
}

export function parseTaskPlan(text: string): TaskPlan | null {
	const parsed = parseAgentJson(text);
	if (!parsed) return null;

	const goal = typeof parsed['goal'] === 'string' ? parsed['goal'].trim() : '';
	const complexity = isComplexity(parsed['complexity']) ? parsed['complexity'] : undefined;
	const steps = parseTypedSteps(parsed['steps']) ?? [];
	const targetFiles = Array.isArray(parsed['target_files'])
		? parsed['target_files'].map(item => String(item).trim()).filter(Boolean)
		: undefined;
	const operation = typeof parsed['operation'] === 'string' ? parsed['operation'].trim() : undefined;
	const preferredTool = isPreferredTool(parsed['preferred_tool']) ? parsed['preferred_tool'] : undefined;
	const safety = isSafety(parsed['safety']) ? parsed['safety'] : undefined;
	const reasoning = typeof parsed['reasoning'] === 'string' ? parsed['reasoning'].trim() : undefined;
	const riskNotes = Array.isArray(parsed['risk_notes'])
		? parsed['risk_notes'].map(item => String(item).trim()).filter(Boolean)
		: undefined;

	if (!goal || !complexity || steps.length === 0) return null;

	return {
		goal,
		complexity,
		steps,
		target_files: targetFiles?.length ? targetFiles : undefined,
		operation,
		preferred_tool: preferredTool,
		safety,
		reasoning,
		risk_notes: riskNotes?.length ? riskNotes : undefined,
	};
}
