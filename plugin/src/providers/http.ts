import { requestUrl } from 'obsidian';

const SECRET_QUERY_KEYS = new Set(['key', 'api_key', 'apikey', 'token', 'access_token']);

export function redactUrlSecrets(input: string): string {
	try {
		const url = new URL(input);
		let changed = false;
		for (const key of Array.from(url.searchParams.keys())) {
			if (SECRET_QUERY_KEYS.has(key.toLowerCase())) {
				url.searchParams.set(key, '[redacted]');
				changed = true;
			}
		}
		return changed ? url.toString() : input;
	} catch {
		return input;
	}
}

export function redactSecretLikeText(message: string): string {
	return message
		.replace(/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s"']+/gi, '$1[redacted]')
		.replace(/(AIza[0-9A-Za-z_-]{10,})/g, '[redacted-gemini-key]');
}

export class ProviderError extends Error {
	constructor(
		public readonly provider: string,
		public readonly status: number,
		message: string,
	) {
		super(`${provider} ${status}: ${redactSecretLikeText(message)}`);
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
