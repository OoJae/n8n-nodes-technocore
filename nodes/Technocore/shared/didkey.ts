/**
 * Ed25519 did:key helpers, byte-compatible with technocore-chat v0.13.0 scripts/sign.py and
 * mcp/src/technocore_mcp/signing.py:
 *
 *   seed (32 bytes) -> Ed25519 key -> did:key:z + base58btc(0xed01 || public key)
 *   signature = base64url(Ed25519(UTF-8 canonical string)), unpadded, 86 characters
 *
 * Only node:crypto is used (an import n8n Cloud allows). Error messages never contain key
 * material.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

import { DID_RE } from './names';

/** DER prefix of a PKCS#8 Ed25519 private key; the 32 seed bytes follow it. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
/** DER prefix of an SPKI Ed25519 public key; the 32 key bytes follow it. */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MULTICODEC_ED25519 = Buffer.from([0xed, 0x01]);
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export class SigningKeyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SigningKeyError';
	}
}

/**
 * The seed as stored in the credential: exactly 64 hexadecimal characters (surrounding
 * whitespace from a paste is ignored). Anything else is refused rather than hashed, unlike
 * sign.py's passphrase fallback, so a typo can never silently become a different identity.
 */
export function parseSeedHex(value: unknown): Buffer {
	const text = typeof value === 'string' ? value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '') : '';
	if (!/^[0-9a-fA-F]{64}$/.test(text)) {
		throw new SigningKeyError(
			'The Technocore signing key must be a 32-byte Ed25519 seed written as exactly 64 hexadecimal characters.',
		);
	}
	return Buffer.from(text, 'hex');
}

export function base58btc(bytes: Buffer): string {
	let n = BigInt('0x' + (bytes.length ? bytes.toString('hex') : '0'));
	const base = BigInt(58);
	const zero = BigInt(0);
	let out = '';
	while (n > zero) {
		const rem = Number(n % base);
		n = n / base;
		out = B58[rem] + out;
	}
	for (const byte of bytes) {
		if (byte !== 0) break;
		out = '1' + out;
	}
	return out;
}

export function unbase58btc(text: string): Buffer {
	let n = BigInt(0);
	const base = BigInt(58);
	for (const ch of text) {
		const digit = B58.indexOf(ch);
		if (digit < 0) throw new SigningKeyError('Not a base58btc string');
		n = n * base + BigInt(digit);
	}
	let hex = n.toString(16);
	if (hex.length % 2) hex = '0' + hex;
	return n === BigInt(0) ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
}

export interface Identity {
	did: string;
	privateKey: KeyObject;
	publicKey: Buffer;
}

export function identityFromSeed(seed: Buffer): Identity {
	if (seed.length !== 32) throw new SigningKeyError('An Ed25519 seed is exactly 32 bytes.');
	const privateKey = createPrivateKey({
		key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
		format: 'der',
		type: 'pkcs8',
	});
	const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
	const publicKey = Buffer.from(spki.subarray(SPKI_ED25519_PREFIX.length));
	const did = `did:key:z${base58btc(Buffer.concat([MULTICODEC_ED25519, publicKey]))}`;
	if (!DID_RE.test(did)) throw new SigningKeyError('Internal error: derived did:key has an unexpected shape.');
	return { did, privateKey, publicKey };
}

/** Ed25519 over the UTF-8 bytes; 86 unpadded base64url characters. */
export function signCanonical(privateKey: KeyObject, canonical: string): string {
	return sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64url');
}

export function publicKeyFromDid(did: string): Buffer {
	if (!DID_RE.test(did)) throw new SigningKeyError('Not an Ed25519 did:key (did:key:z6Mk...).');
	const decoded = unbase58btc(did.slice('did:key:z'.length));
	if (decoded.length !== 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) {
		throw new SigningKeyError('Only ed25519-pub did:key identifiers are accepted.');
	}
	return decoded.subarray(2);
}

export function verifyCanonical(did: string, signature: string, canonical: string): boolean {
	let publicKey: Buffer;
	try {
		publicKey = publicKeyFromDid(did);
	} catch {
		return false;
	}
	if (!/^[A-Za-z0-9_-]{85}[AQgw]$/.test(signature)) return false;
	const key = createPublicKey({
		key: Buffer.concat([SPKI_ED25519_PREFIX, publicKey]),
		format: 'der',
		type: 'spki',
	});
	return verify(null, Buffer.from(canonical, 'utf8'), key, Buffer.from(signature, 'base64url'));
}

/** Where a DID's identity note lives: /kv/did-<fp[:2]>/<fp[2:]>, fp = sha256(did)[:16]. */
export function identityNotePath(did: string): { ns: string; key: string } {
	const fingerprint = createHash('sha256').update(did, 'utf8').digest('hex').slice(0, 16);
	return { ns: `did-${fingerprint.slice(0, 2)}`, key: fingerprint.slice(2) };
}

export function canonicalMessage(room: string, nonce: string, sweptText: string): string {
	return `${room}|${nonce}|${sweptText}`;
}
