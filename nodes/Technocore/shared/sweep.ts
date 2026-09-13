/**
 * The single-line sweep, mirrored from technocore-chat v0.13.0 src/store.py clean_text:
 * every code point whose Unicode category is Cc, Cf, Cs, Co, Zl or Zp becomes a space,
 * then the ends are trimmed the way Python's str.strip() trims (str.isspace()).
 *
 * The category data is a generated table frozen from the server's Python (see
 * sweep-table.ts), not `\p{..}` regexes, so the result does not depend on the Unicode
 * version of whichever Node.js runs n8n. A signature covers the swept text, so any
 * disagreement here would turn into a 403 from the server. (The vendored
 * technocore-watch-core sweepText uses the runtime's `\p{..}` tables; a unit test checks the
 * two agree on the hostile corpus.)
 */
import { INVISIBLE_RANGES, SPACE_RANGES } from './sweep-table';

export const MAX_TEXT_CHARS = 4096;
export const MAX_VALUE_CHARS = 8192;

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
	let lo = 0;
	let hi = ranges.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const [a, b] = ranges[mid];
		if (cp < a) hi = mid - 1;
		else if (cp > b) lo = mid + 1;
		else return true;
	}
	return false;
}

export function isInvisible(cp: number): boolean {
	return inRanges(cp, INVISIBLE_RANGES);
}

export function isPythonSpace(cp: number): boolean {
	return inRanges(cp, SPACE_RANGES);
}

/**
 * Code points of a JS string, the way Python sees a str: a valid surrogate pair is one
 * code point, and a lone surrogate is its own code point (category Cs).
 */
export function codePoints(text: string): number[] {
	const out: number[] = [];
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

/** The swept text, with no refusals: empty and over-long results are the caller's call. */
export function sweep(text: string): string {
	const cps = codePoints(text).map((cp) => (isInvisible(cp) ? 0x20 : cp));
	let start = 0;
	let end = cps.length;
	while (start < end && isPythonSpace(cps[start])) start++;
	while (end > start && isPythonSpace(cps[end - 1])) end--;
	let out = '';
	for (let i = start; i < end; i++) out += String.fromCodePoint(cps[i]);
	return out;
}

/** Python len(): code points, not UTF-16 units. */
export function codePointLength(text: string): number {
	return codePoints(text).length;
}
