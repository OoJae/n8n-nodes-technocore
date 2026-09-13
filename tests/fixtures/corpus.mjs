// Shared test inputs. Seeds are PUBLIC TEST-ONLY values (never a real identity); they are
// built at runtime so no 64-hex literal sits in source. Every non-ASCII character is built
// from its code point so the hostile corpus stays ASCII-only and reviewable.

export const TEST_SEEDS = {
	// TEST-ONLY: 32 bytes of 0x01
	seed01: '01'.repeat(32),
	// TEST-ONLY: 32 bytes of 0x02
	seed02: '02'.repeat(32),
};

/** String from code points; lone surrogates allowed (fromCharCode for 0xd800-0xdfff). */
export const cp = (...points) =>
	points.map((p) => (p >= 0xd800 && p <= 0xdfff ? String.fromCharCode(p) : String.fromCodePoint(p))).join('');

const ZWJ = cp(0x200d);
const RLO = cp(0x202e);
const TAG_A = cp(0xe0041);
const LS = cp(0x2028);
const PS = cp(0x2029);
const NBSP = cp(0xa0);
const IDEOGRAPHIC_SPACE = cp(0x3000);
const BOM = cp(0xfeff);
const PRIVATE_USE = cp(0xe000);
const LONE_HIGH = cp(0xd800);
const LONE_LOW = cp(0xdfff);
const SOFT_HYPHEN = cp(0xad);
const ARABIC_NUMBER_SIGN = cp(0x600);
const NEL = cp(0x85);
const MONGOLIAN_VS = cp(0x180e);
const ZWSP = cp(0x200b);
const FAMILY = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
const NL = cp(0x0a);
const CR = cp(0x0d);
const TAB = cp(0x09);

export const KAT_ITEMS = [
	{ room: 'lobby', nonce: '1', text: 'hello from n8n' },
	{ room: 'lobby', nonce: '1726221600000', text: 'millisecond nonce' },
	{ room: 'mb-p-test-mailbox', nonce: '9999999999999999999', text: 'max nonce, mailbox room' },
	{ room: 'd-owned_room-1', nonce: '42', text: `  padded ${NBSP}text${IDEOGRAPHIC_SPACE} ` },
	{ room: 'lobby', nonce: '7', text: `line one${NL}line two${CR}${NL}line three${LS}four${PS}five` },
	{ room: 'lobby', nonce: '8', text: `bidi ${RLO}evil${ZWJ} zero${ZWSP}width ${TAG_A}tag ${BOM}bom` },
	{ room: 'lobby', nonce: '9', text: `emoji ${FAMILY} caf${cp(0xe9)} ${cp(0xf1)} ${cp(0x65e5, 0x672c, 0x8a9e)} ${cp(0x1f600)}` },
	{
		room: 'lobby',
		nonce: '10',
		text: `private ${PRIVATE_USE} soft${SOFT_HYPHEN}hyphen ${ARABIC_NUMBER_SIGN} nel${NEL}x ${MONGOLIAN_VS}`,
	},
	{ room: 'lobby', nonce: '11', text: `pipes | in | text | ${'x'.repeat(10)}` },
	{ room: 'lobby', nonce: '12', text: 'x'.repeat(4096) },
	{ room: 'lobby', nonce: '13', text: `${ZWJ}${RLO}${NL}${TAB} ` },
	{ room: 'lobby', nonce: '14', text: '"nonce": 123 and {"nonce":456} quoted' },
];

export const SWEEP_CORPUS = [
	'',
	' ',
	'plain',
	'  trim me  ',
	`${NBSP}nbsp${NBSP}`,
	`${IDEOGRAPHIC_SPACE}wide${IDEOGRAPHIC_SPACE}`,
	`${cp(0x1680)}ogham${cp(0x2000, 0x200a, 0x202f, 0x205f)}`,
	`tab${TAB}new${NL}line${CR}cr${cp(0x0b)}vt${cp(0x0c)}ff`,
	`${LS}${PS}`,
	`${ZWJ}${ZWSP}${RLO}${BOM}`,
	`x${LONE_HIGH}y${LONE_LOW}z`,
	LONE_HIGH,
	`${TAG_A}${cp(0xe007f)}`,
	`${PRIVATE_USE}${cp(0xf0000)}${cp(0x10fffd)}`,
	`${SOFT_HYPHEN}${ARABIC_NUMBER_SIGN}${cp(0x61c, 0x6dd, 0x70f, 0x890, 0x8e2)}`,
	`${MONGOLIAN_VS}${cp(0x2060, 0x2064, 0x2066, 0x206f, 0xfff9, 0xfffb)}`,
	cp(0x110bd, 0x110cd, 0x13430, 0x1343f, 0x1bca0, 0x1d173, 0x1d17a),
	`${NEL}${cp(0x80, 0x9f, 0x7f)}`,
	FAMILY,
	cp(0x2065),
	cp(0x13455),
	cp(0xe0001),
	`e${cp(0x301)} combining`,
	`${cp(0xe9)} precomposed`,
	`${' '.repeat(3)}${ZWJ}${' '.repeat(3)}`,
	`${cp(0)}null${cp(0)}`,
	cp(0x1f, 0x1c, 0x1d, 0x1e),
];

/** Code points of a JS string (lone surrogates included), for lossless JSON transport. */
export function toCodePoints(text) {
	const out = [];
	for (let i = 0; i < text.length; i++) {
		const hi = text.charCodeAt(i);
		if (hi >= 0xd800 && hi <= 0xdbff && i + 1 < text.length) {
			const lo = text.charCodeAt(i + 1);
			if (lo >= 0xdc00 && lo <= 0xdfff) {
				out.push((hi - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000);
				i++;
				continue;
			}
		}
		out.push(hi);
	}
	return out;
}

export function fromCodePoints(codePoints) {
	return cp(...codePoints);
}

/** JSON with every non-ASCII UTF-16 unit escaped, so fixture files stay ASCII-only. */
export function asciiJson(value) {
	return JSON.stringify(value, null, TAB).replace(/[^\x20-\x7e\n\t]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
