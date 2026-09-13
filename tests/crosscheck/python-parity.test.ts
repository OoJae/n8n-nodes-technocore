/**
 * Live cross-checks against the upstream Python implementations (technocore-chat checkout):
 * scripts/sign.py (the official signer) and src/store.py clean_text (the server's sweep).
 * Only public TEST seeds are used.
 */
import { describe, expect, it } from 'vitest';

import { canonicalMessage, identityFromSeed, parseSeedHex, signCanonical } from '../../nodes/Technocore/shared/didkey';
import { sweep } from '../../nodes/Technocore/shared/sweep';
import { INVISIBLE_RANGES, SPACE_RANGES } from '../../nodes/Technocore/shared/sweep-table';
import { KAT_ITEMS, SWEEP_CORPUS, TEST_SEEDS, cp, fromCodePoints, toCodePoints } from '../fixtures/corpus.mjs';
import kat from '../fixtures/kat.json';
import { readRepoFile } from '../harness/repo-files.mjs';
import { generateSweepTable, hasCheckout, pythonBatch, signPy } from '../harness/python.mjs';

if (!hasCheckout()) {
	throw new Error(
		'crosscheck tests need a technocore-chat checkout (set TECHNOCORE_CHECKOUT) and uv; run `npm run test:unit` for the offline suite',
	);
}

/** Deterministic PRNG so a failure is reproducible. */
function mulberry32(seed: number) {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe('scripts/sign.py CLI (uv run scripts/sign.py --seed <TEST seed> ...)', () => {
	for (const [label, seedHex] of Object.entries(TEST_SEEDS)) {
		const identity = identityFromSeed(parseSeedHex(seedHex));

		it(`${label}: did and note path match`, () => {
			const [did] = signPy(seedHex, ['did']);
			expect(identity.did).toBe(did);
			const [notePath] = signPy(seedHex, ['note', did]);
			expect(notePath).toBe(kat.seeds[label as keyof typeof kat.seeds].notePath);
		});

		it(`${label}: say signatures match for argv-safe texts`, () => {
			// argv cannot carry lone surrogates or NUL; those go through the batch check below.
			for (const item of KAT_ITEMS.filter((i) => !i.text.includes(cp(0)))) {
				const swept = sweep(item.text);
				if (!swept) continue;
				const [did, sig] = signPy(seedHex, ['say', item.room, item.nonce, item.text]);
				expect(did).toBe(identity.did);
				expect(signCanonical(identity.privateKey, canonicalMessage(item.room, item.nonce, swept))).toBe(sig);
			}
		});
	}

	it('refuses an empty-after-sweep text exactly where the JS sweep is empty', () => {
		expect(() => signPy(TEST_SEEDS.seed01, ['say', 'lobby', '1', `${cp(0x200d)} `])).toThrow(/nothing visible/);
		expect(sweep(`${cp(0x200d)} `)).toBe('');
	});
});

describe('sign.py module batch (every KAT item, including hostile Unicode)', () => {
	it('matches JS signatures and the committed fixture', () => {
		for (const [label, seedHex] of Object.entries(TEST_SEEDS)) {
			const identity = identityFromSeed(parseSeedHex(seedHex));
			const batch = pythonBatch({
				op: 'sign',
				seedHex,
				items: KAT_ITEMS.map((item) => ({ ...item, text: toCodePoints(item.text) })),
			});
			expect(batch.did).toBe(identity.did);
			const fixture = kat.seeds[label as keyof typeof kat.seeds].signatures;
			batch.results.forEach((result: { swept: number[]; sig: string } | null, index: number) => {
				const item = KAT_ITEMS[index];
				const swept = sweep(item.text);
				if (result === null) {
					expect(swept).toBe('');
					expect((fixture[index] as { refused?: boolean }).refused).toBe(true);
					return;
				}
				expect(swept).toBe(fromCodePoints(result.swept));
				const sig = signCanonical(identity.privateKey, canonicalMessage(item.room, item.nonce, swept));
				expect(sig).toBe(result.sig);
				expect((fixture[index] as { sig: string }).sig).toBe(result.sig);
			});
		}
	});
});

describe('sweep parity with the server (store.clean_text)', () => {
	it('regenerating the Unicode table from the server Python reproduces the committed file', () => {
		expect(generateSweepTable()).toBe(readRepoFile('nodes/Technocore/shared/sweep-table.ts'));
	});

	it('agrees on the hostile corpus', () => {
		const swept = pythonBatch({ op: 'sweep', texts: SWEEP_CORPUS.map(toCodePoints) }).swept as (number[] | null)[];
		SWEEP_CORPUS.forEach((text, index) => {
			const js = sweep(text);
			expect(js === '' ? null : js, `corpus #${index}`).toBe(swept[index] === null ? null : fromCodePoints(swept[index] as number[]));
		});
	});

	it('agrees on 3000 fuzzed strings built around every table boundary, surrogates and all planes', () => {
		const random = mulberry32(20260913);
		const pool: number[] = [0x20, 0x41, 0x7a, 0xe9, 0x4e2d, 0x1f600, 0xd800, 0xdbff, 0xdc00, 0xdfff];
		for (const [a, b] of [...INVISIBLE_RANGES, ...SPACE_RANGES]) {
			for (const point of [a - 1, a, b, b + 1]) if (point >= 0 && point <= 0x10ffff) pool.push(point);
		}
		const texts: string[] = [];
		for (let i = 0; i < 3000; i++) {
			const length = 1 + Math.floor(random() * 12);
			const points: number[] = [];
			for (let j = 0; j < length; j++) {
				points.push(random() < 0.7 ? pool[Math.floor(random() * pool.length)] : Math.floor(random() * 0x110000));
			}
			texts.push(cp(...points));
		}
		const swept = pythonBatch({ op: 'sweep', texts: texts.map(toCodePoints) }).swept as (number[] | null)[];
		const mismatches = texts
			.map((text, index) => ({ index, js: sweep(text), py: swept[index] === null ? '' : fromCodePoints(swept[index] as number[]) }))
			.filter((row) => row.js !== row.py)
			.map((row) => ({ index: row.index, input: toCodePoints(texts[row.index]).map((p: number) => p.toString(16)) }));
		expect(mismatches).toEqual([]);
	});
});
