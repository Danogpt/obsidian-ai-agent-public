import type { ProviderUsage } from '../agent/types';

function numberValue(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function withDuration(usage: ProviderUsage | undefined, startedAt: number): ProviderUsage {
	return compactUsage({
		...(usage ?? {}),
		durationMs: usage?.durationMs ?? Math.max(0, Date.now() - startedAt),
	});
}

export function compactUsage(usage: ProviderUsage): ProviderUsage {
	const compacted: ProviderUsage = {};
	for (const [key, value] of Object.entries(usage) as Array<[keyof ProviderUsage, number | undefined]>) {
		if (typeof value === 'number' && Number.isFinite(value) && value >= 0) compacted[key] = value;
	}
	return compacted;
}

export function extractOpenAIUsage(data: unknown, toolCallCount: number): ProviderUsage {
	const root = recordValue(data);
	const usage = recordValue(root.usage);
	const inputDetails = recordValue(usage.input_tokens_details);
	const outputDetails = recordValue(usage.output_tokens_details);
	const outputItems = Array.isArray(root.output) ? root.output : [];
	const webSearchRequests = outputItems.filter(item => recordValue(item).type === 'web_search_call').length;
	return compactUsage({
		inputTokens: numberValue(usage.input_tokens),
		outputTokens: numberValue(usage.output_tokens),
		reasoningTokens: numberValue(outputDetails.reasoning_tokens),
		cachedTokens: numberValue(inputDetails.cached_tokens),
		webSearchRequests,
		toolCallCount,
	});
}

export function extractAnthropicUsage(data: unknown, toolCallCount: number): ProviderUsage {
	const root = recordValue(data);
	const usage = recordValue(root.usage);
	const serverToolUse = recordValue(usage.server_tool_use);
	const cacheCreation = numberValue(usage.cache_creation_input_tokens) ?? 0;
	const cacheRead = numberValue(usage.cache_read_input_tokens) ?? 0;
	return compactUsage({
		inputTokens: numberValue(usage.input_tokens),
		outputTokens: numberValue(usage.output_tokens),
		cachedTokens: cacheCreation + cacheRead,
		webSearchRequests: numberValue(serverToolUse.web_search_requests),
		toolCallCount,
	});
}

export function extractGeminiUsage(data: unknown, toolCallCount: number, webSearchRequested: boolean): ProviderUsage {
	const root = recordValue(data);
	const usage = recordValue(root.usageMetadata);
	return compactUsage({
		inputTokens: numberValue(usage.promptTokenCount),
		outputTokens: numberValue(usage.candidatesTokenCount),
		reasoningTokens: numberValue(usage.thoughtsTokenCount),
		webSearchRequests: webSearchRequested ? 1 : undefined,
		toolCallCount,
	});
}

export function extractOllamaUsage(data: unknown, toolCallCount: number): ProviderUsage {
	const root = recordValue(data);
	const totalDurationNs = numberValue(root.total_duration);
	return compactUsage({
		inputTokens: numberValue(root.prompt_eval_count),
		outputTokens: numberValue(root.eval_count),
		toolCallCount,
		durationMs: totalDurationNs !== undefined ? Math.round(totalDurationNs / 1_000_000) : undefined,
	});
}

export function formatProviderUsage(usage: ProviderUsage | undefined): string | null {
	if (!usage) return null;
	const parts: string[] = [];
	if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
		parts.push(`Tokens: ${formatCount(usage.inputTokens)} in / ${formatCount(usage.outputTokens)} out`);
	}
	if (usage.reasoningTokens !== undefined && usage.reasoningTokens > 0) parts.push(`Reasoning: ${formatCount(usage.reasoningTokens)}`);
	if (usage.cachedTokens !== undefined && usage.cachedTokens > 0) parts.push(`Cache: ${formatCount(usage.cachedTokens)}`);
	if (usage.toolCallCount !== undefined && usage.toolCallCount > 0) parts.push(`Tools: ${usage.toolCallCount}`);
	if (usage.webSearchRequests !== undefined && usage.webSearchRequests > 0) parts.push(`Websearch: ${usage.webSearchRequests}`);
	if (usage.durationMs !== undefined) parts.push(`Dauer: ${formatDuration(usage.durationMs)}`);
	return parts.length > 0 ? parts.join(' | ') : null;
}

function formatCount(value: number | undefined): string {
	if (value === undefined) return '?';
	if (value >= 1000) return `${Math.round(value / 100) / 10}k`;
	return String(value);
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${Math.round(ms / 100) / 10}s`;
}
