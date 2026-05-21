import { requestUrl } from 'obsidian';

export class ProviderError extends Error {
	constructor(
		public readonly provider: string,
		public readonly status: number,
		message: string,
	) {
		super(`${provider} ${status}: ${message}`);
		this.name = 'ProviderError';
	}
}

export async function postJson<T>(
	url: string,
	body: unknown,
	headers: Record<string, string>,
	timeoutMs = 120_000,
	onResponseHeaders?: (headers: Record<string, string>) => void,
): Promise<T> {
	const timeout = new Promise<never>((_, reject) =>
		setTimeout(() => reject(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs),
	);

	const request = requestUrl({
		url,
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: JSON.stringify(body),
		throw: false,
	});

	const response = await Promise.race([request, timeout]);

	// Always call the header callback so the caller can learn rate-limit state
	// from 429 responses as well as successful ones.
	onResponseHeaders?.(response.headers);

	if (response.status < 200 || response.status >= 300) {
		const provider = (() => { try { return new URL(url).hostname; } catch { return 'provider'; } })();
		throw new ProviderError(provider, response.status, response.text);
	}

	return response.json as T;
}

export function bearerHeaders(apiKey: string): Record<string, string> {
	return { Authorization: `Bearer ${apiKey}` };
}
