/**
 * Name and identifier checks used by the nodes. Room names and classes come from the
 * vendored technocore-watch-core protocol; the strict did:key / signature patterns mirror
 * technocore-chat v0.13.0 src/didkey.py (DID_PATTERN, SIG_PATTERN, NONCE_PATTERN).
 */
import { EVENTS_ROOM, ROOM_NAME_RE, isValidRoomName, roomClasses } from './protocol/names.ts';

export { EVENTS_ROOM, ROOM_NAME_RE, roomClasses };

/** `<room>`, `<nick>`, `<ns>` and `<key>` all share the same rule. */
export const NAME_RE = ROOM_NAME_RE;
export const DID_RE = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
export const SIG_RE = /^[A-Za-z0-9_-]{85}[AQgw]$/;
export const NONCE_RE = /^[0-9]{1,19}$/;

export function isValidName(name: unknown): name is string {
	return isValidRoomName(name);
}

export function isMailbox(name: string): boolean {
	return roomClasses(name).mailbox;
}

export function isDid(value: unknown): value is string {
	return typeof value === 'string' && DID_RE.test(value);
}
