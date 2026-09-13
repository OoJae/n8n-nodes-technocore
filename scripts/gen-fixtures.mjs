#!/usr/bin/env node
// Regenerates tests/fixtures/kat.json from the upstream Python signer (scripts/sign.py) and
// the server's own sweep (src/store.py clean_text), using public TEST seeds only.
//
//   node scripts/gen-fixtures.mjs     (needs uv and a technocore-chat checkout; see tests/harness/python.mjs)
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { KAT_ITEMS, TEST_SEEDS, SWEEP_CORPUS, asciiJson, fromCodePoints, toCodePoints } from '../tests/fixtures/corpus.mjs';
import { PACKAGE_ROOT, pythonBatch, signPy } from '../tests/harness/python.mjs';

const fixture = { generatedBy: 'scripts/gen-fixtures.mjs', upstream: 'technocore-chat v0.13.0 (20a4457) scripts/sign.py + src/store.py', seeds: {} };

for (const [label, seedHex] of Object.entries(TEST_SEEDS)) {
	const [did] = signPy(seedHex, ['did']);
	const [notePath] = signPy(seedHex, ['note', did]);
	const batch = pythonBatch({
		op: 'sign',
		seedHex,
		items: KAT_ITEMS.map((item) => ({ ...item, text: toCodePoints(item.text) })),
	});
	if (batch.did !== did) throw new Error('sign.py CLI and module disagree on the did');
	fixture.seeds[label] = {
		did,
		notePath,
		signatures: batch.results.map((result, index) =>
			result === null
				? { room: KAT_ITEMS[index].room, nonce: KAT_ITEMS[index].nonce, refused: true }
				: { room: KAT_ITEMS[index].room, nonce: KAT_ITEMS[index].nonce, swept: fromCodePoints(result.swept), sig: result.sig },
		),
	};
}

const swept = pythonBatch({ op: 'sweep', texts: SWEEP_CORPUS.map(toCodePoints) }).swept;
// Inputs stay in tests/fixtures/corpus.mjs (some are lone surrogates, which JSON tooling
// handles inconsistently); the fixture records the server's output per corpus index.
fixture.sweep = SWEEP_CORPUS.map((_text, index) => ({
	index,
	swept: swept[index] === null ? null : fromCodePoints(swept[index]),
}));

writeFileSync(path.join(PACKAGE_ROOT, 'tests', 'fixtures', 'kat.json'), `${asciiJson(fixture)}\n`);
console.log('wrote tests/fixtures/kat.json');
