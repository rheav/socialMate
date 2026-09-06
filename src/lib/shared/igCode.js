// The two names Instagram gives the same media, and how to get from one to the
// other. INLINED into content scripts — see src/lib/shared/README.md before
// editing (no imports allowed in this file).
//
// A media has a numeric `pk` (3964608873797160540) and a shortcode
// (DcFHsPsCo5c), and the shortcode is just the pk written in base64url with
// Instagram's alphabet — so either one yields the other with no request. Verified
// live in both directions on media captured this session (2026-08-31):
//   3964608873797160540 <-> DcFHsPsCo5c   (a profile-grid post)
//   3974000808306592589 <-> DcmfK4UOstN   (a /reels/ player)
//
// WHY THIS EXISTS. Payloads disagree about which name they ship. The profile-grid
// GraphQL connection gives the shortcode and NO pk, so `lite()` stored `pk: ""`,
// and two things broke downstream, both measured live:
//
//  1. The post modal's floating rail never appeared. The MAIN world stamps the
//     player with the pk it reads off React props, the bridge looks that pk up
//     among the captured records, and no record from a grid had one to match —
//     so opening a post from the grid lost the rail (stats, save, download,
//     transcribe) that the tile behind it was already showing.
//  2. Per-media enrichment never fired for those records: `needsEnrichment()`
//     refuses without a pk, so /api/v1/media/<pk>/info/ was never asked and the
//     views stayed a hole on exactly the surface that omits them.
//
// Deriving the missing half fixes both at the source, and costs one bigint loop.

// Instagram's base64url alphabet, in value order.
const IG_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * The bare media id in `value`.
 *
 * Instagram's `id` field is "<pk>_<ownerid>" while its `pk` field is the pk
 * alone; a comparison that keeps the suffix silently never matches.
 */
export function igIdBase(value) {
  const s = value == null ? "" : String(value).trim();
  return s.split("_")[0];
}

/** Is `value` a bare numeric media pk? */
function isPk(value) {
  return /^[0-9]+$/.test(value);
}

/** The shortcode for a media pk, or null if `pk` is not one. */
export function igCodeFromPk(pk) {
  const base = igIdBase(pk);
  if (!isPk(base)) return null;
  let n = BigInt(base);
  if (n === 0n) return IG_B64[0];
  let out = "";
  while (n > 0n) {
    out = IG_B64[Number(n % 64n)] + out;
    n /= 64n;
  }
  return out;
}

/** The numeric pk for a shortcode, or null if `code` is not one. */
export function igPkFromCode(code) {
  const s = code == null ? "" : String(code).trim();
  if (!s || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  let n = 0n;
  for (const ch of s) {
    const v = IG_B64.indexOf(ch);
    if (v < 0) return null;
    n = n * 64n + BigInt(v);
  }
  return n.toString();
}

/**
 * Does `rec` name the media that `ref` refers to?
 *
 * `ref` is whatever identifier the caller has — a shortcode, a pk, or an
 * Instagram `id` with its owner suffix — and both sides are reduced to the pk
 * before comparing, so a record captured with only a shortcode still answers to
 * the pk a player was stamped with.
 */
export function igRefMatches(rec, ref) {
  if (!rec) return false;
  const want = igIdBase(ref);
  if (!want) return false;
  if (rec.code && String(rec.code) === want) return true;
  const wantPk = isPk(want) ? want : igPkFromCode(want);
  if (!wantPk) return false;
  for (const field of [rec.pk, rec.id]) {
    const have = igIdBase(field);
    if (have && isPk(have) && have === wantPk) return true;
  }
  return rec.code ? igPkFromCode(rec.code) === wantPk : false;
}
