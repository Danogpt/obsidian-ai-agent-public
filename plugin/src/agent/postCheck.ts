import type { AiAgentSettings } from '../settings';

type PostCheckMeta = {
	mutatedPaths?: string[];
};

function stripHeadingsForShortAnswer(text: string): string {
	return text.replace(/^(#{1,6})\s+/gm, '');
}

function collapseWhitespace(text: string): string {
	return text
		.replace(/\n{3,}/g, '\n\n')
		.replace(/[ \t]+\n/g, '\n')
		.trim();
}

function buildMutationSummary(paths: string[], language: AiAgentSettings['defaultLanguage']): string {
	const labels = paths.map(path => path.split('/').pop() ?? path);
	if (language === 'en') return `Updated: ${labels.join(', ')}.`;
	return `Aktualisiert: ${labels.join(', ')}.`;
}

function runLocalStyleCritique(text: string, settings: AiAgentSettings): string {
	let next = collapseWhitespace(text);

	if (
		(settings.taskProfile === 'research' || settings.taskProfile === 'writing') &&
		settings.answerPreference === 'structured_analysis' &&
		next.length > 0 &&
		!/^#{1,6}\s/m.test(next)
	) {
		next = `## Ergebnis\n${next}`;
	}

	return collapseWhitespace(next);
}

export function postCheckAssistantAnswer(
	answer: string,
	settings: AiAgentSettings,
	meta: PostCheckMeta = {},
): string {
	let next = collapseWhitespace(answer);

	if (
		(settings.answerPreference === 'concise_actions' || settings.writingStyle === 'executive') &&
		next.length <= 1200
	) {
		next = stripHeadingsForShortAnswer(next);
		next = collapseWhitespace(next);
	}

	if (settings.agentMode === 'agent' && (meta.mutatedPaths?.length ?? 0) > 0) {
		const mutationSummary = buildMutationSummary(meta.mutatedPaths ?? [], settings.defaultLanguage);
		if (!next) return mutationSummary;
		if (/^(erledigt|done|aktualisiert|updated)[:.! ]*$/i.test(next)) return mutationSummary;
	}

	if (settings.enableStyleCritique) {
		next = runLocalStyleCritique(next, settings);
	}

	return next;
}
