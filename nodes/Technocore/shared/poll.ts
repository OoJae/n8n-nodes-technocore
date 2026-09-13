/**
 * Pure cursor logic for the Technocore Trigger. Given the stored cursor, a tail read and
 * (when needed) an export scan, it decides what to emit and where the cursor moves.
 *
 * Invariant: every seq in (cursor, new cursor] is either emitted as a message or covered
 * by an emitted gap event. Nothing is skipped silently, and the cursor only moves past
 * what was emitted (so maxMessagesPerPoll leaves the rest for the next poll).
 */
import type { ExportScan } from './export';
import type { Message, ReadView } from './protocol/types.ts';

export type GapReason =
	/** The export's oldest retained record is newer than the cursor: the ring dropped them. */
	| 'ring-dropped'
	/** The export was cut short by the byte or time budget. */
	| 'backfill-bounded'
	/** Backfill is switched off, so the tail read's skipped range was not fetched. */
	| 'not-backfilled'
	/** A hole between two retained records (for example a torn record). */
	| 'missing'
	/** The room was recreated; the previous generation's unseen tail is gone. */
	| 'recreated';

export interface GapRecord {
	from: number;
	to: number;
	reason: GapReason;
}

export const STATE_VERSION = 1;

export interface TriggerState {
	v: number;
	origin: string;
	room: string;
	cursor: number;
	generation?: number;
	/**
	 * Set when a recreation was reported but the new generation had no visible messages:
	 * the cursor before the recreation, so the next poll still classifies the new
	 * generation's first messages (recreated gap or sequence reset).
	 */
	recreatedFrom?: number;
}

export type TriggerEvent =
	| { type: 'message'; message: Message }
	| { type: 'gap'; gap: GapRecord }
	| { type: 'recreated'; fromGeneration: number; toGeneration: number; previousCursor: number }
	| { type: 'reset'; previousCursor: number; firstSeq: number };

/**
 * How to treat seqs before the first message this poll can see:
 * - `report`: they are gaps (the normal case).
 * - `suppress`: history from before the trigger existed (start from retained): not a gap.
 * - `recreated`: the room was recreated; seqs after `previousCursor` that the new
 *   generation does not hold are a `recreated` gap, and a first seq at or below
 *   `previousCursor` means the sequence restarted (a `reset` event).
 */
export type LeadingMode =
	| { mode: 'report' }
	| { mode: 'suppress' }
	| { mode: 'recreated'; previousCursor: number };

export function readState(data: unknown, origin: string, room: string): TriggerState | null {
	if (typeof data !== 'object' || data === null) return null;
	const state = data as Partial<TriggerState>;
	if (state.v !== STATE_VERSION || state.origin !== origin || state.room !== room) return null;
	if (typeof state.cursor !== 'number' || !Number.isSafeInteger(state.cursor) || state.cursor < 0)
		return null;
	const out: TriggerState = { v: STATE_VERSION, origin, room, cursor: state.cursor };
	if (typeof state.generation === 'number' && Number.isSafeInteger(state.generation)) {
		out.generation = state.generation;
	}
	if (
		typeof state.recreatedFrom === 'number' &&
		Number.isSafeInteger(state.recreatedFrom) &&
		state.recreatedFrom >= 0
	) {
		out.recreatedFrom = state.recreatedFrom;
	}
	return out;
}

/** A generation change the trigger must surface (0 means "never existed", not a recreation). */
export function isRecreation(previous: number | undefined, current: number | undefined): boolean {
	return previous !== undefined && current !== undefined && previous > 0 && current !== previous;
}

export function needsBackfill(cursor: number, view: ReadView): boolean {
	return view.first_seq !== null && view.first_seq > cursor + 1;
}

export interface AssembleInput {
	cursor: number;
	view: ReadView;
	/** The export scan, when backfill ran. */
	scan?: ExportScan;
	/** True when a backfill was needed but switched off. */
	backfillDisabled: boolean;
	leading: LeadingMode;
	maxMessages: number;
}

export interface AssembleResult {
	events: TriggerEvent[];
	cursor: number;
	emittedMessages: number;
}

function holeReason(from: number, isLeading: boolean, input: AssembleInput): GapReason {
	const { scan, view } = input;
	if (!scan) return input.backfillDisabled && isLeading ? 'not-backfilled' : 'missing';
	const lastSeen = scan.lastSeenSeq ?? input.cursor;
	if (scan.bounded && from > lastSeen && view.first_seq !== null && from < view.first_seq) {
		return 'backfill-bounded';
	}
	if (isLeading && scan.oldestSeq !== undefined && from < scan.oldestSeq) return 'ring-dropped';
	if (isLeading && scan.oldestSeq === undefined)
		return scan.bounded ? 'backfill-bounded' : 'ring-dropped';
	return 'missing';
}

export function assemble(input: AssembleInput): AssembleResult {
	const { cursor, view, scan, leading } = input;
	const maxMessages = Math.max(1, Math.floor(input.maxMessages));
	const bySeq = new Map<number, Message>();
	for (const record of scan?.records ?? []) if (record.seq > cursor) bySeq.set(record.seq, record);
	for (const message of view.messages) if (message.seq > cursor) bySeq.set(message.seq, message);
	const seqs = [...bySeq.keys()].sort((a, b) => a - b);

	const events: TriggerEvent[] = [];
	let next = cursor;
	let emitted = 0;
	let first = true;
	for (const seq of seqs) {
		if (emitted >= maxMessages) break;
		if (seq > next + 1) {
			const from = next + 1;
			const to = seq - 1;
			if (first && leading.mode === 'suppress') {
				// History from before the trigger started: not a gap.
			} else if (first && leading.mode === 'recreated') {
				if (seq <= leading.previousCursor) {
					// The sequence restarted: seqs below the first visible one belong to the new
					// generation and were dropped before this trigger saw them.
					events.push({ type: 'reset', previousCursor: leading.previousCursor, firstSeq: seq });
					events.push({ type: 'gap', gap: { from, to, reason: 'ring-dropped' } });
				} else if (to > leading.previousCursor) {
					events.push({
						type: 'gap',
						gap: { from: Math.max(from, leading.previousCursor + 1), to, reason: 'recreated' },
					});
				}
			} else {
				events.push({ type: 'gap', gap: { from, to, reason: holeReason(from, first, input) } });
			}
		}
		if (
			first &&
			leading.mode === 'recreated' &&
			seq <= leading.previousCursor &&
			seq === next + 1
		) {
			events.push({ type: 'reset', previousCursor: leading.previousCursor, firstSeq: seq });
		}
		first = false;
		const message = bySeq.get(seq);
		if (message) events.push({ type: 'message', message });
		next = seq;
		emitted++;
	}
	return { events, cursor: next, emittedMessages: emitted };
}
