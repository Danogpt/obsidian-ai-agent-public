// ProviderName lives here to avoid circular imports between settings ↔ modelRegistry
export type ProviderName = 'openai' | 'anthropic' | 'gemini' | 'ollama';

export type ModelQuality = 'Max' | 'Extra High' | 'High' | 'Medium' | 'Fast' | 'Nano' | 'Local';
export type ModelAvailability = 'verified' | 'preview' | 'legacy' | 'local' | 'custom' | 'unverified';

export type ModelCategory =
	| 'frontier' | 'reasoning' | 'coding'
	| 'fast' | 'cheap' | 'vision' | 'local' | 'legacy' | 'custom';

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type GeminiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';
export type OllamaThinkingLevel = boolean | 'low' | 'medium' | 'high';

export type ModelReasoningConfig =
	| { provider: 'openai'; effort: ReasoningEffort }
	| { provider: 'anthropic'; mode: 'off' }
	| { provider: 'anthropic'; mode: 'adaptive'; effort: Exclude<ReasoningEffort, 'none' | 'minimal'> }
	| { provider: 'anthropic'; mode: 'manual'; budgetTokens: number; effort?: Exclude<ReasoningEffort, 'none' | 'minimal'> }
	| { provider: 'gemini'; mode: 'level'; level: GeminiThinkingLevel }
	| { provider: 'gemini'; mode: 'budget'; budget: number }
	| { provider: 'ollama'; mode: 'think'; think: OllamaThinkingLevel };

export interface ModelConfig {
	id: string;
	label: string;
	provider: ProviderName;
	apiModelId?: string;
	quality: ModelQuality;
	category: ModelCategory;
	supportsThinking: boolean;
	supportsWebSearch: boolean;
	supportsVision?: boolean;
	supportsTools?: boolean;
	supportsJson?: boolean;
	supportsStreaming?: boolean;
	reasoning?: ModelReasoningConfig;
	recommended?: boolean;
	deprecated?: boolean;
	notes?: string;
}

export type CustomModelConfig = ModelConfig & { custom: true };

export const DEFAULT_MODEL_ID = 'gpt-5.5';

const MODEL_SOURCE_URLS: Record<ProviderName, string> = {
	openai: 'https://platform.openai.com/docs/models',
	anthropic: 'https://docs.anthropic.com/en/docs/about-claude/models/overview',
	gemini: 'https://ai.google.dev/gemini-api/docs/models',
	ollama: 'https://ollama.com/library',
};

const VERIFIED_MODEL_IDS = new Set([
	// OpenAI docs, checked 2026-05-26
	'gpt-5.5', 'gpt-5.5-pro',
	'gpt-5.4', 'gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-5.4-nano',
	'gpt-5-mini', 'gpt-5-nano',
	'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini',
	'o3', 'o4-mini',
	// Anthropic docs, checked 2026-05-30
	'claude-opus-4-8',
	'claude-sonnet-4-6', 'claude-haiku-4-5-20251001',
	// Gemini docs, checked 2026-05-26
	'gemini-3.1-pro-preview', 'gemini-3.5-flash', 'gemini-3-flash-preview',
	'gemini-3.1-flash-lite',
	'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
]);

const MODEL_ID_MIGRATIONS: Record<string, string> = {
	'gpt-5.3-codex': 'gpt-5.4',
	'gemini-3-flash': 'gemini-3.5-flash',
	'claude-opus-4-7': 'claude-opus-4-8',
	'claude-opus-4-6': 'claude-opus-4-8',
};

const BASE_MODEL_REGISTRY: ModelConfig[] = [
	// ── OpenAI: Frontier / GPT-5 ────────────────────────────────
	{
		id: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai',
		quality: 'Extra High', category: 'frontier',
		supportsThinking: true, supportsWebSearch: true, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
		recommended: true,
		notes: 'Starkes Default-Modell für Coding, Research und Vault-Agent.',
	},
	{
		id: 'gpt-5.5-pro', label: 'GPT-5.5 Pro', provider: 'openai',
		quality: 'Max', category: 'frontier',
		supportsThinking: true, supportsWebSearch: true, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
		recommended: true,
		notes: 'Max-Qualität, teurer/langsamer. Schwere Agenten- und Research-Aufgaben.',
	},
	{
		id: 'gpt-5.4', label: 'GPT-5.4', provider: 'openai',
		quality: 'High', category: 'frontier',
		supportsThinking: true, supportsWebSearch: true, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
		recommended: true,
	},
	{
		id: 'gpt-5.4-pro', label: 'GPT-5.4 Pro', provider: 'openai',
		quality: 'Extra High', category: 'frontier',
		supportsThinking: true, supportsWebSearch: true, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
	},
	{
		id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', provider: 'openai',
		quality: 'Fast', category: 'fast',
		supportsThinking: true, supportsWebSearch: true, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
		recommended: true,
		notes: 'Günstig und schnell. Gut für Vault-Agent und Coding-Aufgaben.',
	},
	{
		id: 'gpt-5.4-nano', label: 'GPT-5.4 Nano', provider: 'openai',
		quality: 'Nano', category: 'cheap',
		supportsThinking: true, supportsWebSearch: true, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
		notes: 'Sehr günstig. Klassifikation, Zusammenfassungen, Routing.',
	},
	{
		id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', provider: 'openai',
		quality: 'High', category: 'coding',
		supportsThinking: true, supportsWebSearch: false, supportsVision: false,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
		deprecated: true,
		notes: 'Nicht in der aktuellen OpenAI-Modelluebersicht verifiziert. Wird zu GPT-5.4 migriert.',
	},
	{
		id: 'gpt-5-mini', label: 'GPT-5 Mini', provider: 'openai',
		quality: 'Fast', category: 'fast',
		supportsThinking: true, supportsWebSearch: true, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
	},
	{
		id: 'gpt-5-nano', label: 'GPT-5 Nano', provider: 'openai',
		quality: 'Nano', category: 'cheap',
		supportsThinking: true, supportsWebSearch: true, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
	},
	// ── OpenAI: GPT-4.x / Legacy ────────────────────────────────
	{
		id: 'gpt-4.1', label: 'GPT-4.1', provider: 'openai',
		quality: 'Medium', category: 'legacy',
		supportsThinking: false, supportsWebSearch: false, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
	},
	{
		id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini', provider: 'openai',
		quality: 'Fast', category: 'legacy',
		supportsThinking: false, supportsWebSearch: false, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
	},
	{
		id: 'gpt-4o', label: 'GPT-4o', provider: 'openai',
		quality: 'Medium', category: 'legacy',
		supportsThinking: false, supportsWebSearch: false, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
	},
	{
		id: 'gpt-4o-mini', label: 'GPT-4o Mini', provider: 'openai',
		quality: 'Fast', category: 'legacy',
		supportsThinking: false, supportsWebSearch: false, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
	},
	{
		id: 'o4-mini', label: 'o4-mini', provider: 'openai',
		quality: 'Fast', category: 'reasoning',
		supportsThinking: true, supportsWebSearch: false, supportsVision: false,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
	},
	{
		id: 'o3', label: 'o3', provider: 'openai',
		quality: 'High', category: 'reasoning',
		supportsThinking: true, supportsWebSearch: false, supportsVision: false,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
	},

	// ── Anthropic / Claude ───────────────────────────────────────
	{
		id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'anthropic',
		quality: 'Max', category: 'frontier',
		supportsThinking: true, supportsWebSearch: true, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
		recommended: true,
		notes: 'Aktuell stärkstes Claude-Modell. 1M Kontext, 128k Output, adaptive thinking via effort.',
	},
	{
		id: 'claude-opus-4-7', label: 'Claude Opus 4.7', provider: 'anthropic',
		quality: 'Max', category: 'legacy',
		supportsThinking: true, supportsWebSearch: true, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
		deprecated: true,
		notes: 'Legacy nach Opus 4.8 Release. Gespeicherte IDs werden zu Claude Opus 4.8 migriert.',
	},
	{
		id: 'claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'anthropic',
		quality: 'Extra High', category: 'legacy',
		supportsThinking: true, supportsWebSearch: true, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
		deprecated: true,
		notes: 'Legacy nach Opus 4.8 Release. Gespeicherte IDs werden zu Claude Opus 4.8 migriert.',
	},
	{
		id: 'claude-opus-4-5', label: 'Claude Opus 4.5', provider: 'anthropic',
		quality: 'Extra High', category: 'legacy',
		supportsThinking: true, supportsWebSearch: true, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
	},
	{
		id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'anthropic',
		quality: 'High', category: 'frontier',
		supportsThinking: true, supportsWebSearch: true, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
		recommended: true,
		notes: 'Sehr gutes Default-Modell für Coding, Vault-Agent, längere Aufgaben.',
	},
	{
		id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'anthropic',
		quality: 'High', category: 'legacy',
		supportsThinking: true, supportsWebSearch: true, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
	},
	{
		id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'anthropic',
		quality: 'Fast', category: 'fast',
		supportsThinking: true, supportsWebSearch: true, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
		recommended: true,
		notes: 'Schnell und günstig. Gut für Vault-Aufgaben, Zusammenfassungen, Routing.',
	},

	// ── Gemini 3 / 3.1 ──────────────────────────────────────────
	{
		id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', provider: 'gemini',
		quality: 'Extra High', category: 'frontier',
		supportsThinking: true, supportsWebSearch: true, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
		recommended: true,
		notes: 'Sehr stark für Agentic Workflows, Coding, große Kontexte.',
	},
	{
		id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', provider: 'gemini',
		quality: 'High', category: 'frontier',
		supportsThinking: true, supportsWebSearch: true, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
		recommended: true,
		notes: 'Stabiles Gemini-3-Modell fuer agentische und Coding-Aufgaben.',
	},
	{
		id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview', provider: 'gemini',
		quality: 'High', category: 'fast',
		supportsThinking: true, supportsWebSearch: true, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
		notes: 'Preview-Modell. Fuer Default-Auswahl eher Gemini 3.5 Flash nutzen.',
	},
	{
		id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', provider: 'gemini',
		quality: 'Fast', category: 'cheap',
		supportsThinking: true, supportsWebSearch: true, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
		recommended: true,
		notes: 'Sehr günstig/schnell. Routing, Extraktion, kleine Aufgaben.',
	},
	// ── Gemini 2.5 ──────────────────────────────────────────────
	{
		id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'gemini',
		quality: 'High', category: 'legacy',
		supportsThinking: true, supportsWebSearch: true, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
	},
	{
		id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'gemini',
		quality: 'Fast', category: 'fast',
		supportsThinking: true, supportsWebSearch: true, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
	},
	{
		id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', provider: 'gemini',
		quality: 'Nano', category: 'cheap',
		supportsThinking: true, supportsWebSearch: true, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
	},
	{
		id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', provider: 'gemini',
		quality: 'Fast', category: 'legacy',
		supportsThinking: false, supportsWebSearch: true, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
	},

	// ── Ollama / Local ───────────────────────────────────────────
	{
		id: 'llama3.3', label: 'Llama 3.3', provider: 'ollama',
		quality: 'Local', category: 'local',
		supportsThinking: false, supportsWebSearch: false, supportsVision: false,
		supportsTools: false, supportsJson: true, supportsStreaming: true,
	},
	{
		id: 'llama3.2', label: 'Llama 3.2', provider: 'ollama',
		quality: 'Local', category: 'local',
		supportsThinking: false, supportsWebSearch: false, supportsVision: true,
		supportsTools: false, supportsJson: true, supportsStreaming: true,
	},
	{
		id: 'llama3.1', label: 'Llama 3.1', provider: 'ollama',
		quality: 'Local', category: 'local',
		supportsThinking: false, supportsWebSearch: false, supportsVision: false,
		supportsTools: false, supportsJson: true, supportsStreaming: true,
	},
	{
		id: 'qwen3', label: 'Qwen 3', provider: 'ollama',
		quality: 'Local', category: 'local',
		supportsThinking: true, supportsWebSearch: false, supportsVision: false,
		supportsTools: false, supportsJson: true, supportsStreaming: true,
	},
	{
		id: 'qwen2.5-coder', label: 'Qwen 2.5 Coder', provider: 'ollama',
		quality: 'Local', category: 'coding',
		supportsThinking: false, supportsWebSearch: false, supportsVision: false,
		supportsTools: false, supportsJson: true, supportsStreaming: true,
	},
	{
		id: 'deepseek-r1', label: 'DeepSeek R1', provider: 'ollama',
		quality: 'Local', category: 'reasoning',
		supportsThinking: true, supportsWebSearch: false, supportsVision: false,
		supportsTools: false, supportsJson: true, supportsStreaming: true,
	},
	{
		id: 'codellama', label: 'Code Llama', provider: 'ollama',
		quality: 'Local', category: 'coding',
		supportsThinking: false, supportsWebSearch: false, supportsVision: false,
		supportsTools: false, supportsJson: true, supportsStreaming: true,
	},
	{
		id: 'mistral', label: 'Mistral', provider: 'ollama',
		quality: 'Local', category: 'local',
		supportsThinking: false, supportsWebSearch: false, supportsVision: false,
		supportsTools: false, supportsJson: true, supportsStreaming: true,
	},
	{
		id: 'mixtral', label: 'Mixtral', provider: 'ollama',
		quality: 'Local', category: 'local',
		supportsThinking: false, supportsWebSearch: false, supportsVision: false,
		supportsTools: false, supportsJson: true, supportsStreaming: true,
	},
	{
		id: 'gemma3', label: 'Gemma 3', provider: 'ollama',
		quality: 'Local', category: 'local',
		supportsThinking: false, supportsWebSearch: false, supportsVision: true,
		supportsTools: false, supportsJson: true, supportsStreaming: true,
	},
	{
		id: 'phi4', label: 'Phi 4', provider: 'ollama',
		quality: 'Local', category: 'local',
		supportsThinking: false, supportsWebSearch: false, supportsVision: false,
		supportsTools: false, supportsJson: true, supportsStreaming: true,
	},
	{
		id: 'gpt-oss:20b', label: 'GPT-OSS 20B', provider: 'ollama',
		quality: 'Local', category: 'local',
		supportsThinking: true, supportsWebSearch: false, supportsVision: false,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
	},
	{
		id: 'gpt-oss:120b', label: 'GPT-OSS 120B', provider: 'ollama',
		quality: 'Local', category: 'local',
		supportsThinking: true, supportsWebSearch: false, supportsVision: false,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
	},
];

type VariantSpec = {
	suffix: string;
	label: string;
	reasoning: ModelReasoningConfig;
	recommended?: boolean;
	notes?: string;
};

function withVariant(base: ModelConfig, spec: VariantSpec): ModelConfig {
	return {
		...base,
		id: `${base.id}#${spec.suffix}`,
		label: `${base.label} · ${spec.label}`,
		apiModelId: base.apiModelId ?? base.id,
		reasoning: spec.reasoning,
		recommended: spec.recommended ?? false,
		notes: spec.notes ?? base.notes,
	};
}

function openAiVariants(efforts: ReasoningEffort[], recommended?: ReasoningEffort): VariantSpec[] {
	return efforts.map(effort => ({
		suffix: `reasoning-${effort}`,
		label: effort,
		reasoning: { provider: 'openai', effort },
		recommended: effort === recommended,
	}));
}

function anthropicAdaptiveVariants(
	defaultEffort?: Exclude<ReasoningEffort, 'none' | 'minimal'>,
	efforts: Array<Exclude<ReasoningEffort, 'none' | 'minimal'>> = ['low', 'medium', 'high'],
): VariantSpec[] {
	return [
		{ suffix: 'thinking-off', label: 'thinking off', reasoning: { provider: 'anthropic', mode: 'off' } },
		...efforts.map(effort => ({
			suffix: `thinking-${effort}`,
			label: `thinking ${effort}`,
			reasoning: { provider: 'anthropic', mode: 'adaptive', effort } as const,
			recommended: effort === defaultEffort,
		})),
	];
}

function anthropicManualVariants(defaultEffort?: 'low' | 'medium' | 'high'): VariantSpec[] {
	const budgets: Record<'low' | 'medium' | 'high', number> = { low: 2_000, medium: 8_000, high: 32_000 };
	return [
		{ suffix: 'thinking-off', label: 'thinking off', reasoning: { provider: 'anthropic', mode: 'off' } },
		...(['low', 'medium', 'high'] as const).map(effort => ({
			suffix: `thinking-${effort}`,
			label: `thinking ${effort}`,
			reasoning: { provider: 'anthropic', mode: 'manual', budgetTokens: budgets[effort], effort } as const,
			recommended: effort === defaultEffort,
		})),
	];
}

function geminiLevelVariants(defaultLevel?: GeminiThinkingLevel, levels: GeminiThinkingLevel[] = ['minimal', 'low', 'medium', 'high']): VariantSpec[] {
	return levels.map(level => ({
		suffix: `thinking-${level}`,
		label: `thinking ${level}`,
		reasoning: { provider: 'gemini', mode: 'level', level },
		recommended: level === defaultLevel,
	}));
}

function geminiBudgetVariants(defaultLabel?: string, includeHigh = true): VariantSpec[] {
	const variants: VariantSpec[] = [
		{ suffix: 'thinking-off', label: 'thinking off', reasoning: { provider: 'gemini', mode: 'budget', budget: 0 }, recommended: defaultLabel === 'off' },
		{ suffix: 'thinking-dynamic', label: 'thinking dynamic', reasoning: { provider: 'gemini', mode: 'budget', budget: -1 }, recommended: defaultLabel === 'dynamic' },
		{ suffix: 'thinking-low', label: 'thinking low', reasoning: { provider: 'gemini', mode: 'budget', budget: 1_024 }, recommended: defaultLabel === 'low' },
		{ suffix: 'thinking-medium', label: 'thinking medium', reasoning: { provider: 'gemini', mode: 'budget', budget: 8_192 }, recommended: defaultLabel === 'medium' },
	];
	if (includeHigh) {
		variants.push({ suffix: 'thinking-high', label: 'thinking high', reasoning: { provider: 'gemini', mode: 'budget', budget: 32_768 }, recommended: defaultLabel === 'high' });
	}
	return variants;
}

function ollamaThinkingVariants(kind: 'boolean' | 'gpt-oss'): VariantSpec[] {
	if (kind === 'gpt-oss') {
		return (['low', 'medium', 'high'] as const).map(level => ({
			suffix: `thinking-${level}`,
			label: `thinking ${level}`,
			reasoning: { provider: 'ollama', mode: 'think', think: level },
			recommended: level === 'medium',
		}));
	}
	return [
		{ suffix: 'thinking-off', label: 'thinking off', reasoning: { provider: 'ollama', mode: 'think', think: false } },
		{ suffix: 'thinking-on', label: 'thinking on', reasoning: { provider: 'ollama', mode: 'think', think: true }, recommended: true },
	];
}

function variantsFor(base: ModelConfig): VariantSpec[] {
	switch (base.id) {
		case 'gpt-5.5': return openAiVariants(['none', 'low', 'medium', 'high', 'xhigh'], 'medium');
		case 'gpt-5.5-pro': return openAiVariants(['high'], 'high');
		case 'gpt-5.4': return openAiVariants(['none', 'low', 'medium', 'high', 'xhigh'], 'none');
		case 'gpt-5.4-pro': return openAiVariants(['high'], 'high');
		case 'gpt-5.4-mini':
		case 'gpt-5.4-nano':
		case 'gpt-5.3-codex':
			return openAiVariants(['none', 'low', 'medium', 'high', 'xhigh']);
		case 'gpt-5-mini':
		case 'gpt-5-nano':
			return openAiVariants(['none', 'low', 'medium', 'high']);
		case 'o3':
		case 'o4-mini':
			return openAiVariants(['low', 'medium', 'high'], 'medium');
		case 'claude-opus-4-8': return anthropicAdaptiveVariants('xhigh', ['low', 'medium', 'high', 'xhigh', 'max']);
		case 'claude-opus-4-7': return anthropicAdaptiveVariants('xhigh', ['low', 'medium', 'high', 'xhigh', 'max']);
		case 'claude-opus-4-6': return anthropicAdaptiveVariants('medium', ['low', 'medium', 'high', 'max']);
		case 'claude-sonnet-4-6': return anthropicAdaptiveVariants('medium', ['low', 'medium', 'high', 'max']);
		case 'claude-opus-4-5':
		case 'claude-sonnet-4-5':
			return anthropicManualVariants('medium');
		case 'claude-haiku-4-5-20251001':
			return [
				{ suffix: 'thinking-off', label: 'thinking off', reasoning: { provider: 'anthropic', mode: 'off' }, recommended: true },
				{ suffix: 'thinking-on', label: 'thinking on', reasoning: { provider: 'anthropic', mode: 'manual', budgetTokens: 4_096, effort: 'low' } },
			];
		case 'gemini-3.1-pro-preview': return geminiLevelVariants('high', ['minimal', 'high']);
		case 'gemini-3.5-flash': return geminiLevelVariants('low');
		case 'gemini-3-flash-preview': return geminiLevelVariants('low');
		case 'gemini-3.1-flash-lite': return geminiLevelVariants('low');
		case 'gemini-2.5-pro': return geminiBudgetVariants('dynamic');
		case 'gemini-2.5-flash': return geminiBudgetVariants('dynamic');
		case 'gemini-2.5-flash-lite': return geminiBudgetVariants('off', false).filter(v => v.suffix === 'thinking-off');
		case 'qwen3': return ollamaThinkingVariants('boolean');
		case 'deepseek-r1': return [{ suffix: 'thinking-on', label: 'thinking on', reasoning: { provider: 'ollama', mode: 'think', think: true }, recommended: true }];
		case 'gpt-oss:20b':
		case 'gpt-oss:120b':
			return ollamaThinkingVariants('gpt-oss');
		default:
			return [];
	}
}

function applyDefaultReasoning(base: ModelConfig, variants: VariantSpec[]): ModelConfig {
	const recommended = variants.find(v => v.recommended);
	if (!recommended) return base;
	return { ...base, reasoning: recommended.reasoning };
}

export const MODEL_REGISTRY: ModelConfig[] = BASE_MODEL_REGISTRY.flatMap(base => {
	if (base.deprecated) return [base];
	const variants = variantsFor(base);
	if (variants.length === 0) return [base];
	return [applyDefaultReasoning(base, variants), ...variants.map(spec => withVariant(base, spec))];
});

function baseModelId(modelId: string): string {
	return modelId.split('#')[0] ?? modelId;
}

export function getModelApiId(model: ModelConfig): string {
	return model.apiModelId ?? model.id;
}

export function isReasoningActive(reasoning: ModelReasoningConfig | undefined): boolean {
	if (!reasoning) return false;
	if (reasoning.provider === 'openai') return reasoning.effort !== 'none';
	if (reasoning.provider === 'anthropic') return reasoning.mode !== 'off';
	if (reasoning.provider === 'gemini') return reasoning.mode === 'level' ? reasoning.level !== 'minimal' : reasoning.budget !== 0;
	if (reasoning.provider === 'ollama') return reasoning.think !== false;
	return false;
}

export function describeModelReasoning(reasoning: ModelReasoningConfig | undefined): string {
	if (!reasoning) return 'aus';
	if (reasoning.provider === 'openai') return reasoning.effort;
	if (reasoning.provider === 'anthropic') {
		if (reasoning.mode === 'off') return 'thinking off';
		if (reasoning.mode === 'adaptive') return `thinking ${reasoning.effort}`;
		return `thinking budget ${reasoning.budgetTokens}`;
	}
	if (reasoning.provider === 'gemini') {
		if (reasoning.mode === 'level') return `thinking ${reasoning.level}`;
		return reasoning.budget === -1 ? 'thinking dynamic' : `thinking budget ${reasoning.budget}`;
	}
	if (reasoning.provider === 'ollama') return reasoning.think === false ? 'thinking off' : `thinking ${reasoning.think === true ? 'on' : reasoning.think}`;
	return 'aus';
}

export function legacyThinkingReasoning(model: ModelConfig): ModelReasoningConfig | undefined {
	if (!model.supportsThinking) return undefined;
	if (model.provider === 'openai') return { provider: 'openai', effort: 'high' };
	if (model.provider === 'anthropic') {
		if (model.id.includes('4-8') || model.id.includes('4-7') || model.id.includes('4-6')) return { provider: 'anthropic', mode: 'adaptive', effort: 'high' };
		return { provider: 'anthropic', mode: 'manual', budgetTokens: 10_000, effort: 'high' };
	}
	if (model.provider === 'gemini') {
		if (model.id.includes('gemini-3')) return { provider: 'gemini', mode: 'level', level: 'high' };
		if (model.id.includes('gemini-2.5')) return { provider: 'gemini', mode: 'budget', budget: -1 };
	}
	if (model.provider === 'ollama') {
		return { provider: 'ollama', mode: 'think', think: model.id.includes('gpt-oss') ? 'high' : true };
	}
	return undefined;
}

// ── Helper functions ──────────────────────────────────────────

export function getAllModels(customModels: CustomModelConfig[] = []): ModelConfig[] {
	return [...MODEL_REGISTRY, ...customModels];
}

export function getModelConfigWithCustom(
	modelId: string,
	customModels: CustomModelConfig[] = []
): ModelConfig | undefined {
	return getAllModels(customModels).find(m => m.id === modelId);
}

export function getModelAvailability(model: ModelConfig): ModelAvailability {
	if ('custom' in model && model.custom) return 'custom';
	if (model.provider === 'ollama') return 'local';
	if (model.deprecated || model.category === 'legacy') return 'legacy';
	const base = baseModelId(model.id);
	if (model.id.includes('preview') || base.includes('preview')) return 'preview';
	return VERIFIED_MODEL_IDS.has(base) ? 'verified' : 'unverified';
}

export function getModelSourceUrl(model: ModelConfig): string {
	return MODEL_SOURCE_URLS[model.provider];
}

export function migrateModelId(modelId: string, customModels: CustomModelConfig[] = []): string {
	if (!modelId) return DEFAULT_MODEL_ID;
	if (getModelConfigWithCustom(modelId, customModels) && !getModelConfigWithCustom(modelId, customModels)?.deprecated) {
		return modelId;
	}

	const [base, suffix] = modelId.split('#');
	const migratedBase = MODEL_ID_MIGRATIONS[base ?? ''] ?? base ?? DEFAULT_MODEL_ID;
	const migratedWithSuffix = suffix ? `${migratedBase}#${suffix}` : migratedBase;
	const withSuffix = getModelConfigWithCustom(migratedWithSuffix, customModels);
	if (withSuffix && !withSuffix.deprecated) return migratedWithSuffix;

	const withoutSuffix = getModelConfigWithCustom(migratedBase, customModels);
	if (withoutSuffix && !withoutSuffix.deprecated) return migratedBase;

	return DEFAULT_MODEL_ID;
}

export function getRecommendedModels(): ModelConfig[] {
	return MODEL_REGISTRY.filter(m => m.recommended && !m.deprecated);
}

export function getModelsByProvider(provider: ProviderName, customModels: CustomModelConfig[] = []): ModelConfig[] {
	return getAllModels(customModels).filter(m => m.provider === provider && !m.deprecated);
}

export function searchModels(query: string, customModels: CustomModelConfig[] = []): ModelConfig[] {
	const q = query.trim().toLowerCase();
	const all = getAllModels(customModels).filter(m => !m.deprecated);
	if (!q) return all;
	return all.filter(m =>
		m.id.toLowerCase().includes(q) ||
		m.label.toLowerCase().includes(q) ||
		m.provider.toLowerCase().includes(q) ||
		m.quality.toLowerCase().includes(q) ||
		m.category.toLowerCase().includes(q)
	);
}
