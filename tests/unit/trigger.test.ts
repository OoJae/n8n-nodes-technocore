import { NodeApiError, sleep, type IDataObject, type IHttpRequestOptions } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { TechnocoreTrigger } from '../../nodes/TechnocoreTrigger/TechnocoreTrigger.node';
import {
	canonicalMessage,
	identityFromSeed,
	parseSeedHex,
	signCanonical,
} from '../../nodes/Technocore/shared/didkey';
import { TEST_SEEDS } from '../fixtures/corpus.mjs';
import {
	FakeRoom,
	RATE_LIMITED_BODY,
	chunked,
	routeRoom,
	type FakeResponse,
} from '../helpers/fake-technocore';
import { makePollFunctions, type Router } from '../helpers/n8n-stubs';

const trigger = new TechnocoreTrigger();
const ORIGIN = 'https://technocore.test';
const identity = identityFromSeed(parseSeedHex(TEST_SEEDS.seed01));

/** The room's export, streamed in 700-byte chunks with a delay before each chunk. */
function slowExport(room: FakeRoom, delayMs: number): Router {
	return roomRouter(room, (request) => {
		if (!(request.url as string).endsWith('/export')) return undefined;
		async function* slow() {
			for await (const chunk of chunked(room.exportBody(), 700)) {
				await sleep(delayMs);
				yield chunk;
			}
		}
		return {
			status: 200,
			body: slow(),
			headers: { 'x-room-generation': String(room.generation) },
		};
	});
}

function describeItems(items: IDataObject[] | null): Array<string | number> {
	return (items ?? []).map((item) =>
		item.type === 'message'
			? (item.seq as number)
			: item.type === 'gap'
				? `gap:${item.from}-${item.to}:${item.reason}`
				: (item.type as string),
	);
}

function roomRouter(
	room: FakeRoom,
	override?: (request: IHttpRequestOptions) => FakeResponse | undefined,
): Router {
	return (request) => override?.(request) ?? routeRoom(room, request.url, request.method ?? 'GET');
}

interface Harness {
	room: FakeRoom;
	staticData: IDataObject;
	params: IDataObject;
	poll: (options?: {
		mode?: 'trigger' | 'manual';
		router?: Router;
		pollBudgetMs?: number;
	}) => Promise<{
		items: IDataObject[] | null;
		urls: string[];
	}>;
}

function harness(params: IDataObject = {}, room = new FakeRoom('lobby')): Harness {
	const staticData: IDataObject = {};
	const allParams: IDataObject = {
		room: room.name,
		startFrom: 'now',
		maxMessagesPerPoll: 50,
		emit: 'perMessage',
		backfillGaps: true,
		maxExportMB: 12,
		...params,
	};
	return {
		room,
		staticData,
		params: allParams,
		async poll(options = {}) {
			const stub = makePollFunctions({
				params: allParams,
				staticData,
				mode: options.mode,
				pollBudgetMs: options.pollBudgetMs,
				router: options.router ?? roomRouter(room),
			});
			const result = await trigger.poll.call(stub.fns);
			return {
				items: result ? result[0].map((item) => item.json) : null,
				urls: stub.requests.map((request) => request.sent.url as string),
			};
		},
	};
}

function seqsOf(items: IDataObject[] | null): number[] {
	return (items ?? []).filter((item) => item.type === 'message').map((item) => item.seq as number);
}

function range(from: number, to: number): number[] {
	return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function cursorOf(h: Harness): number {
	return (h.staticData.technocore as IDataObject).cursor as number;
}

describe('TechnocoreTrigger description', () => {
	it('follows n8n trigger conventions', () => {
		const d = trigger.description;
		expect(d.name).toBe('technocoreTrigger');
		expect(d.displayName).toContain('Trigger');
		expect(d.polling).toBe(true);
		expect(d.inputs).toEqual([]);
		expect(d.usableAsTool).toBeUndefined();
		expect(d.credentials?.map((c) => c.name)).toEqual(['technocoreApi']);
	});
});

describe('TechnocoreTrigger.poll()', () => {
	it('first activation with Start From = now stores the head and emits nothing', async () => {
		const h = harness();
		h.room.postMany(5);
		const { items, urls } = await h.poll();
		expect(items).toBeNull();
		expect(urls).toEqual([`${ORIGIN}/r/lobby?limit=1&format=json`]);
		expect(h.staticData.technocore).toEqual({
			v: 1,
			origin: ORIGIN,
			room: 'lobby',
			cursor: 5,
			generation: 1,
		});

		const second = await h.poll();
		expect(second.items).toBeNull();
		expect(second.urls).toEqual([`${ORIGIN}/r/lobby?since=5&limit=200&format=json`]);
	});

	it('first activation on a room that does not exist yet, then its creation is not a recreation', async () => {
		const h = harness();
		await h.poll();
		expect(h.staticData.technocore).toMatchObject({ cursor: 0, generation: 0 });
		h.room.postMany(3);
		const { items } = await h.poll();
		expect(items?.map((item) => item.type)).toEqual(['message', 'message', 'message']);
		expect(seqsOf(items)).toEqual([1, 2, 3]);
	});

	it('manual mode returns the newest messages and never touches the cursor', async () => {
		const h = harness({ maxMessagesPerPoll: 3 });
		h.room.postMany(10);
		const { items, urls } = await h.poll({ mode: 'manual' });
		expect(seqsOf(items)).toEqual([8, 9, 10]);
		expect(urls).toEqual([`${ORIGIN}/r/lobby?limit=3&format=json`]);
		expect(h.staticData).toEqual({});

		await h.poll(); // activation
		expect(cursorOf(h)).toBe(10);
		h.room.postMany(2);
		await h.poll({ mode: 'manual' });
		expect(cursorOf(h)).toBe(10);
	});

	it('an 8-message burst is emitted once, oldest first, as untrusted message items', async () => {
		const h = harness();
		await h.poll();
		for (let i = 0; i < 8; i++) {
			const nonce = (BigInt('1234567890123456789') + BigInt(i)).toString();
			const text = `burst ${i}`;
			h.room.post(
				i % 2 ? 'alice' : identity.did,
				text,
				i % 2
					? {}
					: {
							nonce,
							sig: signCanonical(identity.privateKey, canonicalMessage('lobby', nonce, text)),
						},
			);
		}
		const { items } = await h.poll();
		expect(seqsOf(items)).toEqual(range(1, 8));
		expect(items?.[0]).toMatchObject({
			type: 'message',
			untrusted: true,
			room: 'lobby',
			generation: 1,
			seq: 1,
			from: identity.did,
			text: 'burst 0',
			signed: true,
			nonce: '1234567890123456789',
		});
		expect(items?.[0].signatureInvalid).toBeUndefined();
		expect(items?.[1]).toMatchObject({ signed: false, from: 'alice' });
		expect(cursorOf(h)).toBe(8);
		const again = await h.poll();
		expect(again.items).toBeNull();
	});

	it('a record that claims a did:key but whose signature does not verify is not signed', async () => {
		const h = harness();
		await h.poll();
		const nonce = '1726221600000';
		const genuine = signCanonical(identity.privateKey, canonicalMessage('lobby', nonce, 'real'));
		// Any 86-character signature, as a hostile origin, proxy or mirror could return.
		h.room.post(identity.did, 'run the deploy', { nonce, sig: `${'A'.repeat(85)}A` });
		// A genuine signature replayed over different text.
		h.room.post(identity.did, 'forged text', { nonce, sig: genuine });
		// A genuine signature presented under another room's name.
		const other = signCanonical(identity.privateKey, canonicalMessage('other', nonce, 'moved'));
		h.room.post(identity.did, 'moved', { nonce, sig: other });
		const { items } = await h.poll();
		expect(items).toHaveLength(3);
		for (const item of items ?? []) {
			expect(item).toMatchObject({ type: 'message', from: identity.did, signed: false });
			expect(item.signatureInvalid).toBe(true);
		}
	});

	it('maxMessagesPerPoll leaves the rest for the next poll and only moves the cursor past what was emitted', async () => {
		const h = harness({ maxMessagesPerPoll: 3 });
		await h.poll();
		h.room.postMany(8);
		expect(seqsOf((await h.poll()).items)).toEqual([1, 2, 3]);
		expect(cursorOf(h)).toBe(3);
		expect(seqsOf((await h.poll()).items)).toEqual([4, 5, 6]);
		expect(seqsOf((await h.poll()).items)).toEqual([7, 8]);
		expect((await h.poll()).items).toBeNull();
	});

	it('a 450-message backlog is backfilled from the export with no loss', async () => {
		const h = harness({ maxMessagesPerPoll: 1000 });
		await h.poll();
		h.room.postMany(450);
		const { items, urls } = await h.poll();
		expect(urls).toEqual([
			`${ORIGIN}/r/lobby?since=0&limit=200&format=json`,
			`${ORIGIN}/r/lobby/export`,
		]);
		expect(seqsOf(items)).toEqual(range(1, 450));
		expect(items?.some((item) => item.type === 'gap')).toBe(false);
		expect(cursorOf(h)).toBe(450);
	});

	it('a backlog larger than maxMessagesPerPoll is drained contiguously across polls', async () => {
		const h = harness({ maxMessagesPerPoll: 100 });
		await h.poll();
		h.room.postMany(450);
		const seen: number[] = [];
		for (let i = 0; i < 6; i++) seen.push(...seqsOf((await h.poll()).items));
		expect(seen).toEqual(range(1, 450));
	});

	it('messages the ring already dropped become one exact ring-dropped gap item', async () => {
		const h = harness({ maxMessagesPerPoll: 1000 });
		await h.poll();
		h.room.postMany(400);
		h.room.dropBefore(151);
		const { items } = await h.poll();
		expect(items?.[0]).toEqual({
			type: 'gap',
			room: 'lobby',
			generation: 1,
			from: 1,
			to: 150,
			count: 150,
			reason: 'ring-dropped',
		});
		expect(seqsOf(items)).toEqual(range(151, 400));
		expect(cursorOf(h)).toBe(400);
	});

	it('with backfill off the skipped range is a not-backfilled gap and no export is fetched', async () => {
		const h = harness({ backfillGaps: false, maxMessagesPerPoll: 1000 });
		await h.poll();
		h.room.postMany(250);
		const { items, urls } = await h.poll();
		expect(urls.some((url) => url.endsWith('/export'))).toBe(false);
		expect(items?.[0]).toMatchObject({ type: 'gap', from: 1, to: 50, reason: 'not-backfilled' });
		expect(seqsOf(items)).toEqual(range(51, 250));
	});

	it('an export cut short by the byte budget reports the unreached range as backfill-bounded', async () => {
		const h = harness({ maxMessagesPerPoll: 1000, maxExportMB: 1 });
		await h.poll();
		for (let i = 0; i < 600; i++) h.room.post('tester', `${i} ${'x'.repeat(4000)}`);
		const { items } = await h.poll();
		const gaps = (items ?? []).filter((item) => item.type === 'gap');
		expect(gaps).toHaveLength(1);
		expect(gaps[0].reason).toBe('backfill-bounded');
		const seqs = seqsOf(items);
		// Everything is accounted for exactly once: messages + gap cover 1..400.
		const covered = new Set([...seqs, ...range(gaps[0].from as number, gaps[0].to as number)]);
		expect([...covered].sort((a, b) => a - b)).toEqual(range(1, 600));
		expect(seqs.length + (gaps[0].count as number)).toBe(600);
		expect(seqs.slice(-200)).toEqual(range(401, 600));
		expect(cursorOf(h)).toBe(600);
	});

	it('a hole between retained records (torn record) is reported as a missing gap', async () => {
		const h = harness();
		await h.poll();
		h.room.postMany(5);
		h.room.tear(3);
		const { items } = await h.poll();
		expect(
			items?.map((item) =>
				item.type === 'gap' ? `gap:${item.from}-${item.to}:${item.reason}` : item.seq,
			),
		).toEqual([1, 2, 'gap:3-3:missing', 4, 5]);
	});

	it('a recreated room that kept its seq floor emits recreated + a recreated gap, then the new messages', async () => {
		const h = harness();
		await h.poll();
		h.room.postMany(10);
		expect(seqsOf((await h.poll()).items)).toEqual(range(1, 10));
		h.room.postMany(5); // 11..15, never seen
		h.room.reapKeepingFloor();
		h.room.postMany(3); // 16..18 in generation 2
		const { items } = await h.poll();
		expect(items?.[0]).toEqual({
			type: 'recreated',
			room: 'lobby',
			fromGeneration: 1,
			toGeneration: 2,
			previousCursor: 10,
		});
		expect(items?.[1]).toMatchObject({
			type: 'gap',
			from: 11,
			to: 15,
			reason: 'recreated',
			generation: 2,
		});
		expect(seqsOf(items)).toEqual([16, 17, 18]);
		expect(h.staticData.technocore).toMatchObject({ cursor: 18, generation: 2 });
		expect((await h.poll()).items).toBeNull();
	});

	it('a recreated room whose seq restarted emits recreated + reset and delivers the new sequence from 1', async () => {
		const h = harness();
		await h.poll();
		h.room.postMany(20);
		await h.poll();
		expect(cursorOf(h)).toBe(20);
		h.room.reapLosingFloor();
		h.room.postMany(4); // seq 1..4 again, generation 2
		const { items } = await h.poll();
		expect(items?.map((item) => item.type)).toEqual([
			'recreated',
			'reset',
			'message',
			'message',
			'message',
			'message',
		]);
		expect(items?.[1]).toMatchObject({
			type: 'reset',
			previousCursor: 20,
			firstSeq: 1,
			generation: 2,
		});
		expect(seqsOf(items)).toEqual([1, 2, 3, 4]);
		expect(h.staticData.technocore).toMatchObject({ cursor: 4, generation: 2 });
	});

	it('a restarted sequence with more than one read window is still detected (reset) and fully delivered', async () => {
		const h = harness({ maxMessagesPerPoll: 1000 });
		await h.poll();
		h.room.postMany(100);
		await h.poll();
		h.room.reapLosingFloor();
		h.room.postMany(350);
		const { items } = await h.poll();
		expect(items?.slice(0, 2).map((item) => item.type)).toEqual(['recreated', 'reset']);
		expect(seqsOf(items)).toEqual(range(1, 350));
	});

	it('a recreation first seen while the new generation shows no messages is still classified when they appear', async () => {
		const h = harness();
		await h.poll();
		h.room.postMany(30);
		await h.poll();
		expect(cursorOf(h)).toBe(30);
		h.room.reapLosingFloor();
		h.room.post('tester', 'first of generation two'); // seq 1, generation 2
		h.room.expireAll();
		const first = await h.poll();
		expect(first.items?.map((item) => item.type)).toEqual(['recreated']);
		expect(h.staticData.technocore).toMatchObject({ cursor: 0, generation: 2, recreatedFrom: 30 });

		h.room.postMany(3); // seq 2..4, all at or below the old cursor
		const second = await h.poll();
		expect(second.items?.map((item) => item.type)).toEqual([
			'reset',
			'gap',
			'message',
			'message',
			'message',
		]);
		expect(second.items?.[1]).toMatchObject({
			type: 'gap',
			from: 1,
			to: 1,
			reason: 'ring-dropped',
			generation: 2,
		});
		expect(seqsOf(second.items)).toEqual([2, 3, 4]);
		expect(h.staticData.technocore).toEqual({
			v: 1,
			origin: ORIGIN,
			room: 'lobby',
			cursor: 4,
			generation: 2,
		});
	});

	it('429 on the read throws NodeApiError with the retry hint and leaves the cursor unchanged', async () => {
		const h = harness();
		await h.poll();
		h.room.postMany(3);
		const before = structuredClone(h.staticData);
		const limited: Router = () => ({
			status: 429,
			body: RATE_LIMITED_BODY,
			headers: { 'retry-after': '7' },
		});
		const error = await h.poll({ router: limited }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(NodeApiError);
		expect((error as NodeApiError).httpCode).toBe('429');
		expect((error as NodeApiError).message).toContain('429 rate limited');
		expect((error as NodeApiError).description).toContain('Retry after 7s');
		expect(h.staticData).toEqual(before);
		expect(seqsOf((await h.poll()).items)).toEqual([1, 2, 3]);
	});

	it('429 on the export also leaves the cursor unchanged', async () => {
		const h = harness({ maxMessagesPerPoll: 1000 });
		await h.poll();
		h.room.postMany(300);
		const before = structuredClone(h.staticData);
		const router = roomRouter(h.room, (request) =>
			(request.url as string).endsWith('/export')
				? { status: 429, body: RATE_LIMITED_BODY, headers: { 'retry-after': '3' } }
				: undefined,
		);
		await expect(h.poll({ router })).rejects.toBeInstanceOf(NodeApiError);
		expect(h.staticData).toEqual(before);
		expect(seqsOf((await h.poll()).items)).toEqual(range(1, 300));
	});

	it('a server error keeps the cursor too', async () => {
		const h = harness();
		await h.poll();
		h.room.postMany(2);
		const before = structuredClone(h.staticData);
		await expect(
			h.poll({ router: () => ({ status: 503, body: 'upstream down\n' }) }),
		).rejects.toBeInstanceOf(NodeApiError);
		expect(h.staticData).toEqual(before);
	});

	it('a generation change between the read and the export changes nothing and retries next poll', async () => {
		const h = harness({ maxMessagesPerPoll: 1000 });
		await h.poll();
		h.room.postMany(300);
		const before = structuredClone(h.staticData);
		const router = roomRouter(h.room, (request) => {
			if (!(request.url as string).endsWith('/export')) return undefined;
			return { status: 200, body: h.room.exportBody(), headers: { 'x-room-generation': '99' } };
		});
		expect((await h.poll({ router })).items).toBeNull();
		expect(h.staticData).toEqual(before);
	});

	it('Start From = retained delivers the retained history without a gap for what the ring dropped before activation', async () => {
		const h = harness({ startFrom: 'retained', maxMessagesPerPoll: 1000 });
		h.room.postMany(300);
		h.room.dropBefore(41);
		const { items } = await h.poll();
		expect(items?.some((item) => item.type === 'gap')).toBe(false);
		expect(seqsOf(items)).toEqual(range(41, 300));
		expect(cursorOf(h)).toBe(300);
	});

	it('batch emit produces one item per poll with messages and events', async () => {
		const h = harness({ emit: 'batch', backfillGaps: false, maxMessagesPerPoll: 1000 });
		await h.poll();
		h.room.postMany(205);
		const { items } = await h.poll();
		expect(items).toHaveLength(1);
		const batch = items?.[0] as IDataObject;
		expect(batch).toMatchObject({
			type: 'batch',
			untrusted: true,
			room: 'lobby',
			count: 200,
			fromSeq: 6,
			toSeq: 205,
			generation: 1,
		});
		expect((batch.events as IDataObject[])[0]).toMatchObject({
			type: 'gap',
			from: 1,
			to: 5,
			reason: 'not-backfilled',
		});
	});

	it('changing the room (or origin) starts over instead of reusing a foreign cursor', async () => {
		const h = harness();
		h.room.postMany(7);
		await h.poll();
		expect(cursorOf(h)).toBe(7);
		const other = new FakeRoom('meta');
		other.postMany(2);
		h.params.room = 'meta';
		const { items, urls } = await h.poll({ router: roomRouter(other) });
		expect(items).toBeNull();
		expect(urls).toEqual([`${ORIGIN}/r/meta?limit=1&format=json`]);
		expect(h.staticData.technocore).toMatchObject({ room: 'meta', cursor: 2 });
	});

	it('parses 19-digit nonces without precision loss', async () => {
		const h = harness();
		await h.poll();
		h.room.post('did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp', 'big nonce', {
			nonce: '9223372036854775807',
			sig: `${'b'.repeat(85)}Q`,
		});
		const { items } = await h.poll();
		expect(items?.[0].nonce).toBe('9223372036854775807');
	});

	it('an export cut short by the poll time budget leaves the unread range for the next poll: no gap, nothing lost', async () => {
		const h = harness({ maxMessagesPerPoll: 1000 });
		await h.poll();
		h.room.postMany(450);
		const first = await h.poll({ router: slowExport(h.room, 20), pollBudgetMs: 60 });
		expect(describeItems(first.items).filter((d) => typeof d === 'string')).toEqual([]);
		const cursor = cursorOf(h);
		// Only the contiguous prefix the export reached is emitted; the cursor stops there.
		expect(seqsOf(first.items)).toEqual(cursor > 0 ? range(1, cursor) : []);
		expect(cursor).toBeLessThan(250);

		const second = await h.poll();
		expect(describeItems(second.items).filter((d) => typeof d === 'string')).toEqual([]);
		expect([...seqsOf(first.items), ...seqsOf(second.items)]).toEqual(range(1, 450));
		expect(cursorOf(h)).toBe(450);
		expect(h.staticData.technocore).not.toHaveProperty('boundedStalls');
	});

	it('an export that keeps running out of time before the cursor is reported as backfill-bounded after 3 polls', async () => {
		const h = harness({ maxMessagesPerPoll: 1000 });
		await h.poll();
		h.room.postMany(100);
		expect(seqsOf((await h.poll()).items)).toEqual(range(1, 100));
		h.room.postMany(400); // 101..500: the read shows 301..500, 101..300 need the export
		const stalled = slowExport(h.room, 80);
		for (let i = 1; i <= 3; i++) {
			const { items } = await h.poll({ router: stalled, pollBudgetMs: 50 });
			expect(items, `stalled poll ${i}`).toBeNull();
			expect(h.staticData.technocore).toMatchObject({ cursor: 100, boundedStalls: i });
		}
		const { items } = await h.poll({ router: stalled, pollBudgetMs: 50 });
		expect(items?.[0]).toMatchObject({
			type: 'gap',
			from: 101,
			to: 300,
			reason: 'backfill-bounded',
		});
		expect(seqsOf(items)).toEqual(range(301, 500));
		expect(h.staticData.technocore).toMatchObject({ cursor: 500 });
		expect(h.staticData.technocore).not.toHaveProperty('boundedStalls');
	});

	it('Start From = now on a room whose messages all expired: the next messages arrive with no false gap', async () => {
		const h = harness({ maxMessagesPerPoll: 1000 }, new FakeRoom('e-spec'));
		h.room.postMany(10);
		h.room.expireAll();
		expect((await h.poll()).items).toBeNull();
		expect(h.staticData.technocore).toMatchObject({ cursor: 0, generation: 1, baseline: true });
		h.room.postMany(2);
		const { items } = await h.poll();
		expect(describeItems(items)).toEqual([11, 12]);
		expect(h.staticData.technocore).toEqual({
			v: 1,
			origin: ORIGIN,
			room: 'e-spec',
			cursor: 12,
			generation: 1,
		});
	});

	it('Start From = now on a reaped room (seq floor kept): its recreation after activation is not reported against history the trigger never had', async () => {
		const h = harness({ maxMessagesPerPoll: 1000 }, new FakeRoom('idle-spec'));
		h.room.postMany(10);
		h.room.reapKeepingFloor();
		await h.poll();
		expect(h.staticData.technocore).toMatchObject({ cursor: 0, generation: 1, baseline: true });
		expect((await h.poll()).items).toBeNull(); // still nothing visible
		h.room.postMany(3); // 11..13, generation 2
		const { items } = await h.poll();
		expect(describeItems(items)).toEqual([11, 12, 13]);
		expect(h.staticData.technocore).toMatchObject({ cursor: 13, generation: 2 });
		expect(h.staticData.technocore).not.toHaveProperty('baseline');
		// From here on a gap or recreation is real and reported.
		h.room.postMany(3);
		h.room.tear(15);
		expect(describeItems((await h.poll()).items)).toEqual([14, 'gap:15-15:missing', 16]);
	});

	it('Start From = now on a never-created room still reports messages the ring dropped before the first poll', async () => {
		const h = harness({ maxMessagesPerPoll: 1000 });
		await h.poll();
		expect(h.staticData.technocore).not.toHaveProperty('baseline');
		h.room.postMany(400);
		h.room.dropBefore(151);
		expect(describeItems((await h.poll()).items)[0]).toBe('gap:1-150:ring-dropped');
	});

	it('Start From = retained on a reaped room: nothing is reported against the gone generation', async () => {
		const h = harness({ startFrom: 'retained', maxMessagesPerPoll: 1000 }, new FakeRoom('idle-r'));
		h.room.postMany(10);
		h.room.reapKeepingFloor();
		expect((await h.poll()).items).toBeNull();
		h.room.postMany(3);
		expect(describeItems((await h.poll()).items)).toEqual([11, 12, 13]);
	});

	it('Start From = retained with backfill off: retained history the read did not return is a not-backfilled gap', async () => {
		const h = harness({ startFrom: 'retained', backfillGaps: false, maxMessagesPerPoll: 1000 });
		h.room.postMany(300);
		const { items, urls } = await h.poll();
		expect(urls.some((url) => url.endsWith('/export'))).toBe(false);
		expect(describeItems(items)).toEqual(['gap:1-100:not-backfilled', ...range(101, 300)]);
		expect(cursorOf(h)).toBe(300);
	});

	it('Start From = retained with a size-bounded export reports the unreached retained range', async () => {
		const h = harness({ startFrom: 'retained', maxMessagesPerPoll: 1000, maxExportMB: 1 });
		for (let i = 0; i < 600; i++) h.room.post('tester', `${i} ${'x'.repeat(4000)}`);
		const { items } = await h.poll();
		const described = describeItems(items);
		const gaps = described.filter((d) => typeof d === 'string');
		expect(gaps).toHaveLength(1);
		expect(gaps[0]).toMatch(/^gap:\d+-400:backfill-bounded$/);
		expect(seqsOf(items).slice(-200)).toEqual(range(401, 600));
		expect(seqsOf(items)[0]).toBe(1);
	});

	it('a sequence that restarts without a generation change is detected on the next quiet poll (reset, then the new sequence)', async () => {
		const h = harness({ maxMessagesPerPoll: 1000 });
		await h.poll();
		h.room.postMany(20);
		expect(seqsOf((await h.poll()).items)).toEqual(range(1, 20));
		expect((await h.poll()).items).toBeNull();
		expect(h.staticData.technocore).toMatchObject({ cursor: 20, generation: 1, idle: true });

		h.room.restartSequenceKeepingGeneration();
		h.room.postMany(5); // seq 1..5 again, still generation 1
		const { items, urls } = await h.poll();
		expect(urls).toEqual([
			`${ORIGIN}/r/lobby?limit=1&format=json`,
			`${ORIGIN}/r/lobby?limit=200&format=json`,
		]);
		expect(describeItems(items)).toEqual(['reset', 1, 2, 3, 4, 5]);
		expect(items?.[0]).toMatchObject({
			type: 'reset',
			previousCursor: 20,
			firstSeq: 1,
			generation: 1,
		});
		expect(h.staticData.technocore).toEqual({
			v: 1,
			origin: ORIGIN,
			room: 'lobby',
			cursor: 5,
			generation: 1,
		});
		h.room.postMany(1);
		expect(seqsOf((await h.poll()).items)).toEqual([6]);
	});

	it('a quiet poll costs one small read; new messages after a quiet poll cost one more', async () => {
		const h = harness();
		await h.poll();
		h.room.postMany(3);
		expect(seqsOf((await h.poll()).items)).toEqual([1, 2, 3]);
		const quiet = await h.poll();
		expect(quiet.urls).toEqual([`${ORIGIN}/r/lobby?since=3&limit=200&format=json`]);
		const stillQuiet = await h.poll();
		expect(stillQuiet.items).toBeNull();
		expect(stillQuiet.urls).toEqual([`${ORIGIN}/r/lobby?limit=1&format=json`]);
		h.room.postMany(2);
		const busy = await h.poll();
		expect(seqsOf(busy.items)).toEqual([4, 5]);
		expect(busy.urls).toEqual([
			`${ORIGIN}/r/lobby?limit=1&format=json`,
			`${ORIGIN}/r/lobby?since=3&limit=200&format=json`,
		]);
	});

	it('messages expiring while the trigger is quiet are not mistaken for a restarted sequence', async () => {
		const h = harness({}, new FakeRoom('e-quiet'));
		await h.poll();
		h.room.postMany(5);
		expect(seqsOf((await h.poll()).items)).toEqual(range(1, 5));
		expect((await h.poll()).items).toBeNull();
		h.room.expireAll();
		expect((await h.poll()).items).toBeNull();
		expect(h.staticData.technocore).toMatchObject({ cursor: 5, idle: true });
		h.room.postMany(1);
		expect(describeItems((await h.poll()).items)).toEqual([6]);
	});

	it('a room recreated while the trigger is quiet is still reported as recreated', async () => {
		const h = harness();
		await h.poll();
		h.room.postMany(10);
		await h.poll();
		expect((await h.poll()).items).toBeNull();
		h.room.reapLosingFloor();
		h.room.postMany(2);
		const { items } = await h.poll();
		expect(describeItems(items)).toEqual(['recreated', 'reset', 1, 2]);
	});

	it('refuses an invalid room name before any request', async () => {
		const h = harness({ room: 'Not A Room' });
		await expect(h.poll()).rejects.toThrow(/Invalid room name/);
	});
});
