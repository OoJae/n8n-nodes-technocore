import type { IHttpRequestOptions } from 'n8n-workflow';
import { beforeEach, describe, expect, it } from 'vitest';

import { TechnocoreApi } from '../../credentials/TechnocoreApi.credentials';
import { TechnocoreSigningKeyApi } from '../../credentials/TechnocoreSigningKeyApi.credentials';
import {
	identityFromSeed,
	parseSeedHex,
	verifyCanonical,
} from '../../nodes/Technocore/shared/didkey';
import {
	authenticateSigningRequest,
	nextNonce,
	resetNonceClockForTests,
} from '../../nodes/Technocore/shared/signing';
import { TEST_SEEDS, cp } from '../fixtures/corpus.mjs';

const ORIGIN = 'https://technocore.test';
const creds = { origin: ORIGIN, privateKeySeed: TEST_SEEDS.seed01, allowAiToolSigning: false };
const identity = identityFromSeed(parseSeedHex(TEST_SEEDS.seed01));
const NOW = 1726221600000;

function post(body: unknown, extra: Partial<IHttpRequestOptions> = {}): IHttpRequestOptions {
	return {
		method: 'POST',
		url: '/r/lobby?format=json',
		body: body as IHttpRequestOptions['body'],
		...extra,
	};
}

async function refusal(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return (error as Error).message;
	}
	return 'NOT REFUSED';
}

beforeEach(() => resetNonceClockForTests());

describe('TechnocoreSigningKeyApi credential', () => {
	const credential = new TechnocoreSigningKeyApi();

	it('is restricted to the Technocore node and masks the seed', () => {
		expect(credential.restrictToSupportedNodes).toBe(true);
		expect(credential.supportedNodes).toEqual(['technocore']);
		const seed = credential.properties.find((p) => p.name === 'privateKeySeed');
		expect(seed?.typeOptions?.password).toBe(true);
		const allow = credential.properties.find((p) => p.name === 'allowAiToolSigning');
		expect(allow?.default).toBe(false);
		expect(typeof credential.authenticate).toBe('function');
		expect(credential.test.request.url).toBe('/.well-known/agent.json');
	});

	it('signs a room post inside authenticate and returns only public data', async () => {
		const sent = await credential.authenticate(
			{ ...creds },
			post({ text: `  hello ${cp(0x200d)}world  `, context: 'workflow' }),
		);
		expect(sent.url).toBe(`${ORIGIN}/r/lobby?format=json`);
		expect(sent.method).toBe('POST');
		expect(sent.disableFollowRedirect).toBe(true);
		const body = sent.body as Record<string, string>;
		expect(Object.keys(body).sort()).toEqual(['did', 'nonce', 'sig', 'text']);
		expect(body.did).toBe(identity.did);
		expect(body.text).toBe('hello  world');
		expect(body.nonce).toMatch(/^[0-9]{13,19}$/);
		expect(typeof body.nonce).toBe('string');
		expect(verifyCanonical(body.did, body.sig, `lobby|${body.nonce}|${body.text}`)).toBe(true);
		expect(JSON.stringify(sent)).not.toContain(TEST_SEEDS.seed01);
	});

	it('passes the credential test request through untouched (after validating the key)', async () => {
		const sent = await credential.authenticate(
			{ ...creds },
			{ method: 'GET', baseURL: `${ORIGIN}/`, url: '/.well-known/agent.json' },
		);
		expect(sent.url).toBe(`${ORIGIN}/.well-known/agent.json`);
		expect(sent.body).toBeUndefined();
		const bad = await refusal(
			credential.authenticate(
				{ ...creds, privateKeySeed: 'nope' },
				{ method: 'GET', baseURL: ORIGIN, url: '/.well-known/agent.json' },
			),
		);
		expect(bad).toMatch(/64 hexadecimal characters/);
	});

	it.each<[string, IHttpRequestOptions]>([
		['a GET to another path', { method: 'GET', url: '/r/lobby?format=json' }],
		[
			'a POST to a note',
			post({ text: 'x', context: 'workflow' }, { url: '/kv/ns/key?format=json' }),
		],
		['a POST without format=json', post({ text: 'x', context: 'workflow' }, { url: '/r/lobby' })],
		[
			'extra query parameters',
			post({ text: 'x', context: 'workflow' }, { url: '/r/lobby?format=json&x=1' }),
		],
		['qs options', post({ text: 'x', context: 'workflow' }, { qs: { a: 1 } })],
		['a fragment', post({ text: 'x', context: 'workflow' }, { url: '/r/lobby?format=json#frag' })],
		[
			'another origin',
			post({ text: 'x', context: 'workflow' }, { url: 'https://evil.test/r/lobby?format=json' }),
		],
		[
			'a mismatched baseURL',
			post({ text: 'x', context: 'workflow' }, { baseURL: 'https://evil.test' }),
		],
		[
			'a protocol-relative URL',
			post({ text: 'x', context: 'workflow' }, { url: '//evil.test/r/lobby?format=json' }),
		],
		[
			'a percent-encoded room',
			post({ text: 'x', context: 'workflow' }, { url: '/r/lob%62y?format=json' }),
		],
		[
			'a path traversal',
			post({ text: 'x', context: 'workflow' }, { url: '/r/../kv/a?format=json' }),
		],
		['an invalid room', post({ text: 'x', context: 'workflow' }, { url: '/r/Lobby?format=json' })],
		['the events room', post({ text: 'x', context: 'workflow' }, { url: '/r/events?format=json' })],
		[
			'an already signed body',
			post({ text: 'x', context: 'workflow', did: 'd', sig: 's', nonce: '1' }),
		],
		['a canonical string instead of text', post({ canonical: 'lobby|1|x', context: 'workflow' })],
		['a string body', post('{"text":"x"}')],
		['a missing context', post({ text: 'x' })],
		['a non-string text', post({ text: 5, context: 'workflow' })],
		['an empty-after-sweep text', post({ text: `${cp(0x200b)}${cp(0x0a)} `, context: 'workflow' })],
		['a too-long text', post({ text: 'a'.repeat(4097), context: 'workflow' })],
		['a malformed nonceAfter', post({ text: 'x', context: 'workflow', nonceAfter: '12a' })],
	])('refuses %s', async (_label, request) => {
		const message = await refusal(authenticateSigningRequest({ ...creds }, request, () => NOW));
		expect(message).not.toBe('NOT REFUSED');
		expect(message).not.toContain(TEST_SEEDS.seed01);
	});

	it('refuses AI tool context unless the credential allows it', async () => {
		const denied = await refusal(
			authenticateSigningRequest({ ...creds }, post({ text: 'x', context: 'aiTool' }), () => NOW),
		);
		expect(denied).toMatch(/AI agent tool are disabled/);
		const allowed = await authenticateSigningRequest(
			{ ...creds, allowAiToolSigning: true },
			post({ text: 'x', context: 'aiTool' }),
			() => NOW,
		);
		expect((allowed.body as Record<string, string>).did).toBe(identity.did);
	});

	it('refuses a plain-http origin that is not loopback, accepts localhost', async () => {
		const insecure = await refusal(
			authenticateSigningRequest(
				{ ...creds, origin: 'http://technocore.test' },
				post({ text: 'x', context: 'workflow' }),
				() => NOW,
			),
		);
		expect(insecure).toMatch(/https/);
		const local = await authenticateSigningRequest(
			{ ...creds, origin: 'http://127.0.0.1:34567' },
			post({ text: 'x', context: 'workflow' }),
			() => NOW,
		);
		expect(local.url).toBe('http://127.0.0.1:34567/r/lobby?format=json');
	});

	it('counts 4096 characters as code points (astral characters are one)', async () => {
		const sent = await authenticateSigningRequest(
			{ ...creds },
			post({ text: cp(0x1f600).repeat(4096), context: 'workflow' }),
			() => NOW,
		);
		expect((sent.body as Record<string, string>).text.length).toBe(8192);
	});
});

describe('nonce clock', () => {
	it('is a millisecond clock that strictly increases within the process', () => {
		expect(nextNonce(NOW)).toBe(String(NOW));
		expect(nextNonce(NOW)).toBe(String(NOW + 1));
		expect(nextNonce(NOW - 5000)).toBe(String(NOW + 2));
		expect(nextNonce(NOW + 100)).toBe(String(NOW + 100));
	});

	it('jumps past a higher nonce the server reported, staying within 19 digits', () => {
		expect(nextNonce(NOW, '9000000000000000000')).toBe('9000000000000000001');
		expect(nextNonce(NOW)).toBe('9000000000000000002');
		expect(() => nextNonce(NOW, '9999999999999999999')).toThrow(/19 digits/);
	});
});

describe('TechnocoreApi credential', () => {
	const credential = new TechnocoreApi();

	it('holds no secret and pins requests to the configured origin', async () => {
		expect(credential.properties.some((p) => p.typeOptions?.password)).toBe(false);
		const sent = await credential.authenticate(
			{ origin: `${ORIGIN}/` },
			{ method: 'GET', url: '/r/lobby?limit=1&format=json' },
		);
		expect(sent.url).toBe(`${ORIGIN}/r/lobby?limit=1&format=json`);
		await expect(
			credential.authenticate(
				{ origin: ORIGIN },
				{ method: 'GET', url: 'https://elsewhere.test/r/x' },
			),
		).rejects.toThrow(/not on the credential origin/);
		await expect(
			credential.authenticate(
				{ origin: 'https://technocore.test/path' },
				{ method: 'GET', url: '/x' },
			),
		).rejects.toThrow(/scheme and host only/);
		await expect(
			credential.authenticate(
				{ origin: 'https://user:pw@technocore.test' },
				{ method: 'GET', url: '/x' },
			),
		).rejects.toThrow(/user name or password/);
	});
});
