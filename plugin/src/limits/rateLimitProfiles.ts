import type { ProviderName } from '../models/modelRegistry';

export type RateLimitProfile = {
	provider: ProviderName;
	match?: RegExp;
	source:
		| 'openai-docs'
		| 'anthropic-docs'
		| 'gemini-docs'
		| 'ollama-docs';
	notes: string;
	requestsPerMinute?: number;
	tokensPerMinute?: number;
	inputTokensPerMinute?: number;
	outputTokensPerMinute?: number;
	requestsPerDay?: number;
	safeContextChars: number;
	safeMaxOutputTokens: number;
};

const PROFILES: RateLimitProfile[] = [
	{
		provider: 'openai',
		source: 'openai-docs',
		notes: 'OpenAI rate limits vary by organization, project, model, and shared limit groups. Real limits should be learned from x-ratelimit-* headers and 429 errors; this is a conservative fallback.',
		requestsPerMinute: 20,
		tokensPerMinute: 20_000,
		safeContextChars: 18_000,
		safeMaxOutputTokens: 1_000,
	},
	{
		provider: 'anthropic',
		match: /claude-(opus|sonnet)-4/i,
		source: 'anthropic-docs',
		notes: 'Anthropic docs list Tier 1 Opus 4.x and Sonnet 4 at 50 RPM, 30,000 ITPM, 8,000 OTPM.',
		requestsPerMinute: 50,
		inputTokensPerMinute: 30_000,
		outputTokensPerMinute: 8_000,
		safeContextChars: 60_000,
		safeMaxOutputTokens: 2_000,
	},
	{
		provider: 'anthropic',
		match: /claude-haiku/i,
		source: 'anthropic-docs',
		notes: 'Anthropic limits vary by model class and tier; Haiku is kept conservative here until headers teach higher limits.',
		requestsPerMinute: 50,
		inputTokensPerMinute: 20_000,
		outputTokensPerMinute: 8_000,
		safeContextChars: 45_000,
		safeMaxOutputTokens: 1_500,
	},
	{
		provider: 'gemini',
		match: /(3\.1-pro|2\.5-pro)/i,
		source: 'gemini-docs',
		notes: 'Gemini free-tier docs list Gemini 2.5 Pro at 5 RPM, 250,000 TPM, 100 RPD. Gemini limits are project-tier dependent and preview models are stricter.',
		requestsPerMinute: 5,
		tokensPerMinute: 250_000,
		requestsPerDay: 100,
		safeContextChars: 45_000,
		safeMaxOutputTokens: 1_800,
	},
	{
		provider: 'gemini',
		match: /(flash-lite)/i,
		source: 'gemini-docs',
		notes: 'Gemini free-tier docs list Gemini 2.5 Flash-Lite at 15 RPM, 250,000 TPM, 1,000 RPD.',
		requestsPerMinute: 15,
		tokensPerMinute: 250_000,
		requestsPerDay: 1_000,
		safeContextChars: 60_000,
		safeMaxOutputTokens: 2_000,
	},
	{
		provider: 'gemini',
		match: /(flash|preview)/i,
		source: 'gemini-docs',
		notes: 'Gemini free-tier docs list Gemini 2.5 Flash / Flash Preview at 10 RPM, 250,000 TPM, 250 RPD. Preview models may be more restricted.',
		requestsPerMinute: 10,
		tokensPerMinute: 250_000,
		requestsPerDay: 250,
		safeContextChars: 50_000,
		safeMaxOutputTokens: 1_800,
	},
	{
		provider: 'ollama',
		source: 'ollama-docs',
		notes: 'Ollama has no provider TPM. Capacity depends on OLLAMA_CONTEXT_LENGTH, OLLAMA_NUM_PARALLEL, OLLAMA_MAX_QUEUE, and available RAM/VRAM.',
		safeContextChars: 24_000,
		safeMaxOutputTokens: 1_500,
	},
];

export function getRateLimitProfile(provider: ProviderName, model: string): RateLimitProfile {
	return PROFILES.find(profile =>
		profile.provider === provider && (!profile.match || profile.match.test(model)),
	) ?? PROFILES.find(profile => profile.provider === provider)!;
}

export function defaultMaxContextChars(provider: ProviderName, model: string): number {
	return getRateLimitProfile(provider, model).safeContextChars;
}

export function defaultMaxOutputTokens(provider: ProviderName, model: string): number {
	return getRateLimitProfile(provider, model).safeMaxOutputTokens;
}
