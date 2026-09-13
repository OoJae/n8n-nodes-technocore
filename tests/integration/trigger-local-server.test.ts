/**
 * TechnocoreTrigger.poll() against a disposable LOCAL technocore-chat v0.13.0 server, with
 * real HTTP (including the streamed export) through n8n's outbound client.
 * TEST seeds only; never production.
 */
import { NodeApiError, sleep, type IDataObject } from 'n8n-workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Technocore } from '../../nodes/Technocore/Technocore.node';
import { TechnocoreTrigger } from '../../nodes/TechnocoreTrigger/TechnocoreTrigger.node';
import {
	identityFromSeed,
	parseSeedHex,
	verifyCanonical,
} from '../../nodes/Technocore/shared/didkey';
import { TEST_SEEDS } from '../fixtures/corpus.mjs';
import { makeRoot, mutateStore, removeRoot, startTechnocore } from '../harness/local-server.mjs';
import { hasCheckout } from '../harness/python.mjs';
import { makeExecuteFunctions, makePollFunctions, type CredentialData } from '../helpers/n8n-stubs';
import { realRouter, type WireLog } from '../helpers/real-router';

if (!hasCheckout())
	throw new Error('integration tests need a technocore-chat checkout (TECHNOCORE_CHECKOUT) and uv');

const trigger = new TechnocoreTrigger();
const action = new Technocore();
const identity = identityFromSeed(parseSeedHex(TEST_SEEDS.seed01));

interface Server {
	origin: string;
	port: number;
	stop: () => Promise<void>;
}

function credentialsFor(origin: string): CredentialData {
	return {
		technocoreApi: { origin, defaultNick: 'n8n-it' },
		technocoreSigningKeyApi: {
			origin,
			privateKeySeed: TEST_SEEDS.seed01,
			allowAiToolSigning: false,
		},
	};
}

async function post(origin: string, room: string, count: number, prefix: string) {
	for (let i = 1; i <= count; i++) {
		const response = await fetch(`${origin}/r/${room}?format=json`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ from: 'writer', text: `${prefix} number ${i}` }),
		});
		if (response.status !== 200)
			throw new Error(`post ${response.status}: ${await response.text()}`);
	}
}

function pollerFor(
	origin: string,
	params: IDataObject,
	staticData: IDataObject = {},
	options: { pollBudgetMs?: number } = {},
) {
	const allParams: IDataObject = {
		startFrom: 'now',
		maxMessagesPerPoll: 1000,
		emit: 'perMessage',
		backfillGaps: true,
		maxExportMB: 12,
		...params,
	};
	return {
		staticData,
		async poll() {
			const log: WireLog[] = [];
			const stub = makePollFunctions({
				params: allParams,
				staticData,
				router: realRouter(log),
				credentials: credentialsFor(origin),
				pollBudgetMs: options.pollBudgetMs,
			});
			const result = await trigger.poll.call(stub.fns);
			return { items: result ? result[0].map((item) => item.json) : null, log };
		},
	};
}

const describeItems = (items: IDataObject[] | null) =>
	(items ?? []).map((i) =>
		i.type === 'message'
			? (i.seq as number)
			: i.type === 'gap'
				? `gap:${i.from}-${i.to}:${i.reason}`
				: (i.type as string),
	);
const seqs = (items: IDataObject[] | null) =>
	(items ?? []).filter((i) => i.type === 'message').map((i) => i.seq as number);
const range = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('trigger against a local server', () => {
	let server: Server;
	const burstState: IDataObject = {};

	beforeAll(async () => {
		server = await startTechnocore();
	});
	afterAll(async () => {
		await server?.stop();
	});

	it('activation stores the head; an 8-message burst is emitted once, in order', async () => {
		await post(server.origin, 'n8n-trig-burst', 3, 'before activation');
		const poller = pollerFor(server.origin, { room: 'n8n-trig-burst' }, burstState);
		expect((await poller.poll()).items).toBeNull();
		expect(poller.staticData.technocore).toMatchObject({ cursor: 3, generation: 1 });

		await post(server.origin, 'n8n-trig-burst', 8, 'burst');
		const { items, log } = await poller.poll();
		expect(log.map((l) => l.url)).toEqual([
			`${server.origin}/r/n8n-trig-burst?since=3&limit=200&format=json`,
		]);
		expect(seqs(items)).toEqual(range(4, 11));
		expect(items?.[0]).toMatchObject({
			untrusted: true,
			signed: false,
			from: 'writer',
			text: 'burst number 1',
		});
		expect((await poller.poll()).items).toBeNull();
	});

	it('a 450-message backlog is backfilled from the streamed export with no loss', async () => {
		const poller = pollerFor(server.origin, { room: 'n8n-trig-backlog' });
		await poller.poll();
		await post(server.origin, 'n8n-trig-backlog', 450, 'backlog');
		const { items, log } = await poller.poll();
		expect(log.map((l) => l.url.replace(server.origin, ''))).toEqual([
			'/r/n8n-trig-backlog?since=0&limit=200&format=json',
			'/r/n8n-trig-backlog/export',
		]);
		expect(seqs(items)).toEqual(range(1, 450));
		expect(items?.some((i) => i.type === 'gap')).toBe(false);
		expect(poller.staticData.technocore).toMatchObject({ cursor: 450 });
	});

	it('a signed post made by the Technocore node arrives with signed=true and a verifiable signature', async () => {
		const poller = pollerFor(server.origin, { room: 'n8n-trig-signed' });
		await poller.poll();
		const stub = makeExecuteFunctions({
			params: {
				resource: 'room',
				operation: 'postSigned',
				room: 'n8n-trig-signed',
				signedText: 'signed for the trigger',
			},
			router: realRouter(),
			credentials: credentialsFor(server.origin),
		});
		await action.execute.call(stub.fns);
		const { items } = await poller.poll();
		expect(items).toHaveLength(1);
		expect(items?.[0]).toMatchObject({
			type: 'message',
			signed: true,
			from: identity.did,
			text: 'signed for the trigger',
		});
		expect(
			verifyCanonical(
				identity.did,
				items?.[0].sig as string,
				`n8n-trig-signed|${items?.[0].nonce}|signed for the trigger`,
			),
		).toBe(true);
	});

	it('an export cut short by the poll time budget is resumed on the next poll with no gap', async () => {
		const room = 'n8n-trig-slow';
		const poller = pollerFor(server.origin, { room });
		await poller.poll();
		// ~1.8 MiB: the server streams the export in 64 KiB blocks.
		for (let i = 1; i <= 450; i++) {
			const response = await fetch(`${server.origin}/r/${room}?format=json`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ from: 'writer', text: `${i} ${'x'.repeat(4000)}` }),
			});
			expect(response.status).toBe(200);
		}
		const hurried = pollerFor(server.origin, { room }, poller.staticData, { pollBudgetMs: 2 });
		const first = await hurried.poll();
		expect(first.log.map((l) => l.url.replace(server.origin, ''))).toEqual([
			`/r/${room}?since=0&limit=200&format=json`,
			`/r/${room}/export`,
		]);
		const cursor = (poller.staticData.technocore as IDataObject).cursor as number;
		expect(describeItems(first.items).filter((d) => typeof d === 'string')).toEqual([]);
		expect(seqs(first.items)).toEqual(cursor ? range(1, cursor) : []);
		expect(cursor).toBeLessThan(250);

		const second = await poller.poll();
		expect(describeItems(second.items).filter((d) => typeof d === 'string')).toEqual([]);
		expect([...seqs(first.items), ...seqs(second.items)]).toEqual(range(1, 450));
	});

	it('a quiet poll reads only the newest message', async () => {
		const room = 'n8n-trig-quiet';
		const poller = pollerFor(server.origin, { room });
		await poller.poll();
		await post(server.origin, room, 2, 'quiet');
		expect(seqs((await poller.poll()).items)).toEqual([1, 2]);
		expect((await poller.poll()).items).toBeNull();
		const quiet = await poller.poll();
		expect(quiet.items).toBeNull();
		expect(quiet.log.map((l) => l.url.replace(server.origin, ''))).toEqual([
			`/r/${room}?limit=1&format=json`,
		]);
		await post(server.origin, room, 1, 'after quiet');
		const busy = await poller.poll();
		expect(seqs(busy.items)).toEqual([3]);
		expect(busy.log).toHaveLength(2);
	});

	it('manual mode shows the newest messages without moving the cursor', async () => {
		const before = structuredClone(burstState);
		expect(before.technocore).toMatchObject({ cursor: 11 });
		await post(server.origin, 'n8n-trig-burst', 1, 'after burst');
		const manualLog: WireLog[] = [];
		const stub = makePollFunctions({
			params: { room: 'n8n-trig-burst', maxMessagesPerPoll: 2, emit: 'perMessage' },
			staticData: burstState,
			mode: 'manual',
			router: realRouter(manualLog),
			credentials: credentialsFor(server.origin),
		});
		const result = await trigger.poll.call(stub.fns);
		expect(result?.[0].map((i) => i.json.seq)).toEqual([11, 12]);
		expect(manualLog.map((l) => l.url.replace(server.origin, ''))).toEqual([
			'/r/n8n-trig-burst?limit=2&format=json',
		]);
		expect(burstState).toEqual(before);
		const after = await pollerFor(server.origin, { room: 'n8n-trig-burst' }, burstState).poll();
		expect(seqs(after.items)).toEqual([12]);
	});
});

describe('trigger across room recreation (server stopped, store mutated, restarted on the same origin)', () => {
	const root = makeRoot();
	let server: Server;

	afterAll(async () => {
		await server?.stop();
		removeRoot(root);
	});

	it('reaped with the seq floor kept: recreated + recreated gap, then the new generation', async () => {
		server = await startTechnocore({ root });
		const poller = pollerFor(server.origin, { room: 'n8n-reaped' });
		await poller.poll();
		await post(server.origin, 'n8n-reaped', 10, 'gen one');
		expect(seqs((await poller.poll()).items)).toEqual(range(1, 10));
		await post(server.origin, 'n8n-reaped', 5, 'unseen before reap');

		const port = server.port;
		await server.stop();
		mutateStore(
			root,
			'n8n-reaped',
			'store._set_seq_entry(root, room, store.last_seq(root, room)); store.room_path(root, room).unlink()',
		);
		server = await startTechnocore({ root, port });
		await post(server.origin, 'n8n-reaped', 3, 'gen two');

		const { items } = await poller.poll();
		expect(items?.[0]).toMatchObject({
			type: 'recreated',
			fromGeneration: 1,
			toGeneration: 2,
			previousCursor: 10,
		});
		expect(items?.[1]).toMatchObject({ type: 'gap', from: 11, to: 15, reason: 'recreated' });
		expect(seqs(items)).toEqual([16, 17, 18]);
		expect(poller.staticData.technocore).toMatchObject({ cursor: 18, generation: 2 });
	});

	it('file and floor lost: recreated + reset, and the restarted sequence is delivered from 1', async () => {
		const poller = pollerFor(server.origin, { room: 'n8n-lost' });
		await poller.poll();
		await post(server.origin, 'n8n-lost', 20, 'old');
		expect(seqs((await poller.poll()).items)).toEqual(range(1, 20));

		const port = server.port;
		await server.stop();
		mutateStore(root, 'n8n-lost', 'store.room_path(root, room).unlink()');
		server = await startTechnocore({ root, port });
		await post(server.origin, 'n8n-lost', 4, 'new');

		const { items } = await poller.poll();
		expect(items?.map((i) => i.type)).toEqual([
			'recreated',
			'reset',
			'message',
			'message',
			'message',
			'message',
		]);
		expect(items?.[1]).toMatchObject({ previousCursor: 20, firstSeq: 1 });
		expect(seqs(items)).toEqual([1, 2, 3, 4]);
	});
});

describe('trigger activation on rooms with nothing visible', () => {
	const root = makeRoot();
	let server: Server;

	afterAll(async () => {
		await server?.stop();
		removeRoot(root);
	});

	it('Start From = now on an ephemeral room whose messages expired: no false gap', async () => {
		server = await startTechnocore({ root, env: { CHAT_EPHEMERAL_TTL_SECONDS: '2' } });
		const room = 'e-n8n-spec';
		await post(server.origin, room, 10, 'will expire');
		await sleep(3200);
		const poller = pollerFor(server.origin, { room });
		expect((await poller.poll()).items).toBeNull();
		expect(poller.staticData.technocore).toMatchObject({
			cursor: 0,
			generation: 1,
			baseline: true,
		});
		await post(server.origin, room, 2, 'after activation');
		const { items } = await poller.poll();
		expect(describeItems(items)).toEqual([11, 12]);
		expect(poller.staticData.technocore).toMatchObject({ cursor: 12, generation: 1 });
		expect(poller.staticData.technocore).not.toHaveProperty('baseline');
	});

	it('Start From = now on a reaped room (seq floor kept): the recreation after activation reports nothing false', async () => {
		const room = 'n8n-idle-spec';
		await post(server.origin, room, 10, 'before reap');
		const port = server.port;
		await server.stop();
		mutateStore(
			root,
			room,
			'store._set_seq_entry(root, room, store.last_seq(root, room)); store.room_path(root, room).unlink()',
		);
		server = await startTechnocore({ root, port });
		const poller = pollerFor(server.origin, { room });
		expect((await poller.poll()).items).toBeNull();
		expect(poller.staticData.technocore).toMatchObject({
			cursor: 0,
			generation: 1,
			baseline: true,
		});
		await post(server.origin, room, 3, 'after activation');
		const { items } = await poller.poll();
		expect(describeItems(items)).toEqual([11, 12, 13]);
		expect(poller.staticData.technocore).toMatchObject({ cursor: 13, generation: 2 });
	});

	it('Start From = retained with backfill off reports retained history beyond the read as not-backfilled', async () => {
		const room = 'n8n-retained-nobf';
		await post(server.origin, room, 230, 'retained');
		const poller = pollerFor(server.origin, { room, startFrom: 'retained', backfillGaps: false });
		const { items, log } = await poller.poll();
		expect(log.some((l) => l.url.endsWith('/export'))).toBe(false);
		expect(describeItems(items)).toEqual(['gap:1-30:not-backfilled', ...range(31, 230)]);
	});
});

describe('trigger when the origin restarts its sequence under the same generation', () => {
	let server: Server;

	afterAll(async () => {
		await server?.stop();
	});

	it('a fresh store on the same origin (generation 1 again, seq below the cursor) is a reset on the next quiet poll', async () => {
		server = await startTechnocore();
		const room = 'n8n-regress';
		const poller = pollerFor(server.origin, { room });
		await poller.poll();
		await post(server.origin, room, 10, 'old store');
		expect(seqs((await poller.poll()).items)).toEqual(range(1, 10));
		expect((await poller.poll()).items).toBeNull();
		expect(poller.staticData.technocore).toMatchObject({ cursor: 10, generation: 1, idle: true });

		const port = server.port;
		await server.stop(); // its temporary root is removed
		server = await startTechnocore({ port });
		await post(server.origin, room, 3, 'new store');
		const { items } = await poller.poll();
		expect(describeItems(items)).toEqual(['reset', 1, 2, 3]);
		expect(items?.[0]).toMatchObject({ previousCursor: 10, firstSeq: 1, generation: 1 });
		await post(server.origin, room, 5, 'new store more');
		expect(seqs((await poller.poll()).items)).toEqual(range(4, 8));
	});
});

describe('trigger under a real 429', () => {
	let server: Server;

	beforeAll(async () => {
		server = await startTechnocore({ env: { CHAT_RATE_READ: '3' } });
	});
	afterAll(async () => {
		await server?.stop();
	});

	it('throws NodeApiError with the server retry hint and keeps the cursor', async () => {
		await fetch(`${server.origin}/healthz`);
		const poller = pollerFor(server.origin, { room: 'n8n-limited' });
		await poller.poll(); // read 1: activation
		await post(server.origin, 'n8n-limited', 2, 'limited');
		const before = structuredClone(poller.staticData);
		let error: unknown;
		for (let i = 0; i < 4 && !error; i++) {
			try {
				const { items } = await poller.poll();
				if (items) expect(seqs(items)).toEqual([1, 2]);
				// A successful poll may update the state; only the refused one must not.
				Object.assign(before, structuredClone(poller.staticData));
			} catch (caught) {
				error = caught;
			}
		}
		expect(error).toBeInstanceOf(NodeApiError);
		expect((error as NodeApiError).httpCode).toBe('429');
		expect((error as NodeApiError).message).toContain(
			'429 rate limited: the read budget for your IP (3/min)',
		);
		expect((error as NodeApiError).description).toMatch(/Retry after \d+s/);
		expect(poller.staticData).toEqual(before);
	});
});
