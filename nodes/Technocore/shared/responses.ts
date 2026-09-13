/**
 * Parsing of Technocore responses for the n8n nodes. Pure: strings in, values out.
 *
 * Nonces are stored as JSON integers of up to 19 digits, past Number's 2^53, so every
 * `"nonce": <integer>` member is rewritten to a string literal by a JSON-aware scanner
 * before JSON.parse (a regex would also rewrite look-alikes inside message text).
 *
 * technocore-watch-core has an equivalent parse.ts; it is not vendored because it throws
 * inside a catch clause, which the n8n community-node rules reject (see VENDOR.json). The
 * message and view types are the vendored ones.
 */
import type { Message, ReadView } from './protocol/types.ts';

export class ProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProtocolError';
	}
}

const WS = new Set([' ', '\t', '\n', '\r']);

/**
 * Returns `json` with the integer value of every object member named `nonce` quoted.
 * Walks the text once, tracking string boundaries and escapes, so text inside string
 * values is never touched. Non-integer values are left alone.
 */
export function quoteNonceIntegers(json: string): string {
	let out = '';
	let i = 0;
	let lastString: string | null = null;
	const n = json.length;
	while (i < n) {
		const ch = json[i];
		if (ch === '"') {
			let j = i + 1;
			while (j < n && json[j] !== '"') j += json[j] === '\\' ? 2 : 1;
			lastString = json.slice(i + 1, Math.min(j, n));
			out += json.slice(i, j + 1);
			i = j + 1;
			continue;
		}
		if (WS.has(ch)) {
			out += ch;
			i++;
			continue;
		}
		if (ch === ':') {
			out += ch;
			i++;
			if (lastString === 'nonce') {
				while (i < n && WS.has(json[i])) out += json[i++];
				let k = i;
				if (json[k] === '-') k++;
				while (k < n && json[k] >= '0' && json[k] <= '9') k++;
				const literal = json.slice(i, k);
				const next = json[k];
				if (/^-?[0-9]+$/.test(literal) && next !== '.' && next !== 'e' && next !== 'E') {
					out += `"${literal}"`;
					i = k;
				}
			}
			lastString = null;
			continue;
		}
		lastString = null;
		out += ch;
		i++;
	}
	return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toMessage(value: unknown): Message | null {
	if (!isObject(value)) return null;
	const { seq, ts, from, text, nonce, sig } = value;
	if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) return null;
	if (typeof ts !== 'string' || typeof from !== 'string' || typeof text !== 'string') return null;
	const message: Message = { seq, ts, from, text };
	if (typeof nonce === 'string' && /^[0-9]{1,19}$/.test(nonce)) message.nonce = nonce;
	if (typeof sig === 'string') message.sig = sig;
	return message;
}

/** Parses a `GET /r/<room>?format=json` body (also the `POST` reply's view part). */
function parseView(body: string): ReadView & { posted?: Message } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(quoteNonceIntegers(body));
	} catch {
		parsed = undefined;
	}
	if (!isObject(parsed)) {
		throw new ProtocolError('Technocore returned a room view that is not a JSON object');
	}
	const { room, count, first_seq, last_seq, generation, messages, wait_held, posted } = parsed;
	if (typeof room !== 'string' || typeof last_seq !== 'number' || !Array.isArray(messages)) {
		throw new ProtocolError('Technocore returned a room view without room, last_seq or messages');
	}
	const parsedMessages: Message[] = [];
	for (const entry of messages) {
		const message = toMessage(entry);
		if (!message) throw new ProtocolError('Technocore returned a malformed message record');
		parsedMessages.push(message);
	}
	const view: ReadView & { posted?: Message } = {
		room,
		count: typeof count === 'number' ? count : parsedMessages.length,
		first_seq: typeof first_seq === 'number' ? first_seq : null,
		last_seq,
		messages: parsedMessages,
	};
	if (typeof generation === 'number' && Number.isSafeInteger(generation)) {
		view.generation = generation;
	}
	if (typeof wait_held === 'boolean') view.wait_held = wait_held;
	const postedMessage = toMessage(posted);
	if (postedMessage) view.posted = postedMessage;
	return view;
}

/**
 * One line of `GET /r/<room>/export` (raw stored JSONL). Returns null for a blank or
 * unparseable line: the store heals a torn record by skipping it, and so does this.
 */
export function parseExportLine(line: string): Message | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		return toMessage(JSON.parse(quoteNonceIntegers(trimmed)));
	} catch {
		return null;
	}
}

/** Parses a `GET /r/<room>?format=json` body. */
export function parseReadView(body: string): ReadView {
	const view = parseView(body);
	delete view.posted;
	return view;
}

/** A room write reply: the read view plus the `posted` record that landed. */
export function parseRoomReply(body: string): { view: ReadView; posted?: Message } {
	const { posted, ...view } = parseView(body);
	return { view, posted };
}

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
			kind:
				| 'bad-request'
				| 'forbidden'
				| 'not-found'
				| 'conflict'
				| 'duplicate'
				| 'too-large'
				| 'timeout';
			status: number;
			message: string;
	  }
	| { kind: 'server'; status: number; message: string };

/** Parses a note write reply (`POST /kv/<ns>/<key>?format=json`). */
export function parseJsonObject(body: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		parsed = undefined;
	}
	if (!isObject(parsed))
		throw new ProtocolError('Technocore returned a body that is not a JSON object');
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

function headerValue(
	headers: Record<string, unknown> | undefined,
	name: string,
): string | undefined {
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
		const retry =
			header !== undefined && /^\d+$/.test(header)
				? Number(header)
				: fromBody
					? Number(fromBody[1])
					: undefined;
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

/**
 * The note value a `409` conditional-write refusal carries: the body ends with
 * `current value follows (N chars):\n<value>`, N counted in code points. Returns null when
 * there is no value (an `if` against a missing note) or the body is shorter than announced.
 */
export function parseConflictValue(body: string): string | null {
	const match = /(?:^|\n)current value follows \(([0-9]{1,6}) chars\):\n/.exec(body);
	if (!match) return null;
	const points = Array.from(body.slice(match.index + match[0].length));
	const length = Number(match[1]);
	return points.length >= length ? points.slice(0, length).join('') : null;
}

/** `400 ... nonce N is not greater than P, the last one this key used in /r/<room> ...` */
export function parseStaleNonce(body: string): string | null {
	const match =
		/nonce ([0-9]{1,19}) is not greater than ([0-9]{1,19}), the last one this key used/.exec(body);
	return match ? match[2] : null;
}

/** The server-verified canonical string quoted in a 403 signature refusal, if any. */
export function parseExpectedCanonical(body: string): string | null {
	const marker = 'it must cover exactly this string, UTF-8, Ed25519, base64url:\n';
	const index = body.indexOf(marker);
	if (index < 0) return null;
	return body.slice(index + marker.length).replace(/\n$/, '');
}
