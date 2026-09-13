/**
 * Origin handling shared by both credentials. An origin is scheme + host (+ port) only.
 * Plain http is accepted for loopback hosts only (a local test server); everything else
 * must be https.
 */

export const DEFAULT_ORIGIN = 'https://technocore.chat';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export class OriginError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'OriginError';
	}
}

function parseUrl(value: string): URL | null {
	try {
		return new URL(value);
	} catch {
		return null;
	}
}

export function normalizeOrigin(value: unknown): string {
	const raw = typeof value === 'string' ? value.trim() : '';
	const url = parseUrl(raw || DEFAULT_ORIGIN);
	if (!url) {
		throw new OriginError('The Technocore origin must be a URL such as https://technocore.chat');
	}
	if (url.username || url.password) {
		throw new OriginError('The Technocore origin must not contain a user name or password');
	}
	if (url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
		throw new OriginError(
			'The Technocore origin must be scheme and host only (for example https://technocore.chat), with no path or query',
		);
	}
	const loopback = LOOPBACK_HOSTS.has(url.hostname);
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
		throw new OriginError(
			'The Technocore origin must use https (plain http is allowed for localhost only)',
		);
	}
	return url.origin;
}

/**
 * Resolves the URL a request will actually hit from n8n's `url` + optional `baseURL`, and
 * checks it stays on `origin`. Returns the parsed absolute URL.
 */
export function resolveOnOrigin(origin: string, url: unknown, baseURL: unknown): URL {
	if (typeof url !== 'string' || url === '') {
		throw new OriginError('The Technocore request has no URL');
	}
	let base = origin;
	if (baseURL !== undefined && baseURL !== null && baseURL !== '') {
		base = normalizeOrigin(baseURL);
		if (base !== origin)
			throw new OriginError('The Technocore request base URL is not the credential origin');
	}
	let resolved: URL | null = null;
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
		resolved = parseUrl(url);
	} else if (url.startsWith('/') && !url.startsWith('//')) {
		resolved = parseUrl(base + url);
	}
	if (!resolved) {
		throw new OriginError('The Technocore request URL must be absolute or start with a single "/"');
	}
	if (resolved.origin !== origin || resolved.username || resolved.password) {
		throw new OriginError('The Technocore request URL is not on the credential origin');
	}
	return resolved;
}
