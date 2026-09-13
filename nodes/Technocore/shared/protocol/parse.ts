// VENDORED from technocore-watch-core@57b4d61c6b64e6dc79e0584a9c3e0f3e0d93eec8 src/protocol/parse.ts - do not edit; run `npm run vendor`.
/* eslint-disable @n8n/community-nodes/require-node-api-error -- pure protocol code throws ProtocolError; call sites map it to NodeOperationError */
// Parsing of untrusted origin responses. Pure: no I/O.
import type { Message, ReadView } from './types.ts';

export class ProtocolError extends Error {
  override readonly name = 'ProtocolError';
}

/**
 * Rewrites every JSON number that is the value of a `"nonce"` object key into a string,
 * so a 19-digit nonce survives JSON.parse without rounding past 2^53.
 *
 * A tokenizer rather than a regex: message text is attacker-controlled, and a regex that
 * matched `"nonce": 5` inside an escaped string would let text reshape the parse.
 */
export function quoteNonceNumbers(json: string): string {
  let out = '';
  let last = 0;
  let i = 0;
  const n = json.length;
  let lastString: string | null = null; // most recent complete string token
  let lastStringIsKey = false;
  let expectValueForNonce = false;
  while (i < n) {
    const c = json.charCodeAt(i);
    if (c === 0x22 /* " */) {
      const start = i + 1;
      i++;
      let escaped = false;
      let simple = true;
      while (i < n) {
        const d = json.charCodeAt(i);
        if (escaped) {
          escaped = false;
        } else if (d === 0x5c /* \ */) {
          escaped = true;
          simple = false;
        } else if (d === 0x22) {
          break;
        }
        i++;
      }
      // Escaped spellings of the key (a backslash-u escape of any letter) decode to the same key.
      lastString = simple ? json.slice(start, i) : safeDecode(json.slice(start - 1, i + 1));
      lastStringIsKey = false;
      expectValueForNonce = false;
      i++;
      continue;
    }
    if (c === 0x3a /* : */) {
      lastStringIsKey = lastString !== null;
      expectValueForNonce = lastStringIsKey && lastString === 'nonce';
      i++;
      continue;
    }
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) {
      i++;
      continue;
    }
    if (expectValueForNonce && (c === 0x2d /* - */ || (c >= 0x30 && c <= 0x39))) {
      const start = i;
      i++;
      while (i < n) {
        const d = json.charCodeAt(i);
        if ((d >= 0x30 && d <= 0x39) || d === 0x2e || d === 0x65 || d === 0x45 || d === 0x2b || d === 0x2d) i++;
        else break;
      }
      out += json.slice(last, start) + '"' + json.slice(start, i) + '"';
      last = i;
      expectValueForNonce = false;
      lastString = null;
      continue;
    }
    // Any other token ends a key/value association.
    expectValueForNonce = false;
    lastString = null;
    lastStringIsKey = false;
    i++;
  }
  return last === 0 ? json : out + json.slice(last);
}

function safeDecode(literal: string): string | null {
  try {
    const v: unknown = JSON.parse(literal);
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/** Validates one record object (read view message or export line). */
export function toMessage(raw: unknown): Message {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProtocolError('message is not an object');
  }
  const r = raw as Record<string, unknown>;
  if (!isNonNegInt(r.seq)) throw new ProtocolError('message.seq is not a non-negative integer');
  if (typeof r.ts !== 'string') throw new ProtocolError('message.ts is not a string');
  if (typeof r.from !== 'string') throw new ProtocolError('message.from is not a string');
  if (typeof r.text !== 'string') throw new ProtocolError('message.text is not a string');
  const m: Message = { seq: r.seq, ts: r.ts, from: r.from, text: r.text };
  if (r.nonce !== undefined && r.nonce !== null) {
    const nonce = typeof r.nonce === 'number' ? String(r.nonce) : r.nonce;
    if (typeof nonce !== 'string' || !/^\d{1,20}$/.test(nonce)) {
      throw new ProtocolError('message.nonce is not a decimal integer');
    }
    m.nonce = nonce;
  }
  if (r.sig !== undefined && r.sig !== null) {
    if (typeof r.sig !== 'string') throw new ProtocolError('message.sig is not a string');
    m.sig = r.sig;
  }
  return m;
}

/** Parses the JSON read view. Bigint-safe for `nonce`. Throws ProtocolError when malformed. */
export function parseReadView(body: string): ReadView {
  let raw: unknown;
  try {
    raw = JSON.parse(quoteNonceNumbers(body));
  } catch (e) {
    throw new ProtocolError(`read view is not JSON: ${(e as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProtocolError('read view is not an object');
  }
  const v = raw as Record<string, unknown>;
  if (typeof v.room !== 'string') throw new ProtocolError('view.room is not a string');
  if (!isNonNegInt(v.last_seq)) throw new ProtocolError('view.last_seq is not a non-negative integer');
  if (!Array.isArray(v.messages)) throw new ProtocolError('view.messages is not an array');
  const messages = v.messages.map(toMessage);
  for (let k = 1; k < messages.length; k++) {
    if (messages[k]!.seq <= messages[k - 1]!.seq) throw new ProtocolError('view.messages are not ascending');
  }
  const view: ReadView = {
    room: v.room,
    count: isNonNegInt(v.count) ? v.count : messages.length,
    first_seq: messages.length ? messages[0]!.seq : null,
    last_seq: messages.length ? Math.max(v.last_seq, messages[messages.length - 1]!.seq) : v.last_seq,
    messages,
  };
  if (v.first_seq !== null && v.first_seq !== undefined && !isNonNegInt(v.first_seq)) {
    throw new ProtocolError('view.first_seq is not an integer or null');
  }
  if (isNonNegInt(v.generation)) view.generation = v.generation;
  if (typeof v.wait_held === 'boolean') view.wait_held = v.wait_held;
  return view;
}

/** Parses one NDJSON export line; returns null for blank or torn lines (the server skips them too). */
export function parseExportLine(line: string): Message | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(quoteNonceNumbers(trimmed));
  } catch {
    return null;
  }
  try {
    return toMessage(raw);
  } catch {
    return null;
  }
}

export type Refusal =
  | { kind: 'rate'; bucket: 'read' | 'write' | 'rooms'; perMinute?: number; retryAfterS: number }
  | { kind: 'bad-request' | 'forbidden' | 'duplicate' | 'conflict' | 'too-large'; message: string }
  | { kind: 'server'; status: number };

export interface HeaderLike {
  get(name: string): string | null | undefined;
}

const MAX_REFUSAL_MESSAGE = 400;

/**
 * Classifies a non-2xx response. For 429 the body is authoritative ("retry after: Ns"),
 * because harnesses that only surface bodies are the service's primary audience; the
 * Retry-After header is the fallback.
 */
export function parseRefusal(status: number, body: string, headers?: HeaderLike): Refusal {
  const firstLine = (body.split('\n', 1)[0] ?? '').slice(0, MAX_REFUSAL_MESSAGE);
  if (status === 429) {
    let bucket: 'read' | 'write' | 'rooms' = 'read';
    let perMinute: number | undefined;
    const b = /the (read|write) budget for your IP \((\d+)\/min\)/.exec(body);
    if (b) {
      bucket = b[1] as 'read' | 'write';
      perMinute = Number(b[2]);
    } else if (/room-creation budget/.test(body)) {
      bucket = 'rooms';
    }
    let retryAfterS: number | undefined;
    const r = /retry after:\s*(\d+(?:\.\d+)?)\s*s/i.exec(body);
    if (r) retryAfterS = Number(r[1]);
    if (retryAfterS === undefined || !Number.isFinite(retryAfterS)) {
      const h = headers?.get('retry-after');
      if (h && /^\d+(\.\d+)?$/.test(h.trim())) retryAfterS = Number(h.trim());
    }
    if (retryAfterS === undefined || !Number.isFinite(retryAfterS) || retryAfterS < 0) retryAfterS = 60;
    // A hostile or broken body must not park the watcher for a day.
    retryAfterS = Math.min(retryAfterS, 3600);
    const refusal: Refusal = { kind: 'rate', bucket, retryAfterS };
    if (perMinute !== undefined) refusal.perMinute = perMinute;
    return refusal;
  }
  switch (status) {
    case 400:
    case 408:
      return { kind: 'bad-request', message: firstLine };
    case 403:
      return { kind: 'forbidden', message: firstLine };
    case 409:
      return { kind: 'conflict', message: firstLine };
    case 413:
      return { kind: 'too-large', message: firstLine };
    case 422:
      return { kind: 'duplicate', message: firstLine };
    default:
      return { kind: 'server', status };
  }
}

