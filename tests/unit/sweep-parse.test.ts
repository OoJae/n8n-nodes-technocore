import { describe, expect, it } from 'vitest';

import { isDid, isMailbox, isValidName, roomClasses } from '../../nodes/Technocore/shared/names';
import { sweepText as vendoredSweep } from '../../nodes/Technocore/shared/protocol/sweep';
import {
	classifyRefusal as parseRefusal,
	parseExportLine,
	parseReadView,
	quoteNonceIntegers as quoteNonceNumbers,
	parseExpectedCanonical,
	parseNoteBody,
	parseRoomReply,
	parseStaleNonce,
} from '../../nodes/Technocore/shared/responses';
import {
	codePointLength,
	isInvisible,
	isPythonSpace,
	sweep,
} from '../../nodes/Technocore/shared/sweep';
import {
	INVISIBLE_RANGES,
	SPACE_RANGES,
	UNICODE_VERSION,
} from '../../nodes/Technocore/shared/sweep-table';
import { SWEEP_CORPUS, cp } from '../fixtures/corpus.mjs';
import kat from '../fixtures/kat.json';

describe('sweep', () => {
	it('matches the server sweep (store.clean_text) on the hostile corpus fixture', () => {
		expect(kat.sweep).toHaveLength(SWEEP_CORPUS.length);
		kat.sweep.forEach((vector, index) => {
			const actual = sweep(SWEEP_CORPUS[index]);
			// The server refuses an empty result; the fixture records that as null.
			expect(actual === '' ? null : actual).toBe(vector.swept);
		});
	});

	it('replaces invisibles with a space and trims like Python str.strip()', () => {
		expect(sweep(`a${cp(0x200d)}b`)).toBe('a b');
		expect(sweep(`${cp(0xa0)} x ${cp(0x3000)}`)).toBe('x');
		expect(sweep(`x${cp(0xd800)}`)).toBe('x');
		expect(sweep(cp(0x1f600))).toBe(cp(0x1f600));
	});

	it('agrees with the vendored technocore-watch-core sweepText on the corpus under this Node.js', () => {
		// The vendored sweep uses the runtime's Unicode tables; this package signs with the
		// frozen server table instead. Any disagreement here is a code point where the runtime
		// Unicode version differs from the server's (CPython 3.12, Unicode 15.0).
		const disagreements = SWEEP_CORPUS.filter((text) => vendoredSweep(text) !== sweep(text));
		expect(disagreements).toEqual([]);
	});

	it('is idempotent', () => {
		for (const text of SWEEP_CORPUS) expect(sweep(sweep(text))).toBe(sweep(text));
	});

	it('counts code points like Python len()', () => {
		expect(codePointLength(cp(0x1f600))).toBe(1);
		expect(codePointLength(`a${cp(0xd800)}b`)).toBe(3);
	});

	it('uses a sorted, non-overlapping table frozen from the server Unicode version', () => {
		expect(UNICODE_VERSION).toBe('15.0.0');
		for (const table of [INVISIBLE_RANGES, SPACE_RANGES]) {
			for (let i = 0; i < table.length; i++) {
				expect(table[i][0]).toBeLessThanOrEqual(table[i][1]);
				if (i > 0) expect(table[i][0]).toBeGreaterThan(table[i - 1][1] + 0);
			}
		}
		expect(isInvisible(0x200d)).toBe(true);
		expect(isInvisible(0x41)).toBe(false);
		expect(isPythonSpace(0x3000)).toBe(true);
		expect(isPythonSpace(0x200b)).toBe(false);
	});
});

describe('names', () => {
	it('mirrors NAME_RE and the room classes', () => {
		expect(isValidName('lobby')).toBe(true);
		expect(isValidName('a'.repeat(48))).toBe(true);
		expect(isValidName('a'.repeat(49))).toBe(false);
		expect(isValidName('Lobby')).toBe(false);
		expect(isValidName('-x')).toBe(false);
		expect(isValidName('lobby\n')).toBe(false);
		expect(isValidName('a b')).toBe(false);
		expect(roomClasses('mb-p-x')).toEqual({
			private: true,
			mailbox: true,
			ownable: false,
			ephemeral: false,
		});
		expect(roomClasses('pastel')).toEqual({
			private: false,
			mailbox: false,
			ownable: false,
			ephemeral: false,
		});
		expect(isMailbox('mb-p-x')).toBe(true);
		expect(roomClasses('mb-p-x').private).toBe(true);
		expect(roomClasses('d-room').ownable).toBe(true);
		expect(roomClasses('lobby').ownable).toBe(false);
		expect(isDid('did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX')).toBe(true);
		expect(isDid('did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfL')).toBe(false);
	});
});

describe('bigint-safe parsing', () => {
	it('quotes nonce integers only where nonce is a key', () => {
		const body = '{"text": "say \\"nonce\\": 123", "nonce": 9223372036854775807, "x": {"nonce":1}}';
		expect(JSON.parse(quoteNonceNumbers(body))).toEqual({
			text: 'say "nonce": 123',
			nonce: '9223372036854775807',
			x: { nonce: '1' },
		});
		expect(quoteNonceNumbers('{"a": "nonce", "b": 5}')).toBe('{"a": "nonce", "b": 5}');
	});

	it('parses a read view with a 19-digit nonce and a text that imitates JSON', () => {
		const body =
			'{\n "room": "lobby",\n "count": 1,\n "first_seq": 3,\n "last_seq": 3,\n "generation": 2,\n "messages": [\n  {\n   "seq": 3,\n   "ts": "t",\n   "from": "did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX",\n   "text": "{\\"nonce\\": 42}",\n   "nonce": 1234567890123456789,\n   "sig": "s"\n  }\n ]\n}\n';
		const view = parseReadView(body);
		expect(view.generation).toBe(2);
		expect(view.messages[0].nonce).toBe('1234567890123456789');
		expect(view.messages[0].text).toBe('{"nonce": 42}');
	});

	it('parses the posted record of a write reply', () => {
		const body =
			'{"room": "lobby", "count": 1, "first_seq": 9, "last_seq": 9, "generation": 1, "messages": [{"seq": 9, "ts": "t", "from": "a", "text": "b"}], "posted": {"seq": 9, "ts": "t", "from": "did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX", "text": "b", "nonce": 9999999999999999999, "sig": "s"}}';
		const reply = parseRoomReply(body);
		expect(reply.view.last_seq).toBe(9);
		expect(reply.posted?.nonce).toBe('9999999999999999999');
	});

	it('skips torn export lines', () => {
		expect(parseExportLine('{"seq":1,"ts":"t","from":"a","text":"b"}')).toMatchObject({ seq: 1 });
		expect(parseExportLine('{"seq":2,"ts":"t","fro')).toBeNull();
		expect(parseExportLine('')).toBeNull();
	});

	it('rejects bodies that are not a room view', () => {
		expect(() => parseReadView('nope')).toThrow(/not a JSON object/);
		expect(() => parseReadView('{"room":"x"}')).toThrow();
	});
});

describe('refusals', () => {
	it('reads the 429 bucket, budget and retry from body and header', () => {
		const body =
			'429 rate limited: the read budget for your IP (600/min) is spent.\nretry after: 4s - the bucket refills continuously\n';
		expect(parseRefusal(429, body, { 'Retry-After': '9' })).toEqual({
			kind: 'rate',
			status: 429,
			bucket: 'read',
			perMinute: 600,
			retryAfterS: 9,
			message: '429 rate limited: the read budget for your IP (600/min) is spent.',
		});
		expect(parseRefusal(429, body)).toMatchObject({ retryAfterS: 4 });
		expect(parseRefusal(429, '429 room-creation budget spent: ...')).toMatchObject({
			bucket: 'rooms',
		});
	});

	it('classifies the other statuses', () => {
		expect(parseRefusal(403, '403 x').kind).toBe('forbidden');
		expect(parseRefusal(409, '409 x').kind).toBe('conflict');
		expect(parseRefusal(422, '422 duplicate').kind).toBe('duplicate');
		expect(parseRefusal(500, '').message).toBe('HTTP 500');
	});

	it('extracts the stale nonce and the expected canonical string', () => {
		expect(
			parseStaleNonce(
				'400 nonce 5 is not greater than 1726221600123, the last one this key used in /r/lobby - count up',
			),
		).toBe('1726221600123');
		expect(parseStaleNonce('400 bad name')).toBeNull();
		expect(
			parseExpectedCanonical(
				'403 signature does not verify for did.\nit must cover exactly this string, UTF-8, Ed25519, base64url:\nlobby|1|hi\n',
			),
		).toBe('lobby|1|hi');
	});

	it('extracts a note value from the banner-framed body, ignoring a budget footer', () => {
		const banner = '!! UNTRUSTED CONTENT - the lines below were written by other agents.';
		expect(parseNoteBody(`${banner}\n\nvalue here\n`)).toBe('value here');
		expect(parseNoteBody(`${banner}\n\nv\n# budget: 5 of 600 reads left\n`)).toBe('v');
		expect(() => parseNoteBody('value only')).toThrow();
	});
});
