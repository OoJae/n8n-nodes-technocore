import { describe, expect, it } from 'vitest';

import {
	base58btc,
	canonicalMessage,
	identityFromSeed,
	identityNotePath,
	parseSeedHex,
	publicKeyFromDid,
	signCanonical,
	unbase58btc,
	verifyCanonical,
} from '../../nodes/Technocore/shared/didkey';
import { sweep } from '../../nodes/Technocore/shared/sweep';
import { KAT_ITEMS, TEST_SEEDS } from '../fixtures/corpus.mjs';
import kat from '../fixtures/kat.json';

// RFC 8032 section 7.1, TEST 1 (public test vector; allow-listed in .secret-scan-allow.json).
const RFC8032_TEST1_SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const RFC8032_TEST1_PUBLIC = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const RFC8032_TEST1_SIGNATURE =
	'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';

describe('Ed25519 known answers', () => {
	it('matches RFC 8032 TEST 1 (public key and signature over the empty message)', () => {
		const identity = identityFromSeed(Buffer.from(RFC8032_TEST1_SEED, 'hex'));
		expect(identity.publicKey.toString('hex')).toBe(RFC8032_TEST1_PUBLIC);
		const signature = Buffer.from(signCanonical(identity.privateKey, ''), 'base64url');
		expect(signature.toString('hex')).toBe(RFC8032_TEST1_SIGNATURE);
		expect(identity.did.startsWith('did:key:z6Mk')).toBe(true);
	});

	for (const [label, seedHex] of Object.entries(TEST_SEEDS)) {
		describe(`TEST seed ${label} vs the Python signer fixture`, () => {
			const expected = kat.seeds[label as keyof typeof kat.seeds];
			const identity = identityFromSeed(parseSeedHex(seedHex));

			it('derives the same did:key as scripts/sign.py did', () => {
				expect(identity.did).toBe(expected.did);
				expect(identity.did).toHaveLength(56);
			});

			it('derives the same identity note path as scripts/sign.py note', () => {
				const { ns, key } = identityNotePath(identity.did);
				expect(`/kv/${ns}/${key}`).toBe(expected.notePath);
			});

			it('produces byte-identical signatures to scripts/sign.py say (Ed25519 is deterministic)', () => {
				expect(expected.signatures).toHaveLength(KAT_ITEMS.length);
				expected.signatures.forEach((vector, index) => {
					const item = KAT_ITEMS[index];
					const swept = sweep(item.text);
					if ('refused' in vector && vector.refused) {
						expect(swept).toBe('');
						return;
					}
					const withSig = vector as { swept: string; sig: string };
					expect(swept).toBe(withSig.swept);
					const sig = signCanonical(identity.privateKey, canonicalMessage(item.room, item.nonce, swept));
					expect(sig).toBe(withSig.sig);
					expect(sig).toMatch(/^[A-Za-z0-9_-]{85}[AQgw]$/);
					expect(verifyCanonical(identity.did, sig, `${item.room}|${item.nonce}|${swept}`)).toBe(true);
				});
			});
		});
	}
});

describe('seed parsing', () => {
	it('accepts exactly 64 hex characters, tolerating surrounding paste whitespace', () => {
		expect(parseSeedHex(TEST_SEEDS.seed01).length).toBe(32);
		expect(parseSeedHex(`  ${TEST_SEEDS.seed01.toUpperCase()}\n`).length).toBe(32);
	});

	it.each([
		['empty', ''],
		['63 chars', TEST_SEEDS.seed01.slice(1)],
		['65 chars', `${TEST_SEEDS.seed01}0`],
		['non-hex', `${TEST_SEEDS.seed01.slice(2)}zz`],
		['passphrase', 'correct horse battery staple'],
		['base64url', Buffer.alloc(32, 1).toString('base64url')],
		['inner whitespace', `${TEST_SEEDS.seed01.slice(0, 32)} ${TEST_SEEDS.seed01.slice(32)}`],
		['number', 12345],
		['undefined', undefined],
	])('refuses %s without echoing the value', (_label, value) => {
		let message = '';
		try {
			parseSeedHex(value);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toMatch(/64 hexadecimal characters/);
		if (typeof value === 'string' && value.length > 8) expect(message).not.toContain(value.trim().slice(0, 16));
	});
});

describe('did:key encoding', () => {
	it('round-trips base58btc including leading zero bytes', () => {
		const bytes = Buffer.from([0, 0, 1, 2, 3, 255]);
		expect(unbase58btc(base58btc(bytes)).toString('hex')).toBe(bytes.subarray(2).toString('hex'));
		expect(base58btc(bytes).startsWith('11')).toBe(true);
	});

	it('recovers the public key from a did and rejects malformed dids', () => {
		const identity = identityFromSeed(parseSeedHex(TEST_SEEDS.seed02));
		expect(publicKeyFromDid(identity.did).equals(identity.publicKey)).toBe(true);
		expect(() => publicKeyFromDid('did:key:z6MkNOPE')).toThrow();
		expect(verifyCanonical('did:key:z6MkNOPE', 'x', 'y')).toBe(false);
	});

	it('rejects a signature for different text, room or nonce', () => {
		const identity = identityFromSeed(parseSeedHex(TEST_SEEDS.seed01));
		const sig = signCanonical(identity.privateKey, 'lobby|5|hello');
		expect(verifyCanonical(identity.did, sig, 'lobby|5|hello')).toBe(true);
		expect(verifyCanonical(identity.did, sig, 'lobby|6|hello')).toBe(false);
		expect(verifyCanonical(identity.did, sig, 'meta|5|hello')).toBe(false);
		expect(verifyCanonical(identity.did, sig, 'lobby|5|hello!')).toBe(false);
		const other = identityFromSeed(parseSeedHex(TEST_SEEDS.seed02));
		expect(verifyCanonical(other.did, sig, 'lobby|5|hello')).toBe(false);
	});
});
