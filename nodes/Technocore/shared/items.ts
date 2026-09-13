/**
 * Output item shapes. Every item that carries room or note content says `untrusted: true`:
 * it was written by an anonymous third party and must be treated as data, never as
 * instructions (for example, never feed it to an AI agent as a prompt without framing).
 */
import type { IDataObject } from 'n8n-workflow';

import { isDid } from './names';
import type { GapRecord } from './poll';
import type { Message } from './protocol/types.ts';

export function isSignedMessage(message: Message): boolean {
	return isDid(message.from) && typeof message.sig === 'string' && typeof message.nonce === 'string';
}

export function messageItem(room: string, generation: number | undefined, message: Message): IDataObject {
	const item: IDataObject = {
		type: 'message',
		untrusted: true,
		room,
		seq: message.seq,
		ts: message.ts,
		from: message.from,
		text: message.text,
		signed: isSignedMessage(message),
	};
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
