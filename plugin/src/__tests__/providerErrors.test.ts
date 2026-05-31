import { describe, expect, it } from 'vitest';
import { ProviderError, redactSecretLikeText, redactUrlSecrets } from '../providers/http';

describe('provider secret redaction', () => {
	it('redacts secret query parameters in URLs', () => {
		const url = redactUrlSecrets('https://example.com/path?key=SECRET123&model=test&token=TOKEN456');
		expect(url).toContain('key=%5Bredacted%5D');
		expect(url).toContain('token=%5Bredacted%5D');
		expect(url).toContain('model=test');
		expect(url).not.toContain('SECRET123');
		expect(url).not.toContain('TOKEN456');
	});

	it('redacts secret-like text inside provider messages', () => {
		const msg = redactSecretLikeText('failed: https://api.test?api_key=SECRET123 and key=AIzaSySecretKey_1234567890');
		expect(msg).toContain('api_key=[redacted]');
		expect(msg).toContain('[redacted-gemini-key]');
		expect(msg).not.toContain('SECRET123');
		expect(msg).not.toContain('AIzaSySecretKey_1234567890');
	});

	it('sanitizes ProviderError messages', () => {
		const err = new ProviderError('gemini', 400, 'bad request: ?key=AIzaSySecretKey_1234567890');
		expect(err.message).toContain('gemini 400');
		expect(err.message).toContain('key=[redacted]');
		expect(err.message).not.toContain('AIzaSySecretKey_1234567890');
	});
});
