import { describe, expect, it } from 'vitest';

import { scanExport, type ExportScan } from '../../nodes/Technocore/shared/export';
import {
	assemble,
	isRecreation,
	needsBackfill,
	readState,
	type AssembleInput,
	type LeadingMode,
	type TriggerEvent,
} from '../../nodes/Technocore/shared/poll';
import type { Message, ReadView } from '../../nodes/Technocore/shared/protocol/types';

const TAIL = 200;
const msg = (seq: number): Message => ({ seq, ts: 't', from: 'a', text: `m${seq}` });
const view = (seqs: number[], generation = 1): ReadView => ({
	room: 'r',
	count: seqs.length,
	first_seq: seqs.length ? seqs[0] : null,
	last_seq: seqs.length ? seqs[seqs.length - 1] : 0,
	generation,
	messages: seqs.map(msg),
});
const run = (input: Partial<AssembleInput> & { cursor: number; view: ReadView }) =>
	assemble({
		backfillDisabled: false,
		leading: { mode: 'report' },
		maxMessages: 1000,
		deferBounded: false,
		...input,
	});
const describeEvents = (events: TriggerEvent[]) =>
	events.map((e) =>
		e.type === 'message'
			? e.message.seq
			: e.type === 'gap'
				? `gap:${e.gap.from}-${e.gap.to}:${e.gap.reason}`
				: e.type,
	);

function lcg(seed: number) {
	return () => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed / 2147483648;
	};
}

describe('assemble()', () => {
	it('recreated with the sequence continuing right after the old cursor reports no gap', () => {
		const result = run({
			cursor: 0,
			view: view([11, 12]),
			leading: { mode: 'recreated', previousCursor: 10 },
			scan: { records: [], bounded: false, bytes: 0, oldestSeq: 11 },
		});
		expect(describeEvents(result.events)).toEqual([11, 12]);
	});

	it('recreated with a restarted sequence: reset, then a gap for dropped new-generation seqs', () => {
		const result = run({
			cursor: 0,
			view: view([3, 4]),
			leading: { mode: 'recreated', previousCursor: 10 },
		});
		expect(describeEvents(result.events)).toEqual(['reset', 'gap:1-2:ring-dropped', 3, 4]);
	});

	it('a time-bounded export stops the cursor before the unread range when deferral is allowed', () => {
		const tail = Array.from({ length: TAIL }, (_, i) => 251 + i);
		const scan: ExportScan = {
			records: [1, 2, 3].map(msg),
			bounded: true,
			boundedBy: 'time',
			bytes: 0,
			oldestSeq: 1,
			lastSeenSeq: 3,
		};
		const deferred = run({ cursor: 0, view: view(tail), scan, deferBounded: true });
		expect(describeEvents(deferred.events)).toEqual([1, 2, 3]);
		expect(deferred).toMatchObject({ cursor: 3, deferred: true, emittedMessages: 3 });

		const reported = run({ cursor: 0, view: view(tail), scan, deferBounded: false });
		expect(describeEvents(reported.events).slice(0, 4)).toEqual([
			1,
			2,
			3,
			'gap:4-250:backfill-bounded',
		]);
		expect(reported).toMatchObject({ cursor: 450, deferred: false });

		// A size bound cannot be helped by retrying (the export is read from its start).
		const bytes = run({
			cursor: 0,
			view: view(tail),
			scan: { ...scan, boundedBy: 'bytes' },
			deferBounded: true,
		});
		expect(describeEvents(bytes.events)[3]).toBe('gap:4-250:backfill-bounded');
	});

	it('suppress hides only seqs the room no longer holds', () => {
		const tail = Array.from({ length: TAIL }, (_, i) => 101 + i);
		expect(
			describeEvents(
				run({
					cursor: 0,
					view: view(tail),
					leading: { mode: 'suppress' },
					scan: {
						records: Array.from({ length: 60 }, (_, i) => msg(41 + i)),
						bounded: false,
						bytes: 0,
						oldestSeq: 41,
						lastSeenSeq: 101,
					},
				}).events,
			).slice(0, 2),
		).toEqual([41, 42]);
		expect(
			describeEvents(
				run({ cursor: 0, view: view(tail), leading: { mode: 'suppress' }, backfillDisabled: true })
					.events,
			)[0],
		).toBe('gap:1-100:not-backfilled');
		// An export that holds nothing older than the read: the hole is not retained.
		expect(
			describeEvents(
				run({
					cursor: 0,
					view: view([11, 12]),
					leading: { mode: 'suppress' },
					scan: { records: [], bounded: false, bytes: 0, oldestSeq: 11, lastSeenSeq: 11 },
				}).events,
			),
		).toEqual([11, 12]);
	});

	it('needs the export whenever the read skipped seqs after the cursor', () => {
		expect(needsBackfill(0, view([11, 12]))).toBe(true);
		expect(needsBackfill(10, view([11, 12]))).toBe(false);
		expect(needsBackfill(10, view([]))).toBe(false);
	});

	it('holds the invariants across modes, drops, holes, limits, export budgets and deferral', () => {
		const random = lcg(42);
		const counts = { report: 0, suppress: 0, recreated: 0, deferred: 0, reset: 0 };
		const failures: string[] = [];
		for (let round = 0; round < 8000; round++) {
			const roll = random();
			const mode = roll < 0.45 ? 'report' : roll < 0.75 ? 'suppress' : 'recreated';
			counts[mode]++;
			const cursor = mode === 'report' ? Math.floor(random() * 50) : 0;
			const previousCursor = 1 + Math.floor(random() * 300);
			const head = cursor + Math.floor(random() * 450);
			const firstRetained = cursor + 1 + Math.floor(random() * Math.max(1, head - cursor));
			/** What the room still holds (readable), ascending. */
			const all: number[] = [];
			for (let s = firstRetained; s <= head; s++) if (random() > 0.02) all.push(s);
			const retained = new Set(all);
			const tail = all.filter((s) => s > cursor).slice(-TAIL);
			const v = view(tail);
			const backfill = random() > 0.3;
			const need = needsBackfill(cursor, v);
			let scan: ExportScan | undefined;
			if (need && backfill) {
				const index = all.indexOf(v.first_seq as number);
				let bounded = random() > 0.5;
				const cut = bounded ? Math.floor(random() * (index + 1)) : index + 1;
				if (cut > index) bounded = false;
				const reached = all.slice(0, cut);
				scan = {
					records: reached.filter((s) => s > cursor && s < (v.first_seq as number)).map(msg),
					bounded,
					bytes: 0,
					oldestSeq: reached[0],
					lastSeenSeq: reached[reached.length - 1],
				};
				if (bounded) scan.boundedBy = random() > 0.5 ? 'time' : 'bytes';
			}
			const leading: LeadingMode =
				mode === 'recreated' ? { mode, previousCursor } : { mode: mode as 'report' | 'suppress' };
			const deferBounded = random() > 0.5;
			const result = run({
				cursor,
				view: v,
				scan,
				backfillDisabled: need && !backfill,
				leading,
				maxMessages: 1 + Math.floor(random() * 300),
				deferBounded,
			});
			const context = JSON.stringify({ round, mode, cursor, previousCursor, firstRetained, head });
			// Plain checks (expect() per seq is slow); each failure names the round.
			const check = (ok: boolean, what: string) => {
				if (!ok) failures.push(`${context}: ${what}`);
			};

			check(result.cursor >= cursor, 'cursor moved backwards');
			const messages = result.events.flatMap((e) => (e.type === 'message' ? [e.message.seq] : []));
			const gaps = result.events.flatMap((e) => (e.type === 'gap' ? [e.gap] : []));
			const resets = result.events.filter((e) => e.type === 'reset');
			if (result.deferred) counts.deferred++;
			if (resets.length) counts.reset++;

			// Messages: ascending, retained, inside (cursor, new cursor].
			for (let i = 0; i < messages.length; i++) {
				check(retained.has(messages[i]), `message ${messages[i]} is not retained`);
				check(messages[i] > (i ? messages[i - 1] : cursor), `message ${messages[i]} out of order`);
				check(messages[i] <= result.cursor, `message ${messages[i]} past the cursor`);
			}
			// A reset only in recreated mode, once, before any message.
			check(resets.length <= (mode === 'recreated' ? 1 : 0), 'unexpected reset');
			const firstMessageAt = result.events.findIndex((e) => e.type === 'message');
			if (resets.length && firstMessageAt >= 0) {
				check(result.events.findIndex((e) => e.type === 'reset') < firstMessageAt, 'late reset');
			}
			// Gaps that claim the room no longer holds a seq must be right.
			for (const gap of gaps) {
				const label = `gap ${gap.from}-${gap.to}:${gap.reason}`;
				check(
					gap.from <= gap.to && gap.from > cursor && gap.to <= result.cursor,
					`${label} bounds`,
				);
				if (gap.reason !== 'backfill-bounded' && gap.reason !== 'not-backfilled') {
					for (let s = gap.from; s <= gap.to; s++) {
						check(!retained.has(s), `${label} covers retained ${s}`);
					}
				}
				if (deferBounded && scan?.boundedBy === 'time') {
					check(gap.reason !== 'backfill-bounded', `${label} instead of deferring`);
				}
			}
			// Coverage: every seq up to the new cursor is a message, in exactly one gap, or
			// legitimately silent (history the room no longer holds, or already delivered
			// before a recreation that continued the sequence).
			const messageSet = new Set(messages);
			for (let s = cursor + 1; s <= result.cursor; s++) {
				let covered = messageSet.has(s) ? 1 : 0;
				for (const g of gaps) if (g.from <= s && s <= g.to) covered++;
				if (covered === 1) continue;
				const silentOk =
					covered === 0 &&
					((mode === 'suppress' && !retained.has(s) && s < all[0]) ||
						(mode === 'recreated' && !resets.length && s <= previousCursor && !retained.has(s)));
				check(silentOk, `seq ${s} covered ${covered} times`);
			}
			// Deferral only when allowed, for a time bound, and never past the unread range.
			if (result.deferred) {
				check(deferBounded && scan?.boundedBy === 'time', 'deferred without a deferrable bound');
				check(result.cursor < (v.first_seq as number), 'deferred past the unread range');
			}
			if (failures.length > 20) break;
		}
		expect(failures).toEqual([]);
		// Every branch was exercised.
		for (const [name, count] of Object.entries(counts)) expect(count, name).toBeGreaterThan(40);
	});
});

describe('scanExport()', () => {
	const body = Array.from({ length: 50 }, (_, i) =>
		JSON.stringify({ seq: i + 1, ts: 't', from: 'a', text: `m${i + 1}` }),
	).join('\n');
	async function* stream(clock: { t: number }) {
		for (let offset = 0; offset < body.length; offset += 100) {
			clock.t += 10;
			yield Buffer.from(body.slice(offset, offset + 100));
		}
	}

	it('says whether the size or the time budget cut it short', async () => {
		const clock = { t: 0 };
		const timed = await scanExport(stream(clock), {
			afterSeq: 0,
			beforeSeq: 50,
			maxBytes: 1 << 20,
			deadline: 35,
			now: () => clock.t,
		});
		expect(timed).toMatchObject({ bounded: true, boundedBy: 'time', oldestSeq: 1 });
		const sized = await scanExport(stream({ t: 0 }), { afterSeq: 0, beforeSeq: 50, maxBytes: 250 });
		expect(sized).toMatchObject({ bounded: true, boundedBy: 'bytes' });
		const inMemory = await scanExport(body, { afterSeq: 0, beforeSeq: 50, maxBytes: 250 });
		expect(inMemory).toMatchObject({ bounded: true, boundedBy: 'bytes' });
		const whole = await scanExport(stream({ t: 0 }), {
			afterSeq: 10,
			beforeSeq: 50,
			maxBytes: 1 << 20,
		});
		expect(whole.bounded).toBe(false);
		expect(whole.boundedBy).toBeUndefined();
		expect(whole.records.map((r) => r.seq)).toEqual(Array.from({ length: 39 }, (_, i) => 11 + i));
	});
});

describe('state helpers', () => {
	it('reads only matching, well-formed state', () => {
		expect(readState({ v: 1, origin: 'o', room: 'r', cursor: 5, generation: 2 }, 'o', 'r')).toEqual(
			{ v: 1, origin: 'o', room: 'r', cursor: 5, generation: 2 },
		);
		expect(
			readState(
				{ v: 1, origin: 'o', room: 'r', cursor: 0, baseline: true, boundedStalls: 2, idle: true },
				'o',
				'r',
			),
		).toEqual({
			v: 1,
			origin: 'o',
			room: 'r',
			cursor: 0,
			baseline: true,
			boundedStalls: 2,
			idle: true,
		});
		expect(
			readState(
				{ v: 1, origin: 'o', room: 'r', cursor: 0, baseline: 'yes', boundedStalls: -1 },
				'o',
				'r',
			),
		).toEqual({ v: 1, origin: 'o', room: 'r', cursor: 0 });
		expect(readState({ v: 1, origin: 'o', room: 'x', cursor: 5 }, 'o', 'r')).toBeNull();
		expect(readState({ v: 2, origin: 'o', room: 'r', cursor: 5 }, 'o', 'r')).toBeNull();
		expect(readState({ v: 1, origin: 'o', room: 'r', cursor: -1 }, 'o', 'r')).toBeNull();
		expect(readState('nope', 'o', 'r')).toBeNull();
	});

	it('treats generation 0 -> 1 as creation, not recreation', () => {
		expect(isRecreation(0, 1)).toBe(false);
		expect(isRecreation(undefined, 3)).toBe(false);
		expect(isRecreation(1, 2)).toBe(true);
		expect(isRecreation(2, 2)).toBe(false);
	});
});
