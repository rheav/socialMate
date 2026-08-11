// Is this the same post, seen twice? Canonical source — inlined verbatim into
// the import-free capture scripts by scripts/gen-inline.mjs, see ./README.md.
//
// WHY: a reel page updates location.href BEFORE it swaps the mounted card.
// Measured live (2026-08-01, rAF sampling over three reel changes): a 150-175 ms
// window in which grabVideoId() — which reads the permalink id off the URL —
// already returns the NEW reel while the author, caption and counts scraped from
// the DOM still belong to the PREVIOUS one. A capture taken there files one
// reel's engagement under another reel's id, silently.
//
// The fix is to scrape twice and only trust a pair that agrees. This is the
// comparison that decides "agrees".
const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

export function sameCapture(a, b) {
  if (!a || !b) return false;
  if ((a.videoId || null) !== (b.videoId || null)) return false;
  if (norm(a.author?.name) !== norm(b.author?.name)) return false;
  // Captions hydrate: FB collapses/expands the "… Ver mais" tail and streams
  // long bodies in late, so compare only the shared prefix — same opening text
  // means same post, a different opening means the card was swapped under us.
  const ca = norm(a.caption);
  const cb = norm(b.caption);
  if (!ca || !cb) return ca === cb;
  const n = Math.min(40, ca.length, cb.length);
  return ca.slice(0, n) === cb.slice(0, n);
}
