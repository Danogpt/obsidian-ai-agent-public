// ProviderName lives here to avoid circular imports between settings ↔ modelRegistry
export type ProviderName = 'openai' | 'anthropic' | 'gemini' | 'ollama';

export type ModelQuality = 'Max' | 'Extra High' | 'High' | 'Medium' | 'Fast' | 'Nano' | 'Local';

export type ModelCategory =
	| 'frontier' | 'reasoning' | 'coding'
	| 'fast' | 'cheap' | 'vision' | 'local' | 'legacy' | 'custom';

export interface ModelConfig {
	id: string;
	label: string;
	provider: ProviderName;
	quality: ModelQuality;
	category: ModelCategory;
	supportsThinking: boolean;
	supportsWebSearch: boolean;
	supportsVision?: boolean;
	supportsTools?: boolean;
	supportsJson?: boolean;
	supportsStreaming?: boolean;
	recommended?: boolean;
	deprecated?: boolean;
	notes?: string;
}

export type CustomModelConfig = ModelConfig & { custom: true };

export const MODEL_REGISTRY: ModelConfig[] = [
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
		notes: 'Coding- und Agent-Modell.',
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
		id: 'claude-opus-4-7', label: 'Claude Opus 4.7', provider: 'anthropic',
		quality: 'Max', category: 'frontier',
		supportsThinking: true, supportsWebSearch: true, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
		recommended: true,
		notes: 'Stärkstes Claude-Modell. Lange Agenten-/Coding-Aufgaben.',
	},
	{
		id: 'claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'anthropic',
		quality: 'Extra High', category: 'frontier',
		supportsThinking: true, supportsWebSearch: true, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
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
		id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview', provider: 'gemini',
		quality: 'High', category: 'fast',
		supportsThinking: true, supportsWebSearch: true, supportsVision: true,
		supportsTools: true, supportsJson: true, supportsStreaming: true,
		recommended: true,
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
