import type { ChatRequestPayload, ChatResponsePayload } from '../agent/types';
import { callOpenAI }   from './openai';
import { callAnthropic } from './anthropic';
import { callGemini }   from './gemini';
import { callOllama }   from './ollama';

export async function callProvider(payload: ChatRequestPayload): Promise<ChatResponsePayload> {
	switch (payload.provider) {
		case 'openai':    return callOpenAI(payload);
		case 'anthropic': return callAnthropic(payload);
		case 'gemini':    return callGemini(payload);
		case 'ollama':    return callOllama(payload);
		default:          throw new Error(`Unknown provider: ${String(payload.provider)}`);
	}
}
