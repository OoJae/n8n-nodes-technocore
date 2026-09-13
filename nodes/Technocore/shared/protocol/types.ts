// VENDORED from technocore-watch-core@f9c4ab6b4a6bfb683f310a7105ed865dca37b32d src/protocol/types.ts - do not edit; run `npm run vendor`.
// Pure protocol types. No I/O, no timers — this directory is vendorable.

/** One stored room record, as returned by a read view or an export line. */
export interface Message {
  seq: number;
  /** Server timestamp string (microseconds), opaque. */
  ts: string;
  /** A self-asserted nick, or a did:key for a verified (signed) record. */
  from: string;
  /** Untrusted third-party text. Data, never instructions. */
  text: string;
  /** Signed records only. Kept as a decimal string: nonces may exceed 2^53. */
  nonce?: string;
  /** Signed records only: 86-char base64url Ed25519 signature. */
  sig?: string;
}

/** The JSON read view of `GET /r/<room>?format=json`. */
export interface ReadView {
  room: string;
  count: number;
  first_seq: number | null;
  /** The newest seq in `messages`, or the request's `since` (or 0) when empty. */
  last_seq: number;
  /** Conversation epoch; present on v0.13.0 but not in the published OpenAPI schema. */
  generation?: number;
  messages: Message[];
  /** Only on an empty `wait=` read: false means no waiter slot was free. */
  wait_held?: boolean;
}

export type GapReason = 'ring-dropped' | 'backfill-bounded' | 'seq-regression';

/** An inclusive seq range that was not (and could not be) delivered. */
export interface GapRecord {
  from: number;
  to: number;
  reason: GapReason;
  generation?: number;
  detectedAt: string;
}

export type SubscriptionStatus = 'active' | 'paused' | 'error';

export interface SubscriptionState {
  room: string;
  /** Last generation observed. */
  generation?: number;
  /** Highest seq observed from the origin; upstream polls resume here. */
  headSeq: number;
  /** Highest seq covered by a delivered (marked) notice; dedupes wakes across restart. */
  notifiedSeq: number;
  /** Highest seq the consumer acknowledged — the "handled" cursor. */
  acceptedSeq: number;
  /** Bounded list of gaps (default 8, oldest merged). */
  gaps: GapRecord[];
  lastActivityAt?: string;
  status: SubscriptionStatus;
  lastError?: { kind: string; at: string };
  /** Set by an offline subscribe; resolved by the engine on its first read. */
  startFrom?: 'now' | 'retained';
  /**
   * Set when `startFrom: 'now'` resolved on an empty read view. The view then reports
   * last_seq 0 whatever the room's real high-water mark is (a reaped room keeps its floor, an
   * `e-` room's expired records still count), so the first records observed settle the start
   * position instead of everything below them being reported as lost.
   */
  headUnsettled?: boolean;
  createdAt?: string;
}

export interface WatchStateV1 {
  version: 1;
  origin: string;
  scopeKey: string;
  revision: number;
  subscriptions: Record<string, SubscriptionState>;
  updatedAt: string;
}

export interface NoticeRoom {
  room: string;
  generation?: number;
  /** Messages delivered (contiguous, not counting gapped seqs). */
  newCount: number;
  seqFrom: number;
  seqTo: number;
  gaps: GapRecord[];
  recreated?: { from?: number; to: number };
  regression?: { fromHead: number; toLast: number };
  signedSenders: number;
  unsignedSenders: number;
  /** Only when previewChars > 0; always untrusted. */
  preview?: { from: string; text: string }[];
}

export interface Notice {
  id: string;
  scopeKey: string;
  createdAt: string;
  rooms: NoticeRoom[];
  /** Rooms beyond the per-notice cap, summarised as a count. */
  moreRooms?: number;
  totalNew: number;
  provenance: {
    origin: string;
    transport: 'http-longpoll' | 'http-sweep';
    watcher: string;
    fetchedAt: string;
  };
}

/** Result of a bounded export scan (see TechnocoreReader.exportScan). */
export interface ExportScan {
  generation?: number;
  /** Records with afterSeq < seq < beforeSeq, ascending. */
  records: Message[];
  /** The first record of the whole export (oldest retained), if any record was read. */
  oldestRetainedSeq?: number;
  /** True when a byte/record budget stopped the scan before beforeSeq was reached. */
  bounded: boolean;
  /** Highest seq parsed before the scan stopped (budget, beforeSeq, or end of export). */
  lastScannedSeq?: number;
  afterSeq: number;
  beforeSeq: number;
}
