// VENDORED from technocore-watch-core@57b4d61c6b64e6dc79e0584a9c3e0f3e0d93eec8 src/protocol/reconcile.ts - do not edit; run `npm run vendor`.
// reconcile: fold one origin observation into a subscription's cursors. Pure.
//
// INVARIANT (property-tested): after a successful step, every seq in (old headSeq,
// new headSeq] — or (0, new headSeq] after a seq regression — is either delivered
// (present in `delivered`, ascending, exactly once) or covered by exactly one GapRecord
// in `gaps`. Nothing is skipped silently. This is the "8 messages, limit 3" fix: the read
// view returns the NEWEST window, so a tail that starts above headSeq+1 is never taken
// at face value — it asks for a backfill (export) first.
//
// When the observation alone cannot establish the range, reconcile returns
// `needsBackfill` with the state UNCHANGED; the caller fetches and calls again:
//   - 'tail-gap'          export (afterSeq, beforeSeq) then reconcile(sub, since, view, {backfill})
//   - 'generation-change' export from 0 (the oldest retained record decides regression)
//   - 'catch-up'          the view was fetched with since > headSeq (a shared poll ahead of
//                         this subscriber): re-read with since = headSeq and reconcile that.

import type { ExportScan, GapReason, GapRecord, Message, ReadView, SubscriptionState } from './types.ts';

export const DEFAULT_MAX_GAPS = 8;

export interface BackfillRequest {
  afterSeq: number;
  beforeSeq: number;
  generation?: number;
  reason: 'tail-gap' | 'generation-change' | 'catch-up';
}

export interface ReconcileResult {
  next: SubscriptionState;
  /** Messages newly delivered, ascending, each seq exactly once. */
  delivered: Message[];
  /** Gaps newly detected by this step. */
  gaps: GapRecord[];
  /** (from, to] seq range this step settled; present when headSeq moved or reset. */
  range?: { from: number; to: number };
  /** Design-compat summary of `delivered` + `range`. */
  activity?: { seqFrom: number; seqTo: number; count: number; messages: Message[] };
  needsBackfill?: BackfillRequest;
  recreated?: { from?: number; to: number };
  regression?: { fromHead: number; toLast: number };
  ignored?: 'room-mismatch' | 'stale-generation';
}

export interface ReconcileOptions {
  backfill?: ExportScan;
  maxGaps?: number;
}

function cloneSub(sub: SubscriptionState): SubscriptionState {
  return { ...sub, gaps: sub.gaps.map((g) => ({ ...g })) };
}

/** First seq the view proves exactly: everything >= coverStart that exists is in view.messages. */
export function coverStart(since: number, view: ReadView): number {
  const first = view.messages[0];
  if (!first) return since + 1;
  return first.seq <= since + 1 ? since + 1 : first.seq;
}

function covers(bf: ExportScan | undefined, afterSeq: number, beforeSeq: number, generation: number | undefined): bf is ExportScan {
  if (!bf) return false;
  if (bf.afterSeq > afterSeq || bf.beforeSeq < beforeSeq) return false;
  if (bf.generation !== undefined && generation !== undefined && bf.generation !== generation) return false;
  return true;
}

function mergeAscending(a: readonly Message[], b: readonly Message[]): Message[] {
  const bySeq = new Map<number, Message>();
  for (const m of a) bySeq.set(m.seq, m);
  for (const m of b) bySeq.set(m.seq, m); // the view (b) wins on overlap: it is the newer fetch
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
}

interface Assembly {
  delivered: Message[];
  gaps: GapRecord[];
  head: number;
}

/**
 * Walk records above `head`, delivering contiguous runs and recording every hole.
 * Holes above the export's scan boundary (when a budget stopped it) are 'backfill-bounded';
 * holes the export proves absent are 'ring-dropped'.
 */
function assemble(
  head: number,
  records: readonly Message[],
  bf: ExportScan | undefined,
  boundaryBefore: number,
  generation: number | undefined,
  detectedAt: string,
): Assembly {
  const delivered: Message[] = [];
  const gaps: GapRecord[] = [];
  let expected = head + 1;
  const scannedThrough = bf && bf.bounded ? (bf.lastScannedSeq ?? bf.afterSeq) : Number.POSITIVE_INFINITY;
  const push = (from: number, to: number, reason: GapReason) => {
    if (to < from) return;
    const g: GapRecord = { from, to, reason, detectedAt };
    if (generation !== undefined) g.generation = generation;
    gaps.push(g);
  };
  for (const r of records) {
    if (r.seq < expected) continue;
    if (r.seq > expected) {
      const holeTo = r.seq - 1;
      if (bf && bf.bounded && holeTo < boundaryBefore) {
        // Split at what the export actually scanned.
        const droppedTo = Math.min(holeTo, scannedThrough);
        push(expected, droppedTo, 'ring-dropped');
        push(Math.max(expected, scannedThrough + 1), holeTo, 'backfill-bounded');
      } else {
        push(expected, holeTo, 'ring-dropped');
      }
    }
    delivered.push(r);
    expected = r.seq + 1;
  }
  return { delivered, gaps, head: expected - 1 };
}

/** Keep gaps bounded: drop settled ones (below acceptedSeq, or older generations), then merge oldest. */
export function boundGaps(gaps: GapRecord[], sub: Pick<SubscriptionState, 'acceptedSeq' | 'generation'>, max = DEFAULT_MAX_GAPS): GapRecord[] {
  let out = gaps.filter((g) => {
    const sameGen = g.generation === undefined || sub.generation === undefined || g.generation === sub.generation;
    return !sameGen || g.to > sub.acceptedSeq;
  });
  // Older-generation records are informational only; keep at most two of them.
  const current = out.filter((g) => g.generation === undefined || sub.generation === undefined || g.generation === sub.generation);
  const older = out.filter((g) => !current.includes(g)).slice(-2);
  out = [...older, ...current.sort((a, b) => a.from - b.from)];
  while (out.length > max) {
    const [a, b] = out;
    if (!a || !b) break;
    if (a.generation !== b.generation) {
      out.shift();
      continue;
    }
    const merged: GapRecord = { ...a, from: Math.min(a.from, b.from), to: Math.max(a.to, b.to) };
    out.splice(0, 2, merged);
  }
  return out;
}

export function reconcile(
  sub: SubscriptionState,
  since: number,
  view: ReadView,
  now: Date,
  opts: ReconcileOptions = {},
): ReconcileResult {
  const detectedAt = now.toISOString();
  const maxGaps = opts.maxGaps ?? DEFAULT_MAX_GAPS;
  const unchanged = (extra: Partial<ReconcileResult> = {}): ReconcileResult => ({
    next: cloneSub(sub),
    delivered: [],
    gaps: [],
    ...extra,
  });

  if (view.room !== sub.room) return unchanged({ ignored: 'room-mismatch' });
  const G = sub.generation;
  const g = view.generation;
  if (g !== undefined && G !== undefined && g < G) return unchanged({ ignored: 'stale-generation' });
  const H = sub.headSeq;
  const start = coverStart(since, view);
  const bf = opts.backfill;
  const genChanged = g !== undefined && G !== undefined && g > G;

  if (!genChanged) {
    if (since > H) {
      return unchanged({ needsBackfill: { afterSeq: H, beforeSeq: since + 1, ...(g !== undefined ? { generation: g } : {}), reason: 'catch-up' } });
    }
    const fresh = view.messages.filter((m) => m.seq > H);
    if (fresh.length === 0) {
      const next = cloneSub(sub);
      if (G === undefined && g !== undefined) next.generation = g;
      return { next, delivered: [], gaps: [] };
    }
    let records: Message[] = fresh;
    let usedBf: ExportScan | undefined;
    if (start > H + 1) {
      if (!covers(bf, H, start, g)) {
        return unchanged({ needsBackfill: { afterSeq: H, beforeSeq: start, ...(g !== undefined ? { generation: g } : {}), reason: 'tail-gap' } });
      }
      usedBf = bf;
      records = mergeAscending(bf.records.filter((m) => m.seq > H && m.seq < start), fresh);
    }
    const genForGaps = g ?? G;
    const a = assemble(H, records, usedBf, start, genForGaps, detectedAt);
    const next = cloneSub(sub);
    if (genForGaps !== undefined) next.generation = genForGaps;
    next.headSeq = a.head;
    next.lastActivityAt = detectedAt;
    next.gaps = boundGaps([...next.gaps, ...a.gaps], next, maxGaps);
    return finish(next, a, H);
  }

  // Generation changed: the room was (re)created. Only the oldest retained record of the new
  // generation can tell a continued sequence (reap with floor) from a restarted one.
  if (!covers(bf, 0, start, g)) {
    return unchanged({ needsBackfill: { afterSeq: 0, beforeSeq: start, generation: g, reason: 'generation-change' } });
  }
  const all = mergeAscending(bf.records.filter((m) => m.seq < start), view.messages);
  const oldest = bf.oldestRetainedSeq ?? all[0]?.seq;
  const recreated: { from?: number; to: number } = { to: g };
  if (G !== undefined) recreated.from = G;
  if (oldest === undefined) {
    const next = cloneSub(sub);
    next.generation = g;
    return { next, delivered: [], gaps: [], recreated };
  }
  if (oldest <= H) {
    // Seq regression: the new generation restarted numbering at or below our head.
    const lost: GapRecord[] = [];
    if (sub.acceptedSeq < H) {
      const r: GapRecord = { from: sub.acceptedSeq + 1, to: H, reason: 'seq-regression', detectedAt };
      if (G !== undefined) r.generation = G;
      lost.push(r);
    }
    const a = assemble(0, all, bf, start, g, detectedAt);
    const next = cloneSub(sub);
    next.generation = g;
    next.headSeq = a.head;
    next.notifiedSeq = 0;
    next.acceptedSeq = 0;
    next.lastActivityAt = detectedAt;
    next.gaps = boundGaps([...next.gaps, ...lost, ...a.gaps], next, maxGaps);
    const res = finish(next, a, 0);
    res.gaps = [...lost, ...a.gaps];
    res.recreated = recreated;
    res.regression = { fromHead: H, toLast: a.head };
    return res;
  }
  // Continued sequence: cursors stay (min(current, oldest - 1) == current); anything between
  // our head and the new generation's oldest record is gone.
  const a = assemble(H, all.filter((m) => m.seq > H), bf, start, g, detectedAt);
  const next = cloneSub(sub);
  next.generation = g;
  next.headSeq = a.head;
  if (a.delivered.length || a.gaps.length) next.lastActivityAt = detectedAt;
  next.gaps = boundGaps([...next.gaps, ...a.gaps], next, maxGaps);
  const res = finish(next, a, H);
  res.recreated = recreated;
  return res;
}

function finish(next: SubscriptionState, a: Assembly, from: number): ReconcileResult {
  const res: ReconcileResult = { next, delivered: a.delivered, gaps: a.gaps };
  if (a.head > from || a.gaps.length) {
    res.range = { from, to: a.head };
    res.activity = { seqFrom: from + 1, seqTo: a.head, count: a.delivered.length, messages: a.delivered };
  }
  return res;
}

/** Advance acceptedSeq monotonically within the current generation, clamped to headSeq. */
export function applyAck(sub: SubscriptionState, throughSeq: number, generation?: number): SubscriptionState {
  if (generation !== undefined && sub.generation !== undefined && generation !== sub.generation) return sub;
  const target = Math.min(Math.max(0, Math.floor(throughSeq)), sub.headSeq);
  if (target <= sub.acceptedSeq) return sub;
  const next = cloneSub(sub);
  next.acceptedSeq = target;
  next.gaps = boundGaps(next.gaps, next);
  return next;
}

/** Advance notifiedSeq monotonically within the current generation, clamped to headSeq. */
export function applyNotified(sub: SubscriptionState, throughSeq: number, generation?: number): SubscriptionState {
  if (generation !== undefined && sub.generation !== undefined && generation !== sub.generation) return sub;
  const target = Math.min(Math.max(0, Math.floor(throughSeq)), sub.headSeq);
  if (target <= sub.notifiedSeq) return sub;
  return { ...cloneSub(sub), notifiedSeq: target };
}

/** Seqs in (acceptedSeq, headSeq] not covered by a current-generation gap. */
export function unreadCount(sub: SubscriptionState): number {
  let gapped = 0;
  for (const g of sub.gaps) {
    if (g.generation !== undefined && sub.generation !== undefined && g.generation !== sub.generation) continue;
    const from = Math.max(g.from, sub.acceptedSeq + 1);
    const to = Math.min(g.to, sub.headSeq);
    if (to >= from) gapped += to - from + 1;
  }
  return Math.max(0, sub.headSeq - sub.acceptedSeq - gapped);
}

export function newSubscription(room: string, now: Date, startFrom?: 'now' | 'retained'): SubscriptionState {
  const s: SubscriptionState = {
    room,
    headSeq: 0,
    notifiedSeq: 0,
    acceptedSeq: 0,
    gaps: [],
    status: 'active',
    createdAt: now.toISOString(),
  };
  if (startFrom) s.startFrom = startFrom;
  return s;
}
