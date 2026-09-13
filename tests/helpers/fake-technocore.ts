/**
 * An in-memory model of one Technocore room, mirroring technocore-chat v0.13.0's
 * read_messages (newest `limit` messages with seq > since, oldest first), export_room (the
 * retained ring as JSONL, X-Room-Generation header) and room generations. Used to drive the
 * trigger's poll() through realistic scenarios without a server.
 */
import type { Message } from '../../nodes/Technocore/shared/protocol/types';

export interface FakeResponse {
	status: number;
	body: string | AsyncIterable<Buffer>;
	headers?: Record<string, string>;
}

export const TEST_TS = '2026-09-13T12:00:00.000000+00:00';

/** JSON with nonces as bare integer literals, like the server's json.dumps output. */
export function serverJson(value: unknown, indent?: number): string {
	return JSON.stringify(value, null, indent).replace(/"nonce": ?"([0-9]{1,19})"/g, (match, digits) =>
		match.includes('": "') ? `"nonce": ${digits}` : `"nonce":${digits}`,
	);
}

export class FakeRoom {
	generation = 0;
	/** Retained records, oldest first. */
	records: Message[] = [];
	private lastSeq = 0;
	private recreatePending = false;

	constructor(readonly name: string) {}

	post(from: string, text: string, extra: Partial<Message> = {}): Message {
		if (this.generation === 0 || this.recreatePending) {
			this.generation += 1;
			this.recreatePending = false;
		}
		this.lastSeq += 1;
		const record: Message = { seq: this.lastSeq, ts: TEST_TS, from, text, ...extra };
		this.records.push(record);
		return record;
	}

	postMany(count: number, prefix = 'msg'): void {
		for (let i = 0; i < count; i++) this.post('tester', `${prefix} ${this.lastSeq + 1}`);
	}

	/** The ring dropped everything older than `seq`. */
	dropBefore(seq: number): void {
		this.records = this.records.filter((record) => record.seq >= seq);
	}

	/** A torn record: the line is unreadable, its seq is a hole. */
	tear(seq: number): void {
		this.records = this.records.filter((record) => record.seq !== seq);
	}

	/** Reaped with the seq floor kept: the next post recreates it and seq continues. */
	reapKeepingFloor(): void {
		this.records = [];
		this.recreatePending = true;
	}

	/** File and floor lost: the next post recreates it and seq restarts at 1. */
	reapLosingFloor(): void {
		this.records = [];
		this.lastSeq = 0;
		this.recreatePending = true;
	}

	read(since: number | undefined, limit: number): string {
		const bounded = Math.max(1, Math.min(limit, 200));
		const newer = this.records.filter((record) => since === undefined || record.seq > since);
		const window = newer.slice(-bounded);
		const view = {
			room: this.name,
			count: window.length,
			first_seq: window.length ? window[0].seq : null,
			last_seq: window.length ? window[window.length - 1].seq : since ?? 0,
			generation: this.generation,
			messages: window,
		};
		return serverJson(view, 1) + '\n';
	}

	exportBody(): string {
		return this.records.map((record) => serverJson(record)).join('\n') + (this.records.length ? '\n' : '');
	}
}

export async function* chunked(text: string, size = 1024): AsyncIterable<Buffer> {
	const bytes = Buffer.from(text, 'utf8');
	for (let offset = 0; offset < bytes.length; offset += size) {
		yield bytes.subarray(offset, offset + size);
	}
}

export const RATE_LIMITED_BODY =
	'429 rate limited: the read budget for your IP (600/min) is spent.\nretry after: 7s - the bucket refills continuously.\n';

export function routeRoom(room: FakeRoom, url: string, method: string): FakeResponse {
	const parsed = new URL(url);
	if (method === 'GET' && parsed.pathname === `/r/${room.name}`) {
		const since = parsed.searchParams.get('since');
		const limit = Number(parsed.searchParams.get('limit') ?? '50');
		return {
			status: 200,
			body: room.read(since === null ? undefined : Number(since), limit),
			headers: { 'content-type': 'application/json' },
		};
	}
	if (method === 'GET' && parsed.pathname === `/r/${room.name}/export`) {
		return {
			status: 200,
			body: chunked(room.exportBody(), 700),
			headers: { 'x-room-generation': String(room.generation) },
		};
	}
	return { status: 404, body: `404 no route for ${method} ${parsed.pathname}\n` };
}
