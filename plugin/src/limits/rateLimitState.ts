export interface RateLimitInfo {
	lastErrorAt?: number;
	retryAfterSeconds?: number;

	limitRequests?: number;
	remainingRequests?: number;
	limitTokens?: number;
	remainingTokens?: number;

	learnedTpm?: number;
}

export interface ParsedRateLimitError {
	retryAfterSeconds: number;
	learnedTpm?: number;
}

export class RateLimitManager {
	private states = new Map<string, RateLimitInfo>();

	private key(provider: string, model: string) {
		return `${provider}:${model}`;
	}

	private getOrCreate(provider: string, model: string): RateLimitInfo {
		const k = this.key(provider, model);
		if (!this.states.has(k)) this.states.set(k, {});
		return this.states.get(k)!;
	}

	get(provider: string, model: string): RateLimitInfo | undefined {
		return this.states.get(this.key(provider, model));
	}

	// Called after every response (successful or error) to learn from headers
	updateFromHeaders(provider: string, model: string, headers: Record<string, string>): void {
		const state = this.getOrCreate(provider, model);

		// OpenAI rate limit headers
		const oaiLimitTok = headers['x-ratelimit-limit-tokens'];
		const oaiRemTok   = headers['x-ratelimit-remaining-tokens'];
		const oaiLimitReq = headers['x-ratelimit-limit-requests'];
		const oaiRemReq   = headers['x-ratelimit-remaining-requests'];
		if (oaiLimitTok) state.limitTokens     = parseInt(oaiLimitTok, 10);
		if (oaiRemTok)   state.remainingTokens = parseInt(oaiRemTok,   10);
		if (oaiLimitReq) state.limitRequests   = parseInt(oaiLimitReq, 10);
		if (oaiRemReq)   state.remainingRequests = parseInt(oaiRemReq, 10);

		// Anthropic rate limit headers
		const antLimitIn  = headers['anthropic-ratelimit-input-tokens-limit'];
		const antRemIn    = headers['anthropic-ratelimit-input-tokens-remaining'];
		const antLimitReq = headers['anthropic-ratelimit-requests-limit'];
		const antRemReq   = headers['anthropic-ratelimit-requests-remaining'];
		if (antLimitIn)  state.limitTokens      = parseInt(antLimitIn, 10);
		if (antRemIn)    state.remainingTokens   = parseInt(antRemIn,   10);
		if (antLimitReq) state.limitRequests     = parseInt(antLimitReq, 10);
		if (antRemReq)   state.remainingRequests = parseInt(antRemReq,   10);

		// retry-after (Anthropic on 429, OpenAI sometimes)
		const retryAfter = headers['retry-after'];
		if (retryAfter) {
			state.retryAfterSeconds = Math.ceil(parseFloat(retryAfter));
			state.lastErrorAt       = Date.now();
		}
	}

	// Called when a 429 error is caught — parses error text for retry-after / limit info
	updateFromError(provider: string, model: string, errorText: string): ParsedRateLimitError {
		const state = this.getOrCreate(provider, model);

		// OpenAI: "Limit 20000, Used 19145, Requested 44368. try again in 11.254s"
		const limitMatch = errorText.match(/Limit\s+(\d[\d,]*)/i);
		// "try again in N.NNNs" or "try again in Ns"
		const retryMatch = errorText.match(/try again in\s+([\d.]+)s/i);
		// Anthropic / generic: "retry-after: 30" or "Retry-After: 30"
		const retryHeaderMatch = errorText.match(/retry.after[:\s]+([\d.]+)/i);

		if (limitMatch?.[1]) {
			state.learnedTpm = parseInt(limitMatch[1].replace(/,/g, ''), 10);
		}

		const retrySeconds = retryMatch?.[1]
			? Math.ceil(parseFloat(retryMatch[1]))
			: retryHeaderMatch?.[1]
			? Math.ceil(parseFloat(retryHeaderMatch[1]))
			: 30;

		state.retryAfterSeconds = retrySeconds;
		state.lastErrorAt       = Date.now();

		return { retryAfterSeconds: retrySeconds, learnedTpm: state.learnedTpm };
	}

	// Returns how many seconds remain before it's safe to retry (0 = no wait needed)
	shouldWait(provider: string, model: string): number {
		const state = this.get(provider, model);
		if (!state?.lastErrorAt || !state.retryAfterSeconds) return 0;
		const elapsed  = (Date.now() - state.lastErrorAt) / 1000;
		const remaining = state.retryAfterSeconds - elapsed;
		return Math.max(0, Math.ceil(remaining));
	}

	// Effective TPM learned from the last error (or undefined if not yet known)
	learnedTpm(provider: string, model: string): number | undefined {
		return this.get(provider, model)?.learnedTpm;
	}
}

export const rateLimitManager = new RateLimitManager();
