import type { DataviewQueryResult } from '../agent/types';

function normalizeCell(value: unknown): unknown {
	if (value === null || value === undefined) return value;
	if (Array.isArray(value)) return value.map(normalizeCell);
	if (typeof value === 'object') return JSON.parse(JSON.stringify(value));
	return value;
}

export function normalizeDataviewResult(raw: unknown): DataviewQueryResult {
	if (Array.isArray(raw)) {
		const looksLikeRows = raw.every(item => item && typeof item === 'object' && !Array.isArray(item));
		if (looksLikeRows) {
			const rows = raw.map(item => {
				const row: Record<string, unknown> = {};
				for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
					row[key] = normalizeCell(value);
				}
				return row;
			});
			return {
				kind: 'table',
				columns: Array.from(new Set(rows.flatMap(row => Object.keys(row)))),
				rows,
				count: rows.length,
				raw,
			};
		}
		return { kind: 'list', items: raw.map(normalizeCell), count: raw.length, raw };
	}

	if (raw && typeof raw === 'object') {
		const obj = raw as Record<string, unknown>;
		if (Array.isArray(obj['values'])) {
			return normalizeDataviewResult(obj['values']);
		}
		if (Array.isArray(obj['headers']) && Array.isArray(obj['values'])) {
			const columns = (obj['headers'] as unknown[]).map(item => String(item));
			const rows = (obj['values'] as unknown[]).map(value => {
				if (Array.isArray(value)) {
					const row: Record<string, unknown> = {};
					columns.forEach((column, index) => {
						row[column] = normalizeCell(value[index]);
					});
					return row;
				}
				return { value: normalizeCell(value) };
			});
			return { kind: 'table', columns, rows, count: rows.length, raw };
		}
	}

	return { kind: 'scalar', raw, count: raw === undefined ? 0 : 1 };
}
