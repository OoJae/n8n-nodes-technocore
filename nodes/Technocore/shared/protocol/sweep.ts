// VENDORED from technocore-watch-core@f9c4ab6b4a6bfb683f310a7105ed865dca37b32d src/protocol/sweep.ts - do not edit; run `npm run vendor`.
// The single-line sweep, mirrored from technocore-chat store.clean_text /
// technocore_mcp.signing.sweep: every character in Unicode categories
// Cc, Cf, Cs, Co, Zl, Zp becomes a space, then the ends are trimmed.
//
// Only the transformation is mirrored — the service's empty/too-long refusals stay the
// service's. Parity with Python is pinned by tests (tests/integration/sweep-parity).
// Known residual risk: V8 and CPython may ship different Unicode versions, so a code
// point assigned to Cf in one and unassigned (Cn) in the other sweeps differently.

export const INVISIBLE_CATEGORIES = ['Cc', 'Cf', 'Cs', 'Co', 'Zl', 'Zp'] as const;

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu;

// Python's str.strip() removes characters for which str.isspace() is true: bidi type
// WS/B/S or category Zs. After the replacement above every Cc/Zl/Zp is already a space,
// so what is left to strip is exactly Zs (U+0020, U+00A0, U+2000..U+200A, ...).
// JS trim() is not used: it also strips U+FEFF, harmless here, but the explicit class
// keeps the mirror auditable.
// Every Zs code point is in the BMP, so checking single UTF-16 units is exact.
const ZS = /^\p{Zs}$/u;

export function sweepText(text: string): string {
  const swept = text.replace(INVISIBLE, ' ');
  let start = 0;
  let end = swept.length;
  // Linear scans rather than /\p{Zs}+$/, which backtracks quadratically on long space runs.
  while (start < end && ZS.test(swept[start]!)) start++;
  while (end > start && ZS.test(swept[end - 1]!)) end--;
  return swept.slice(start, end);
}
