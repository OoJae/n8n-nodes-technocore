import { describe, expect, it } from 'vitest';

import type { ExportScan } from '../../nodes/Technocore/shared/export';
import {
	assemble,
	isRecreation,
	needsBackfill,
	readState,
	type AssembleInput,
	type TriggerEvent,
} from '../../nodes/Technocore/shared/poll';
import type { Message, ReadView } from '../../nodes/Technocore/shared/protocol/types';

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
	assemble({ backfillDisabled: false, leading: { mode: 'report' }, maxMessages: 1000, ...input });
const describeEvents = (events: TriggerEvent[]) =>
	events.map((e) =>
		e.type === 'message'
			? e.message.seq
			: e.type === 'gap'
				? `gap:${e.gap.from}-${e.gap.to}:${e.gap.reason}`
				: e.type,
	);

/** Every seq in (cursor, newCursor] is emitted as a message or inside exactly one gap. */
function expectInvariant(cursor: number, events: TriggerEvent[], newCursor: number) {
	const covered: number[] = [];
	for (const e of events) {
		if (e.type === 'message') covered.push(e.message.seq);
		if (e.type === 'gap') {
			expect(e.gap.from).toBeLessThanOrEqual(e.gap.to);
			for (let s = e.gap.from; s <= e.gap.to; s++) covered.push(s);
		}
	}
	const expected = Array.from({ length: newCursor - cursor }, (_, i) => cursor + 1 + i);
	expect(covered.filter((s) => s > cursor)).toEqual(expected);
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

	it('holds the invariant across randomized views, drops, holes, limits and export budgets', () => {
		let seed = 42;
		const random = () => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed / 2147483648;
		};
		for (let round = 0; round < 2000; round++) {
			const cursor = Math.floor(random() * 50);
			const head = cursor + Math.floor(random() * 400);
			const dropBefore = cursor + 1 + Math.floor(random() * Math.max(1, head - cursor));
			const all = [] as number[];
			for (let s = dropBefore; s <= head; s++) if (random() > 0.02) all.push(s);
			const tail = all.filter((s) => s > cursor).slice(-200);
			const v = view(tail);
			let scan: ExportScan | undefined;
			const backfill = random() > 0.3;
			if (needsBackfill(cursor, v) && backfill) {
				const bounded = random() > 0.8;
				const cut = bounded ? Math.floor(random() * all.length) : all.length;
				const seen = all.slice(0, cut).filter((s) => s < (v.first_seq ?? Infinity));
				scan = {
					records: seen.filter((s) => s > cursor).map(msg),
					bounded,
					bytes: 0,
					oldestSeq: all[0],
					lastSeenSeq: seen.length ? seen[seen.length - 1] : undefined,
				};
			}
			const result = run({
				cursor,
				view: v,
				scan,
				backfillDisabled: needsBackfill(cursor, v) && !backfill,
				maxMessages: 1 + Math.floor(random() * 300),
			});
			expectInvariant(cursor, result.events, result.cursor);
			expect(result.cursor).toBeGreaterThanOrEqual(cursor);
		}
	});
});

describe('state helpers', () => {
	it('reads only matching, well-formed state', () => {
		expect(readState({ v: 1, origin: 'o', room: 'r', cursor: 5, generation: 2 }, 'o', 'r')).toEqual(
			{ v: 1, origin: 'o', room: 'r', cursor: 5, generation: 2 },
		);
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
