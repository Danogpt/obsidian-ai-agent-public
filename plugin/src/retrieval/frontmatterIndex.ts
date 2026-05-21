import type { VaultNoteRecord } from './types';

function stringifyFrontmatterValue(value: unknown): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return '';
}

export type FrontmatterFacet = {
	key: string;
	value: string;
	path: string;
};

export type FrontmatterSnapshot = {
	byType: Map<string, string[]>;
	byStatus: Map<string, string[]>;
	byTag: Map<string, string[]>;
	byAlias: Map<string, string[]>;
	byTopic: Map<string, string[]>;
	byProject: Map<string, string[]>;
	facets: FrontmatterFacet[];
};

export type FrontmatterSchemaField = {
	key: string;
	count: number;
	sampleValues: string[];
};

export type TemplateSchemaSummary = {
	templates: Array<{
		path: string;
		title: string;
		fields: string[];
		placeholders: string[];
	}>;
};

function asValues(value: unknown): string[] {
	if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
	if (typeof value === 'string' && value.trim()) return [value.trim()];
	return [];
}

function add(map: Map<string, string[]>, key: string, path: string) {
	const current = map.get(key) ?? [];
	current.push(path);
	map.set(key, current);
}

export function buildFrontmatterSnapshot(notes: VaultNoteRecord[]): FrontmatterSnapshot {
	const snapshot: FrontmatterSnapshot = {
		byType: new Map(),
		byStatus: new Map(),
		byTag: new Map(),
		byAlias: new Map(),
		byTopic: new Map(),
		byProject: new Map(),
		facets: [],
	};

	for (const note of notes) {
		for (const type of asValues(note.frontmatter['type'])) add(snapshot.byType, type.toLowerCase(), note.path);
		for (const status of asValues(note.frontmatter['status'])) add(snapshot.byStatus, status.toLowerCase(), note.path);
		for (const topic of asValues(note.frontmatter['topic'])) add(snapshot.byTopic, topic.toLowerCase(), note.path);
		for (const project of asValues(note.frontmatter['project'])) add(snapshot.byProject, project.toLowerCase(), note.path);
		for (const tag of note.tags.map(tag => tag.replace(/^#/, '').toLowerCase())) add(snapshot.byTag, tag, note.path);
		for (const alias of note.aliases.map(alias => alias.toLowerCase())) add(snapshot.byAlias, alias, note.path);

		for (const [key, raw] of Object.entries(note.frontmatter)) {
			for (const value of asValues(raw)) {
				snapshot.facets.push({ key, value, path: note.path });
			}
		}
	}
	return snapshot;
}

export function buildFrontmatterContextText(notes: VaultNoteRecord[], maxEntries = 12): string | null {
	if (!notes.length) return null;
	const lines = ['Strukturierter Frontmatter-Kontext:'];
	for (const note of notes.slice(0, maxEntries)) {
		const fields = [
			note.frontmatter['type'] ? `type=${stringifyFrontmatterValue(note.frontmatter['type'])}` : '',
			note.frontmatter['status'] ? `status=${stringifyFrontmatterValue(note.frontmatter['status'])}` : '',
			note.frontmatter['topic'] ? `topic=${stringifyFrontmatterValue(note.frontmatter['topic'])}` : '',
			note.frontmatter['project'] ? `project=${stringifyFrontmatterValue(note.frontmatter['project'])}` : '',
			note.tags.length ? `tags=${note.tags.slice(0, 6).join(',')}` : '',
			note.aliases.length ? `aliases=${note.aliases.slice(0, 4).join(',')}` : '',
		].filter(Boolean);
		lines.push(`- ${note.title} (${note.path})${fields.length ? ` [${fields.join(' | ')}]` : ''}`);
	}
	return lines.join('\n');
}

export function buildFrontmatterSchemaText(notes: VaultNoteRecord[], maxFields = 18): string | null {
	if (!notes.length) return null;
	const fieldMap = new Map<string, { count: number; values: Set<string> }>();
	for (const note of notes) {
		for (const [key, raw] of Object.entries(note.frontmatter)) {
			const current = fieldMap.get(key) ?? { count: 0, values: new Set<string>() };
			current.count += 1;
			for (const value of asValues(raw).slice(0, 4)) current.values.add(value);
			fieldMap.set(key, current);
		}
	}
	const fields = Array.from(fieldMap.entries())
		.map(([key, value]) => ({
			key,
			count: value.count,
			sampleValues: Array.from(value.values).slice(0, 5),
		}))
		.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
		.slice(0, maxFields);
	if (!fields.length) return null;

	const lines = ['Frontmatter-Schema:'];
	for (const field of fields) {
		lines.push(`- ${field.key} (${field.count})${field.sampleValues.length ? ` -> ${field.sampleValues.join(' | ')}` : ''}`);
	}
	return lines.join('\n');
}

function isTemplateLike(note: VaultNoteRecord): boolean {
	const path = note.path.toLowerCase();
	if (path.includes('/template') || path.includes('/templates/')) return true;
	if (normalizeFlag(note.frontmatter['template'])) return true;
	if (normalizeFlag(note.frontmatter['is_template'])) return true;
	if (normalizeFlag(note.frontmatter['templater'])) return true;
	return false;
}

function normalizeFlag(value: unknown): boolean {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'string') return ['true', 'yes', '1'].includes(value.trim().toLowerCase());
	return false;
}

function extractTemplaterPlaceholders(text: string): string[] {
	const matches = new Set<string>();
	for (const match of text.matchAll(/<%\*?\s*tp\.[^%]+%>/g)) {
		matches.add(match[0]);
	}
	for (const match of text.matchAll(/\{\{([^}]+)\}\}/g)) {
		const value = match[1]?.trim();
		if (value) matches.add(`{{${value}}}`);
	}
	return Array.from(matches).slice(0, 8);
}

export function buildTemplateSchemaSummary(notes: VaultNoteRecord[], maxTemplates = 6): TemplateSchemaSummary {
	const templates = notes
		.filter(isTemplateLike)
		.map(note => ({
			path: note.path,
			title: note.title,
			fields: Object.keys(note.frontmatter).sort(),
			placeholders: extractTemplaterPlaceholders(note.chunks.map(chunk => chunk.content).join('\n\n')),
		}))
		.filter(item => item.fields.length > 0 || item.placeholders.length > 0)
		.slice(0, maxTemplates);
	return { templates };
}

export function buildTemplateSchemaText(notes: VaultNoteRecord[], maxTemplates = 6): string | null {
	const summary = buildTemplateSchemaSummary(notes, maxTemplates);
	if (!summary.templates.length) return null;
	const lines = ['Template-/Schema-Hinweise:'];
	for (const template of summary.templates) {
		const meta = [
			template.fields.length ? `fields=${template.fields.slice(0, 10).join(', ')}` : '',
			template.placeholders.length ? `placeholders=${template.placeholders.join(' | ')}` : '',
		].filter(Boolean);
		lines.push(`- ${template.title} (${template.path})${meta.length ? ` [${meta.join(' ; ')}]` : ''}`);
	}
	return lines.join('\n');
}
