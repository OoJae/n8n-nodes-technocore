/**
 * Bounded reader for `GET /r/<room>/export` (the retained ring as raw JSONL, oldest first).
 *
 * The export is the only way to fetch messages older than a tail read's window, and it can
 * be up to the server's 10 MiB room cap. The reader stops as soon as it has everything
 * before `beforeSeq`, or when the byte or time budget runs out, and keeps only records in
 * (afterSeq, beforeSeq).
 */
import { parseExportLine } from './protocol/parse.ts';
import type { Message } from './protocol/types.ts';

export interface ExportScan {
	/** Records with afterSeq < seq < beforeSeq, ascending. */
	records: Message[];
	/** Seq of the first parseable record in the export (the oldest retained). */
	oldestSeq?: number;
	/** Highest seq the reader saw before stopping. */
	lastSeenSeq?: number;
	/** True when the byte or time budget cut the scan short. */
	bounded: boolean;
	bytes: number;
}

export interface ExportScanOptions {
	afterSeq: number;
	beforeSeq: number;
	maxBytes: number;
	/** Absolute deadline in ms (Date.now() clock); undefined for no time budget. */
	deadline?: number;
	now?: () => number;
}

type Chunk = string | Uint8Array;

function isAsyncIterable(value: unknown): value is AsyncIterable<Chunk> {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
	);
}

function destroy(body: unknown): void {
	const candidate = body as { destroy?: () => void };
	if (candidate && typeof candidate.destroy === 'function') candidate.destroy();
}

export async function scanExport(body: unknown, options: ExportScanOptions): Promise<ExportScan> {
	const now = options.now ?? Date.now;
	const scan: ExportScan = { records: [], bounded: false, bytes: 0 };
	let pending = Buffer.alloc(0);
	let done = false;

	const consumeLine = (line: Buffer): void => {
		const record = parseExportLine(line.toString('utf8'));
		if (!record) return;
		if (scan.oldestSeq === undefined) scan.oldestSeq = record.seq;
		scan.lastSeenSeq = record.seq;
		if (record.seq >= options.beforeSeq) {
			done = true;
			return;
		}
		if (record.seq > options.afterSeq) scan.records.push(record);
	};

	const consumeChunk = (chunk: Chunk): void => {
		const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
		scan.bytes += bytes.length;
		pending = pending.length ? Buffer.concat([pending, bytes]) : bytes;
		let newline = pending.indexOf(0x0a);
		while (newline >= 0 && !done) {
			consumeLine(pending.subarray(0, newline));
			pending = pending.subarray(newline + 1);
			newline = pending.indexOf(0x0a);
		}
	};

	if (isAsyncIterable(body)) {
		try {
			for await (const chunk of body) {
				consumeChunk(chunk);
				if (done) break;
				if (scan.bytes > options.maxBytes || (options.deadline !== undefined && now() > options.deadline)) {
					scan.bounded = true;
					break;
				}
			}
		} finally {
			destroy(body);
		}
	} else {
		const text = typeof body === 'string' ? body : Buffer.isBuffer(body) ? body.toString('utf8') : '';
		const bytes = Buffer.byteLength(text, 'utf8');
		if (bytes > options.maxBytes) {
			// Already in memory; still honour the budget by only scanning the allowed prefix.
			const prefix = Buffer.from(text, 'utf8').subarray(0, options.maxBytes);
			const cut = prefix.lastIndexOf(0x0a);
			consumeChunk(cut >= 0 ? prefix.subarray(0, cut + 1) : Buffer.alloc(0));
			scan.bytes = bytes;
			if (!done) scan.bounded = true;
		} else {
			consumeChunk(text);
		}
	}
	if (!done && !scan.bounded && pending.length) consumeLine(pending);
	scan.records.sort((a, b) => a.seq - b.seq);
	return scan;
}
