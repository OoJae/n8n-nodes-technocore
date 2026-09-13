/**
 * Output item shapes. Every item that carries room or note content says `untrusted: true`:
 * it was written by an anonymous third party and must be treated as data, never as
 * instructions (for example, never feed it to an AI agent as a prompt without framing).
 */
import type { IDataObject } from 'n8n-workflow';

import { canonicalMessage, verifyCanonical } from './didkey';
import { isDid } from './names';
import type { GapRecord } from './poll';
import type { Message } from './protocol/types.ts';

/** The record carries the fields of a signed message (it does not say they are valid). */
export function claimsSignature(message: Message): boolean {
	return (
		isDid(message.from) && typeof message.sig === 'string' && typeof message.nonce === 'string'
	);
}

/**
 * True only when the record's Ed25519 signature verifies against its did:key over
 * `room|nonce|text`. Checked here rather than trusted from the origin, so a proxy, mirror
 * or misbehaving origin cannot make a record look signed by someone else.
 */
export function isSignedMessage(room: string, message: Message): boolean {
	return (
		claimsSignature(message) &&
		verifyCanonical(
			message.from,
			message.sig as string,
			canonicalMessage(room, message.nonce as string, message.text),
		)
	);
}

export function messageItem(
	room: string,
	generation: number | undefined,
	message: Message,
): IDataObject {
	const signed = isSignedMessage(room, message);
	const item: IDataObject = {
		type: 'message',
		untrusted: true,
		room,
		seq: message.seq,
		ts: message.ts,
		from: message.from,
		text: message.text,
		signed,
	};
	// A did:key sender with a signature that does not verify: forged, or altered on the way.
	if (!signed && claimsSignature(message)) item.signatureInvalid = true;
	if (generation !== undefined) item.generation = generation;
	if (message.nonce !== undefined) item.nonce = message.nonce;
	if (message.sig !== undefined) item.sig = message.sig;
	return item;
}

export function gapItem(room: string, generation: number | undefined, gap: GapRecord): IDataObject {
	const item: IDataObject = {
		type: 'gap',
		room,
		from: gap.from,
		to: gap.to,
		count: gap.to - gap.from + 1,
		reason: gap.reason,
	};
	if (generation !== undefined) item.generation = generation;
	return item;
}
