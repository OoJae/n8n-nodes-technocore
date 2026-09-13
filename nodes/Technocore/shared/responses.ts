/**
 * Response helpers specific to the n8n nodes. Room views and export lines are parsed by the
 * vendored technocore-watch-core protocol (bigint-safe nonces); this file adds what the
 * nodes need on top: the POST reply's `posted` record, note bodies, refusal classification
 * with the message text for NodeApiError, and the stale-nonce / canonical-string hints.
 */
import { ProtocolError, parseReadView, quoteNonceNumbers, toMessage } from './protocol/parse.ts';
import type { Message, ReadView } from './protocol/types.ts';

export { ProtocolError };

export type RateBucket = 'read' | 'write' | 'rooms';

export type Refusal =
	| {
			kind: 'rate';
			status: 429;
			bucket?: RateBucket;
			perMinute?: number;
			retryAfterS?: number;
			message: string;
	  }
	| {
			kind: 'bad-request' | 'forbidden' | 'not-found' | 'conflict' | 'duplicate' | 'too-large' | 'timeout';
			status: number;
			message: string;
	  }
	| { kind: 'server'; status: number; message: string };

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A room write reply: the read view plus the `posted` record that landed. */
export function parseRoomReply(body: string): { view: ReadView; posted?: Message } {
	const view = parseReadView(body);
	let posted: Message | undefined;
	const raw: unknown = JSON.parse(quoteNonceNumbers(body));
	if (isObject(raw) && raw.posted !== undefined) posted = toMessage(raw.posted);
	return { view, posted };
}

/** Parses a note write reply (`POST /kv/<ns>/<key>?format=json`). */
export function parseJsonObject(body: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		parsed = undefined;
	}
	if (!isObject(parsed)) throw new ProtocolError('Technocore returned a body that is not a JSON object');
	return parsed;
}

export const UNTRUSTED_BANNER_PREFIX = '!! UNTRUSTED CONTENT';

/**
 * A note read is `<banner>\n\n<value>` plus an optional `\n# budget: ...` footer. A stored
 * value is always one line (the sweep turns newlines into spaces), so the value is exactly
 * the third line.
 */
export function parseNoteBody(body: string): string {
	const lines = body.split('\n');
	if (lines.length < 3 || !lines[0].startsWith(UNTRUSTED_BANNER_PREFIX) || lines[1] !== '') {
		throw new ProtocolError('Technocore returned a note body in an unexpected format');
	}
	return lines[2];
}

function firstLine(body: string): string {
	const line = body.split('\n', 1)[0] ?? '';
	return line.length > 300 ? `${line.slice(0, 300)}...` : line;
}

function headerValue(headers: Record<string, unknown> | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name.toLowerCase()) {
			if (Array.isArray(value)) return value.length ? String(value[0]) : undefined;
			return value === undefined || value === null ? undefined : String(value);
		}
	}
	return undefined;
}

/** Classifies a non-2xx reply. Headers are a plain object (as n8n returns them). */
export function classifyRefusal(
	status: number,
	body: string,
	headers?: Record<string, unknown>,
): Refusal {
	const message = firstLine(body) || `HTTP ${status}`;
	if (status === 429) {
		const refusal: Refusal = { kind: 'rate', status: 429, message };
		const bucket = /the (read|write) budget for your IP \((\d+)\/min\)/.exec(body);
		if (bucket) {
			refusal.bucket = bucket[1] as RateBucket;
			refusal.perMinute = Number(bucket[2]);
		} else if (/room-creation budget/.test(body)) {
			refusal.bucket = 'rooms';
		}
		const header = headerValue(headers, 'retry-after');
		const fromBody = /retry after: (\d+)s/.exec(body);
		const retry = header !== undefined && /^\d+$/.test(header) ? Number(header) : fromBody ? Number(fromBody[1]) : undefined;
		if (retry !== undefined) refusal.retryAfterS = retry;
		return refusal;
	}
	if (status === 400) {
		return { kind: 'bad-request', status, message };
	}
	if (status === 403) return { kind: 'forbidden', status, message };
	if (status === 404) return { kind: 'not-found', status, message };
	if (status === 408) return { kind: 'timeout', status, message };
	if (status === 409) return { kind: 'conflict', status, message };
	if (status === 413) return { kind: 'too-large', status, message };
	if (status === 422) return { kind: 'duplicate', status, message };
	return { kind: 'server', status, message };
}

/** `400 ... nonce N is not greater than P, the last one this key used in /r/<room> ...` */
export function parseStaleNonce(body: string): string | null {
	const match = /nonce ([0-9]{1,19}) is not greater than ([0-9]{1,19}), the last one this key used/.exec(body);
	return match ? match[2] : null;
}

/** The server-verified canonical string quoted in a 403 signature refusal, if any. */
export function parseExpectedCanonical(body: string): string | null {
	const marker = 'it must cover exactly this string, UTF-8, Ed25519, base64url:\n';
	const index = body.indexOf(marker);
	if (index < 0) return null;
	return body.slice(index + marker.length).replace(/\n$/, '');
}
