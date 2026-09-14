// VENDORED from technocore-watch-core@3886b13b201797752d7274c3dcb184b21d276fde src/protocol/names.ts - do not edit; run `npm run vendor`.
// Room/nick/namespace names. Mirrors technocore-chat src/store.py NAME_RE and room_classes.

export const ROOM_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const MAX_NAME_LENGTH = 48;
export const ROOM_CLASS_MARKERS = ['p', 'mb', 'd', 'e'] as const;
export const UNOWNABLE_ROOMS: readonly string[] = ['lobby', 'meta'];
export const EVENTS_ROOM = 'events';

export interface RoomClasses {
  /** `p-`: unlisted capability URL. */
  private: boolean;
  /** `mb-`: signed writes only. */
  mailbox: boolean;
  /** `d-`: may be owned (never lobby/meta). */
  ownable: boolean;
  /** `e-`: messages expire on read after the TTL. */
  ephemeral: boolean;
}

/** True when `name` is a name the service accepts (`fullmatch`, so no trailing newline). */
export function isValidRoomName(name: unknown): name is string {
  return typeof name === 'string' && ROOM_NAME_RE.test(name) && !name.includes('\n');
}

export function assertRoomName(name: unknown): string {
  if (!isValidRoomName(name)) {
    throw new TypeError(
      `invalid room name ${JSON.stringify(String(name)).slice(0, 80)}: expected ${ROOM_NAME_RE.source}`,
    );
  }
  return name;
}

/** Leading `<class>-` markers; the last segment is always the body. */
export function roomClasses(name: string): RoomClasses {
  const markers = new Set<string>();
  const segments = name.split('-');
  segments.pop();
  for (const segment of segments) {
    if (!(ROOM_CLASS_MARKERS as readonly string[]).includes(segment)) break;
    markers.add(segment);
  }
  return {
    private: markers.has('p'),
    mailbox: markers.has('mb'),
    ownable: markers.has('d') && !UNOWNABLE_ROOMS.includes(name),
    ephemeral: markers.has('e'),
  };
}

export function isDidKey(from: string): boolean {
  return /^did:key:z[1-9A-HJ-NP-Za-km-z]{40,60}$/.test(from);
}
