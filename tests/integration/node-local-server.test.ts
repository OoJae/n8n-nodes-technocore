/**
 * The Technocore node against a disposable LOCAL technocore-chat v0.13.0 server, through the
 * real credential `authenticate` functions and n8n's real outbound HTTP client.
 * TEST seeds only; never production.
 */
import { NodeApiError, type IDataObject } from 'n8n-workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Technocore } from '../../nodes/Technocore/Technocore.node';
import {
	canonicalMessage,
	identityFromSeed,
	parseSeedHex,
	signCanonical,
	verifyCanonical,
} from '../../nodes/Technocore/shared/didkey';
import { parseReadView } from '../../nodes/Technocore/shared/responses';
import { sweep } from '../../nodes/Technocore/shared/sweep';
import { KAT_ITEMS, TEST_SEEDS, cp } from '../fixtures/corpus.mjs';
import { startTechnocore } from '../harness/local-server.mjs';
import { hasCheckout } from '../harness/python.mjs';
import { makeExecuteFunctions, type CredentialData } from '../helpers/n8n-stubs';
import { realRouter, type WireLog } from '../helpers/real-router';

if (!hasCheckout())
	throw new Error('integration tests need a technocore-chat checkout (TECHNOCORE_CHECKOUT) and uv');

const node = new Technocore();
const identity = identityFromSeed(parseSeedHex(TEST_SEEDS.seed01));
let server: { origin: string; stop: () => Promise<void> };
let credentials: CredentialData;

async function run(
	params: IDataObject,
	extra: { nodeType?: string; credentials?: CredentialData } = {},
) {
	const log: WireLog[] = [];
	const stub = makeExecuteFunctions({
		params,
		router: realRouter(log),
		credentials: extra.credentials ?? credentials,
		nodeType: extra.nodeType,
	});
	const output = await node.execute.call(stub.fns);
	return { items: output[0].map((item) => item.json), log };
}

async function readRoom(room: string, query = 'limit=200') {
	const response = await fetch(`${server.origin}/r/${room}?${query}&format=json`);
	expect(response.status).toBe(200);
	return parseReadView(await response.text());
}

beforeAll(async () => {
	server = await startTechnocore();
	credentials = {
		technocoreApi: { origin: server.origin, defaultNick: 'n8n-it' },
		technocoreSigningKeyApi: {
			origin: server.origin,
			privateKeySeed: TEST_SEEDS.seed01,
			allowAiToolSigning: false,
		},
	};
});

afterAll(async () => {
	await server?.stop();
});

describe('Post Signed against the local server', () => {
	it('is accepted (200) and the stored record verifies against the did', async () => {
		const { items, log } = await run({
			resource: 'room',
			operation: 'postSigned',
			room: 'n8n-it-signed',
			signedText: 'hello from the n8n integration test',
		});
		expect(log).toHaveLength(1);
		expect(log[0]).toMatchObject({ method: 'POST', status: 200 });
		expect(items[0]).toMatchObject({
			type: 'posted',
			from: identity.did,
			signed: true,
			text: 'hello from the n8n integration test',
		});

		const view = await readRoom('n8n-it-signed');
		const stored = view.messages.find((m) => m.seq === items[0].seq);
		expect(stored?.from).toBe(identity.did);
		expect(
			verifyCanonical(
				identity.did,
				stored?.sig as string,
				canonicalMessage('n8n-it-signed', stored?.nonce as string, stored?.text as string),
			),
		).toBe(true);
	});

	it('hostile Unicode is swept identically on both sides (server accepts every KAT text)', async () => {
		for (const item of KAT_ITEMS) {
			const swept = sweep(item.text);
			if (!swept) continue;
			const { items, log } = await run({
				resource: 'room',
				operation: 'postSigned',
				room: 'n8n-it-unicode',
				signedText: item.text,
			});
			expect(log.at(-1)?.status, `KAT text for nonce ${item.nonce}`).toBe(200);
			expect(items[0].text).toBe(swept);
		}
		const view = await readRoom('n8n-it-unicode');
		for (const message of view.messages) {
			expect(
				verifyCanonical(
					identity.did,
					message.sig as string,
					`n8n-it-unicode|${message.nonce}|${message.text}`,
				),
			).toBe(true);
		}
	});

	it('an empty-after-sweep text is refused before any request', async () => {
		const error = await run({
			resource: 'room',
			operation: 'postSigned',
			room: 'n8n-it-signed',
			signedText: `${cp(0x200b)}${cp(0x202e)} `,
		}).catch((e: unknown) => e);
		expect((error as Error).message).toMatch(/Nothing visible is left/);
	});

	it('recovers from a higher nonce used elsewhere with the same key (retry past the reported nonce)', async () => {
		// Another client (e.g. the MCP server) signed with a far-future nonce in this room.
		const room = 'n8n-it-nonce';
		const nonce = '9000000000000000000';
		const text = 'posted by another client with a huge nonce';
		const response = await fetch(`${server.origin}/r/${room}?format=json`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				did: identity.did,
				nonce,
				text,
				sig: signCanonical(identity.privateKey, canonicalMessage(room, nonce, text)),
			}),
		});
		expect(response.status).toBe(200);

		const { items, log } = await run({
			resource: 'room',
			operation: 'postSigned',
			room,
			signedText: 'n8n catches up',
		});
		expect(log.map((l) => l.status)).toEqual([400, 200]);
		expect(items[0].nonce).toBe('9000000000000000001');
		const view = await readRoom(room);
		expect(view.messages.map((m) => m.nonce)).toEqual([
			'9000000000000000000',
			'9000000000000000001',
		]);
	});

	it('mailbox rooms accept the signed post; the unsigned post is refused locally and by the server', async () => {
		const signed = await run({
			resource: 'room',
			operation: 'postSigned',
			room: 'mb-p-n8n-it-box',
			signedText: 'signed into a mailbox',
		});
		expect(signed.log[0].status).toBe(200);
		const unsigned = await run({
			resource: 'room',
			operation: 'post',
			room: 'mb-p-n8n-it-box',
			text: 'unsigned',
			nick: 'x',
		}).catch((e: unknown) => e);
		expect((unsigned as Error).message).toMatch(/signed writes only/);
		const direct = await fetch(`${server.origin}/r/mb-p-n8n-it-box?format=json`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ from: 'x', text: 'unsigned direct' }),
		});
		expect(direct.status).toBe(403);
	});

	it('refuses signing from the AI tool variant unless allowed, without sending anything', async () => {
		const before = (await readRoom('n8n-it-tool')).messages.length;
		const denied = await run(
			{
				resource: 'room',
				operation: 'postSigned',
				room: 'n8n-it-tool',
				signedText: 'tool attempt',
			},
			{ nodeType: 'n8n-nodes-technocore.technocoreTool' },
		).catch((e: unknown) => e);
		expect((denied as Error).message).toMatch(/AI agent tool are disabled/);
		expect((await readRoom('n8n-it-tool')).messages.length).toBe(before);

		const allowed = await run(
			{
				resource: 'room',
				operation: 'postSigned',
				room: 'n8n-it-tool',
				signedText: 'tool attempt allowed',
			},
			{
				nodeType: 'n8n-nodes-technocore.technocoreTool',
				credentials: {
					...credentials,
					technocoreSigningKeyApi: {
						...credentials.technocoreSigningKeyApi,
						allowAiToolSigning: true,
					},
				},
			},
		);
		expect(allowed.log[0].status).toBe(200);
	});
});

describe('unsigned rooms and notes against the local server', () => {
	it('posts with the default nickname and reads back with a gap report', async () => {
		for (let i = 0; i < 12; i++) {
			const { items } = await run({
				resource: 'room',
				operation: 'post',
				room: 'n8n-it-plain',
				text: `plain message number ${i}`,
				nick: '',
			});
			expect(items[0]).toMatchObject({ from: 'n8n-it', signed: false, seq: i + 1 });
		}
		const { items } = await run({
			resource: 'room',
			operation: 'read',
			room: 'n8n-it-plain',
			limit: 3,
			since: 2,
			output: 'batch',
		});
		expect(items[0]).toMatchObject({
			type: 'batch',
			count: 3,
			firstSeq: 10,
			lastSeq: 12,
			gapDetected: true,
			gap: { from: 3, to: 9 },
			generation: 1,
		});
	});

	it('writes, conditionally rewrites and reads notes', async () => {
		const missing = await run({
			resource: 'note',
			operation: 'read',
			namespace: 'n8n-it',
			key: 'status',
		});
		expect(missing.items[0]).toEqual({ namespace: 'n8n-it', key: 'status', found: false });

		const created = await run({
			resource: 'note',
			operation: 'write',
			namespace: 'n8n-it',
			key: 'status',
			value: 'first value',
			condition: 'ifAbsent',
		});
		expect(created.items[0]).toMatchObject({ written: true, ns: 'n8n-it', key: 'status' });

		const conflict = await run({
			resource: 'note',
			operation: 'write',
			namespace: 'n8n-it',
			key: 'status',
			value: 'second',
			condition: 'ifAbsent',
		}).catch((e: unknown) => e);
		expect(conflict).toBeInstanceOf(NodeApiError);
		expect((conflict as NodeApiError).httpCode).toBe('409');
		expect((conflict as NodeApiError).description).toContain('first value');

		await run({
			resource: 'note',
			operation: 'write',
			namespace: 'n8n-it',
			key: 'status',
			value: `second${cp(0x0a)}line`,
			condition: 'ifMatch',
			expected: 'first value',
		});
		const read = await run({
			resource: 'note',
			operation: 'read',
			namespace: 'n8n-it',
			key: 'status',
		});
		expect(read.items[0]).toEqual({
			namespace: 'n8n-it',
			key: 'status',
			found: true,
			untrusted: true,
			value: 'second line',
		});
	});

	it('maps a server validation refusal to NodeApiError', async () => {
		const error = await run({
			resource: 'room',
			operation: 'post',
			room: 'events',
			text: 'nope',
			nick: 'x',
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(NodeApiError);
		expect((error as NodeApiError).httpCode).toBe('403');
	});
});
