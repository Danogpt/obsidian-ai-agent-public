import type { ContextItem } from '../agent/types';

export type FileTemplate = {
	id: 'todo' | 'project_plan' | 'research' | 'protocol';
	label: string;
	template: string;
};

const FILE_TEMPLATES: FileTemplate[] = [
	{
		id: 'todo',
		label: 'To-do',
		template: [
			'# To-do',
			'',
			'## Ziel',
			'- ',
			'',
			'## Aufgaben',
			'- [ ] ',
			'',
			'## Naechste Schritte',
			'- ',
			'',
			'## Offene Fragen',
			'- ',
		].join('\n'),
	},
	{
		id: 'project_plan',
		label: 'Projektplan',
		template: [
			'# Projektplan',
			'',
			'## Ziel',
			'',
			'## Scope',
			'- In Scope:',
			'- Out of Scope:',
			'',
			'## Arbeitspakete',
			'### 1. ',
			'- Ziel:',
			'- Ergebnis:',
			'',
			'## Risiken und Annahmen',
			'- ',
			'',
			'## Naechste Schritte',
			'- ',
		].join('\n'),
	},
	{
		id: 'research',
		label: 'Recherche',
		template: [
			'# Recherche',
			'',
			'## Fragestellung',
			'',
			'## Kurzfazit',
			'',
			'## Befunde',
			'- ',
			'',
			'## Quellen',
			'- ',
			'',
			'## Offene Fragen',
			'- ',
		].join('\n'),
	},
	{
		id: 'protocol',
		label: 'Protokoll',
		template: [
			'# Protokoll',
			'',
			'## Rahmen',
			'- Datum:',
			'- Thema:',
			'- Beteiligte:',
			'',
			'## Besprochene Punkte',
			'- ',
			'',
			'## Entscheidungen',
			'- ',
			'',
			'## Aufgaben',
			'- [ ] ',
			'',
			'## Naechste Schritte',
			'- ',
		].join('\n'),
	},
];

function targetPaths(context: ContextItem[]): string[] {
	return context
		.filter(item =>
			(item.type === 'active_file' || item.type === 'manual_file' || item.type === 'input_reference') &&
			typeof item.path === 'string',
		)
		.map(item => item.path!.toLowerCase());
}

function hasAny(text: string, needles: string[]): boolean {
	return needles.some(needle => text.includes(needle));
}

export function detectFileTemplate(message: string, context: ContextItem[]): FileTemplate | null {
	const lowerMessage = message.toLowerCase();
	const paths = targetPaths(context).join(' | ');
	const haystack = `${lowerMessage} | ${paths}`;

	if (hasAny(haystack, ['todo', 'to-do', 'to do', 'aufgabe', 'tasks'])) {
		return FILE_TEMPLATES.find(template => template.id === 'todo') ?? null;
	}
	if (hasAny(haystack, ['projektplan', 'projekt plan', 'roadmap', 'milestone', 'planung'])) {
		return FILE_TEMPLATES.find(template => template.id === 'project_plan') ?? null;
	}
	if (hasAny(haystack, ['recherche', 'research', 'analyse', 'findings', 'quelle'])) {
		return FILE_TEMPLATES.find(template => template.id === 'research') ?? null;
	}
	if (hasAny(haystack, ['protokoll', 'meeting', 'minutes', 'besprechung', 'session'])) {
		return FILE_TEMPLATES.find(template => template.id === 'protocol') ?? null;
	}
	return null;
}

export function buildTemplateHint(message: string, context: ContextItem[]): string | undefined {
	const detected = detectFileTemplate(message, context);
	if (!detected) return undefined;
	return [
		`DATEI_VORLAGE: ${detected.label}`,
		'Wenn du eine neue Datei erzeugst oder den Inhalt grundlegend neu aufbaust, bevorzuge diese Struktur.',
		'Wenn bereits eine gute bestehende Struktur vorhanden ist, passe sie nur sinnvoll an statt blind zu ersetzen.',
		'Vorlage:',
		detected.template,
	].join('\n');
}
