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

/** Polls in a row a time-bounded export may stall the cursor before its range is reported. */
export const MAX_BOUNDED_STALLS = 3;

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
	/**
	 * The trigger has emitted nothing yet from a room that already existed when it started
	 * (Start From = retained, or Start From = now on a room with no visible messages). Seqs
	 * the room no longer holds before the first message that appears are history from
	 * before the trigger, not gaps, and a generation change is not a recreation of anything
	 * the trigger saw.
	 */
	baseline?: boolean;
	/** Consecutive polls whose export ran out of time before the cursor could move. */
	boundedStalls?: number;
	/**
	 * The last poll found nothing new. The next poll first reads only the room's newest
	 * message, which is cheaper and also shows a sequence that restarted below the cursor.
	 */
	idle?: boolean;
}

export type TriggerEvent =
	| { type: 'message'; message: Message }
	| { type: 'gap'; gap: GapRecord }
	| { type: 'recreated'; fromGeneration: number; toGeneration: number; previousCursor: number }
	| { type: 'reset'; previousCursor: number; firstSeq: number };

/**
 * How to treat seqs before the first message this poll can see:
 * - `report`: they are gaps (the normal case).
 * - `suppress`: the trigger has no history yet (see `TriggerState.baseline`); seqs the
 *   room no longer holds are not gaps, but retained seqs that were not fetched are.
 * - `recreated`: the room was recreated, or its sequence restarted below the cursor; seqs
 *   after `previousCursor` that the room does not hold are a `recreated` gap, and a first
 *   seq at or below `previousCursor` means the sequence restarted (a `reset` event).
 */
export type LeadingMode =
	| { mode: 'report' }
	| { mode: 'suppress' }
	| { mode: 'recreated'; previousCursor: number };

function isCount(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function readState(data: unknown, origin: string, room: string): TriggerState | null {
	if (typeof data !== 'object' || data === null) return null;
	const state = data as Partial<TriggerState>;
	if (state.v !== STATE_VERSION || state.origin !== origin || state.room !== room) return null;
	if (!isCount(state.cursor)) return null;
	const out: TriggerState = { v: STATE_VERSION, origin, room, cursor: state.cursor };
	if (typeof state.generation === 'number' && Number.isSafeInteger(state.generation)) {
		out.generation = state.generation;
	}
	if (isCount(state.recreatedFrom)) out.recreatedFrom = state.recreatedFrom;
	if (state.baseline === true) out.baseline = true;
	if (isCount(state.boundedStalls) && state.boundedStalls > 0) {
		out.boundedStalls = state.boundedStalls;
	}
	if (state.idle === true) out.idle = true;
	return out;
}

/** A generation change the trigger must surface (0 means "never existed", not a recreation). */
export function isRecreation(previous: number | undefined, current: number | undefined): boolean {
	return previous !== undefined && current !== undefined && previous > 0 && current !== previous;
}

/** The read skipped seqs after the cursor, so only the export can show what is between. */
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
	/**
	 * Stop the cursor before a range a time-bounded export did not reach (the next poll can
	 * fetch it) instead of reporting it as `backfill-bounded`.
	 */
	deferBounded: boolean;
}

export interface AssembleResult {
	events: TriggerEvent[];
	cursor: number;
	emittedMessages: number;
	/** True when the cursor stopped before a range the export ran out of time to reach. */
	deferred: boolean;
}

/**
 * A reason when the hole starting at `from` may still hold retained records that were not
 * fetched (so the room was not shown to have lost them), otherwise null.
 */
function unfetchedReason(from: number, isLeading: boolean, input: AssembleInput): GapReason | null {
	const { scan, view } = input;
	if (!scan) return isLeading && input.backfillDisabled ? 'not-backfilled' : null;
	const lastSeen = scan.lastSeenSeq ?? input.cursor;
	if (scan.bounded && from > lastSeen && view.first_seq !== null && from < view.first_seq) {
		return 'backfill-bounded';
	}
	return null;
}

/** Why a hole the reads *did* cover holds nothing. */
function knownHoleReason(from: number, isLeading: boolean, input: AssembleInput): GapReason {
	const { scan } = input;
	if (!isLeading || !scan) return 'missing';
	if (scan.oldestSeq === undefined || from < scan.oldestSeq) return 'ring-dropped';
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
	let deferred = false;
	for (const seq of seqs) {
		if (emitted >= maxMessages) break;
		const restarted = first && leading.mode === 'recreated' && seq <= leading.previousCursor;
		if (seq > next + 1) {
			const from = next + 1;
			const to = seq - 1;
			const unfetched = unfetchedReason(from, first, input);
			if (unfetched === 'backfill-bounded' && scan?.boundedBy === 'time' && input.deferBounded) {
				// The export ran out of time before this range; the next poll can fetch it.
				deferred = true;
				break;
			}
			if (unfetched) {
				if (restarted) {
					events.push({ type: 'reset', previousCursor: leading.previousCursor, firstSeq: seq });
				}
				events.push({ type: 'gap', gap: { from, to, reason: unfetched } });
			} else if (first && leading.mode === 'suppress') {
				// Only seqs below the oldest retained record are history from before the trigger.
				const oldest = scan?.oldestSeq;
				if (oldest !== undefined && oldest <= to) {
					const reportFrom = Math.max(from, oldest);
					events.push({
						type: 'gap',
						gap: { from: reportFrom, to, reason: knownHoleReason(reportFrom, false, input) },
					});
				}
			} else if (first && leading.mode === 'recreated') {
				if (restarted) {
					// The sequence restarted: seqs below the first visible one belong to the new
					// sequence and were dropped before this trigger saw them.
					events.push({ type: 'reset', previousCursor: leading.previousCursor, firstSeq: seq });
					events.push({ type: 'gap', gap: { from, to, reason: 'ring-dropped' } });
				} else if (to > leading.previousCursor) {
					events.push({
						type: 'gap',
						gap: { from: Math.max(from, leading.previousCursor + 1), to, reason: 'recreated' },
					});
				}
			} else {
				events.push({
					type: 'gap',
					gap: { from, to, reason: knownHoleReason(from, first, input) },
				});
			}
		} else if (restarted) {
			events.push({ type: 'reset', previousCursor: leading.previousCursor, firstSeq: seq });
		}
		first = false;
		const message = bySeq.get(seq);
		if (message) events.push({ type: 'message', message });
		next = seq;
		emitted++;
	}
	return { events, cursor: next, emittedMessages: emitted, deferred };
}
