/**
 * The signing half of the TechnocoreSigningKeyApi credential.
 *
 * n8n decrypts a credential and hands it to the credential type's `authenticate` function
 * together with the outgoing request. Signing happens *there*, so the seed never reaches
 * node code, item JSON, expressions or logs. To keep that function from becoming a
 * general-purpose signing oracle it signs exactly one request shape and refuses the rest:
 *
 *   POST {origin}/r/<room>?format=json   body {text, context[, nonceAfter]}
 *     -> body {did, sig, nonce: "<digits>", text: <swept text>}
 *
 * plus a pass-through for the credential test (GET {origin}/.well-known/agent.json).
 */
import type { IHttpRequestOptions } from 'n8n-workflow';

import { canonicalMessage, identityFromSeed, parseSeedHex, signCanonical } from './didkey';
import { normalizeOrigin, resolveOnOrigin } from './origin';
import { EVENTS_ROOM, isValidName } from './names';
import { MAX_TEXT_CHARS, codePointLength, sweep } from './sweep';

export const SIGNING_TEST_PATH = '/.well-known/agent.json';
export type SigningContext = 'workflow' | 'aiTool';

export class SigningRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SigningRefusedError';
	}
}

const MAX_NONCE = BigInt('9999999999999999999');
/**
 * How far past the millisecond clock a server-reported last nonce may move a counter: one
 * day, room for clock skew and bursts. Anything further is not a millisecond nonce.
 */
export const MAX_REPORTED_NONCE_AHEAD_MS = 24 * 60 * 60 * 1000;
/** Counters kept at once; see rememberNonce. */
const MAX_COUNTERS = 10_000;
/**
 * The last nonce issued per `origin|did|room`. The server checks nonces per key per room,
 * so that is the scope of a counter: a report from one room (or origin, or key) never
 * raises the nonces used anywhere else.
 */
const lastNonces = new Map<string, bigint>();

export function nonceScope(origin: string, did: string, room: string): string {
	return `${origin}|${did}|${room}`;
}

function rememberNonce(scope: string, nonce: bigint, clock: bigint): void {
	lastNonces.delete(scope);
	lastNonces.set(scope, nonce);
	if (lastNonces.size <= MAX_COUNTERS) return;
	// Prune to 90% so this pass is rare. First the counters the clock has passed (the clock
	// alone now gives a higher nonce), then, oldest first, those it has reached, and only
	// then anything else. Forgetting a counter costs at most one stale-nonce retry.
	const target = Math.floor(MAX_COUNTERS * 0.9);
	const passes: Array<(value: bigint) => boolean> = [
		(value) => value < clock,
		(value) => value <= clock,
		() => true,
	];
	for (const evictable of passes) {
		for (const [key, value] of lastNonces) {
			if (lastNonces.size <= target) return;
			if (key !== scope && evictable(value)) lastNonces.delete(key);
		}
	}
}

/**
 * A millisecond clock bumped past the last nonce issued in this scope (the MCP server's
 * discipline, so one key can be used from both), and past `after` when the server reported
 * a higher last nonce for this key in this room. A reported nonce more than a day ahead of
 * the clock is refused rather than followed: adopting a nanosecond or custom counter would
 * lock millisecond-clock clients using the same key out of that room, and a misbehaving
 * origin could push the counter to the 19-digit limit.
 */
export function nextNonce(scope: string, nowMs: number, after?: string): string {
	const clock = BigInt(Math.max(0, Math.floor(nowMs)));
	let candidate = clock;
	const last = lastNonces.get(scope);
	if (last !== undefined && last + BigInt(1) > candidate) candidate = last + BigInt(1);
	if (after !== undefined) {
		if (!/^[0-9]{1,19}$/.test(after))
			throw new SigningRefusedError('nonceAfter must be 1-19 digits');
		const past = BigInt(after) + BigInt(1);
		if (past > clock + BigInt(MAX_REPORTED_NONCE_AHEAD_MS)) {
			throw new SigningRefusedError(
				`The server reports that this key last used nonce ${after} in this room, more than a day ahead of the millisecond clock. That is not a millisecond nonce (another client with this key may use a nanosecond or custom counter, or the origin misbehaves), so the credential will not follow it: doing so would lock millisecond-clock clients with this key, such as the Technocore MCP server, out of the room. Use another room or key, or wait until those records leave the room.`,
			);
		}
		if (past > candidate) candidate = past;
	}
	if (candidate > MAX_NONCE) {
		throw new SigningRefusedError('No nonce left: the next nonce would exceed 19 digits');
	}
	rememberNonce(scope, candidate, clock);
	return candidate.toString();
}

/** Test hook: forget every nonce counter. */
export function resetNonceClockForTests(): void {
	lastNonces.clear();
}

/** Test hook: how many nonce counters are kept. */
export function nonceCounterCountForTests(): number {
	return lastNonces.size;
}

export interface SigningCredentialData {
	origin?: unknown;
	privateKeySeed?: unknown;
	allowAiToolSigning?: unknown;
}

const ALLOWED_BODY_KEYS = new Set(['text', 'context', 'nonceAfter']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === 'object' && value !== null && !Array.isArray(value) && !Buffer.isBuffer(value)
	);
}

export async function authenticateSigningRequest(
	credentials: SigningCredentialData,
	requestOptions: IHttpRequestOptions,
	now: () => number = Date.now,
): Promise<IHttpRequestOptions> {
	// Validate the key first so the credential test fails on a bad seed.
	const identity = identityFromSeed(parseSeedHex(credentials.privateKeySeed));
	const origin = normalizeOrigin(credentials.origin);
	const method = (requestOptions.method ?? 'GET').toUpperCase();
	const target = resolveOnOrigin(origin, requestOptions.url, requestOptions.baseURL);
	const qs = requestOptions.qs;
	const hasQs = isPlainObject(qs) && Object.keys(qs).length > 0;

	if (
		method === 'GET' &&
		target.pathname === SIGNING_TEST_PATH &&
		!target.search &&
		!target.hash &&
		!hasQs
	) {
		if (
			requestOptions.body !== undefined &&
			!(isPlainObject(requestOptions.body) && Object.keys(requestOptions.body).length === 0)
		) {
			throw new SigningRefusedError('The credential test request must not carry a body');
		}
		return { ...requestOptions, url: target.href, baseURL: undefined };
	}

	const match = /^\/r\/([^/]+)$/.exec(target.pathname);
	if (method !== 'POST' || !match || target.search !== '?format=json' || target.hash || hasQs) {
		throw new SigningRefusedError(
			'The Technocore signing credential only signs room posts (POST /r/<room>?format=json) made by the Technocore node',
		);
	}
	const room = match[1];
	if (!isValidName(room) || room === EVENTS_ROOM) {
		throw new SigningRefusedError('The room name is not a valid, writable Technocore room');
	}
	const body = requestOptions.body;
	if (!isPlainObject(body) || Object.keys(body).some((key) => !ALLOWED_BODY_KEYS.has(key))) {
		throw new SigningRefusedError(
			'The signing credential only accepts a body of {text, context}; it never re-signs a signed body',
		);
	}
	const { text, context, nonceAfter } = body;
	if (typeof text !== 'string') throw new SigningRefusedError('The text to sign must be a string');
	if (context !== 'workflow' && context !== 'aiTool') {
		throw new SigningRefusedError(
			'The signing request does not say whether it comes from a workflow or an AI tool',
		);
	}
	if (context === 'aiTool' && credentials.allowAiToolSigning !== true) {
		throw new SigningRefusedError(
			'Signed posts from an AI agent tool are disabled for this credential. Enable "Allow AI Tool Signing" on the credential only if you accept that a model can sign messages as this identity.',
		);
	}
	if (nonceAfter !== undefined && typeof nonceAfter !== 'string') {
		throw new SigningRefusedError('nonceAfter must be a decimal string');
	}
	const swept = sweep(text);
	if (!swept) {
		throw new SigningRefusedError(
			'Nothing visible is left after the single-line sweep (control, format and line-separator characters become spaces, then the ends are trimmed), so the server would refuse this message',
		);
	}
	const length = codePointLength(swept);
	if (length > MAX_TEXT_CHARS) {
		throw new SigningRefusedError(
			`The message is ${length} characters after the sweep; the limit is ${MAX_TEXT_CHARS}. Split it.`,
		);
	}
	const nonce = nextNonce(nonceScope(origin, identity.did, room), now(), nonceAfter);
	const sig = signCanonical(identity.privateKey, canonicalMessage(room, nonce, swept));
	const headers = { ...(requestOptions.headers ?? {}), 'Content-Type': 'application/json' };
	return {
		...requestOptions,
		method: 'POST',
		url: `${origin}/r/${room}?format=json`,
		baseURL: undefined,
		qs: undefined,
		headers,
		body: { did: identity.did, sig, nonce, text: swept },
		disableFollowRedirect: true,
	};
}
