import { describe, it, expect } from "vitest";
import {
  fbidFromHref,
  setFromHref,
  ownerKeyFromUrl,
  ownerNameFromTitle,
  isPhotosSurface,
  photoPermalink,
  photoBaseFromUrl,
  parseBoxFromUrl,
  parseCropFromUrl,
  isCroppedThumb,
  thumbCropStats,
  cropNotice,
  downloadUrlFor,
  pickBest,
  dedupeByFbid,
  summarize,
  selectForZip,
  HARVEST_CAPS,
  harvestCap,
  capMessage,
  zipNotes,
  sanitizeFilenamePart,
  extFromUrl,
  filenameFor,
  stampFor,
  zipFilename,
  fmtBytes,
} from "./fbPhotos.js";

// Real URLs captured from a live profile grid (2026-07-25).
const TILE = "https://www.facebook.com/photo.php?fbid=122111787357372141&set=pb.61591164255809.-2207520000&type=3";
const COVER = "https://www.facebook.com/photo/?fbid=122106781653372141&set=a.617458010522431";
const THUMB =
  "https://scontent.fubt4-1.fna.fbcdn.net/v/t39.30808-6/753953991_122111787363372141_5417810366950726345_n.jpg?stp=c0.241.941.941a_dst-jpg_tt6&_nc_cat=101&oh=00_AQB&oe=6A6A";
// The 8-of-42 minority: same grid, same size, no crop token.
const THUMB_WHOLE =
  "https://scontent.fubt4-1.fna.fbcdn.net/v/t39.30808-6/753953991_122111687841372141_5417810366950726345_n.jpg?stp=dst-jpg_tt6&_nc_cat=101&oh=00_AQB&oe=6A6A";
// The cover photo: 1945×720, PNG pipeline, also uncropped — a wide tile, not a
// square one, so it must NOT be flagged.
const COVER_IMG =
  "https://scontent.fubt4-1.fna.fbcdn.net/v/t39.30808-6/753953991_122106781653372141_5417810366950726345_n.png?stp=dst-png&_nc_cat=101&oh=00_AQB&oe=6A6A";
const FULL =
  "https://scontent.fubt4-1.fna.fbcdn.net/v/t39.30808-6/753953991_122111787363372141_5417810366950726345_n.jpg?stp=dst-jpg_tt6&cstp=mx941x1672&ctp=s941x1672&_nc_cat=101&oh=00_AQB&oe=6A6A";

describe("fbidFromHref", () => {
  it("reads the photo id out of both tile href shapes", () => {
    expect(fbidFromHref(TILE)).toBe("122111787357372141");
    expect(fbidFromHref(COVER)).toBe("122106781653372141");
    expect(fbidFromHref("/photo/?fbid=999&set=a.1")).toBe("999");
  });

  it("returns null when there is no fbid", () => {
    expect(fbidFromHref("https://www.facebook.com/reel/123")).toBeNull();
    expect(fbidFromHref("")).toBeNull();
    expect(fbidFromHref(null)).toBeNull();
  });

  it("does not match a parameter that merely ends in fbid", () => {
    // story_fbid is a DIFFERENT id namespace — matching it would download the
    // wrong photo, so the boundary before `fbid=` is load-bearing.
    expect(fbidFromHref("https://www.facebook.com/permalink.php?story_fbid=555&id=9")).toBeNull();
    expect(fbidFromHref("https://www.facebook.com/permalink.php?story_fbid=555&fbid=777")).toBe("777");
  });
});

describe("setFromHref", () => {
  it("returns the photo set, url-decoded", () => {
    expect(setFromHref(TILE)).toBe("pb.61591164255809.-2207520000");
    expect(setFromHref(COVER)).toBe("a.617458010522431");
    expect(setFromHref("/photo/?fbid=1&set=a.1%2E2")).toBe("a.1.2");
  });
  it("returns null without a set", () => {
    expect(setFromHref("/photo/?fbid=1")).toBeNull();
  });
});

describe("ownerKeyFromUrl", () => {
  it("prefers the numeric profile id", () => {
    expect(ownerKeyFromUrl("https://www.facebook.com/profile.php?id=61591164255809&sk=photos")).toBe("61591164255809");
  });
  it("falls back to the vanity segment", () => {
    expect(ownerKeyFromUrl("https://www.facebook.com/astravale/photos")).toBe("astravale");
    expect(ownerKeyFromUrl("https://www.facebook.com/astravale")).toBe("astravale");
  });
  it("returns null for pages that name no profile", () => {
    expect(ownerKeyFromUrl("https://www.facebook.com/profile.php")).toBeNull();
    expect(ownerKeyFromUrl("https://www.facebook.com/photo/?fbid=1")).toBeNull();
    expect(ownerKeyFromUrl("not a url")).toBeNull();
  });
});

describe("ownerNameFromTitle", () => {
  it("strips the notification counter and the Facebook suffix", () => {
    expect(ownerNameFromTitle("(1) Astra Vale | Facebook")).toBe("Astra Vale");
    expect(ownerNameFromTitle("(20+) Astra Vale | Facebook")).toBe("Astra Vale");
    expect(ownerNameFromTitle("Astra Vale | Facebook")).toBe("Astra Vale");
  });
  it("peels a 'Fotos de …' style title", () => {
    expect(ownerNameFromTitle("Fotos de Astra Vale | Facebook")).toBe("Astra Vale");
    expect(ownerNameFromTitle("Photos of Astra Vale | Facebook")).toBe("Astra Vale");
  });
  it("returns null when the title carries no name", () => {
    expect(ownerNameFromTitle("Facebook")).toBeNull();
    expect(ownerNameFromTitle("(5) Facebook")).toBeNull();
    expect(ownerNameFromTitle("")).toBeNull();
  });
  it("caps absurdly long titles", () => {
    expect(ownerNameFromTitle("x".repeat(200) + " | Facebook")).toHaveLength(60);
  });
});

describe("isPhotosSurface", () => {
  it("matches every photos tab flavour", () => {
    expect(isPhotosSurface("https://www.facebook.com/profile.php?id=1&sk=photos")).toBe(true);
    expect(isPhotosSurface("https://www.facebook.com/profile.php?id=1&sk=photos_by")).toBe(true);
    expect(isPhotosSurface("https://www.facebook.com/profile.php?id=1&sk=photos_albums")).toBe(true);
    expect(isPhotosSurface("https://www.facebook.com/astravale/photos")).toBe(true);
    expect(isPhotosSurface("https://www.facebook.com/astravale/photos/")).toBe(true);
  });
  it("does not match the theater or unrelated tabs", () => {
    expect(isPhotosSurface("https://www.facebook.com/photo/?fbid=1&set=a.2")).toBe(false);
    expect(isPhotosSurface("https://www.facebook.com/photo.php?fbid=1")).toBe(false);
    expect(isPhotosSurface("https://www.facebook.com/profile.php?id=1&sk=reels_tab")).toBe(false);
    expect(isPhotosSurface("https://www.facebook.com/")).toBe(false);
  });
});

describe("photoPermalink", () => {
  it("rebuilds a canonical permalink", () => {
    expect(photoPermalink("123", "pb.9.-2207520000")).toBe(
      "https://www.facebook.com/photo/?fbid=123&set=pb.9.-2207520000",
    );
    expect(photoPermalink("123", null)).toBe("https://www.facebook.com/photo/?fbid=123");
    expect(photoPermalink(null, "a.1")).toBeNull();
  });
});

describe("photoBaseFromUrl", () => {
  it("gives the same stem for the thumbnail and the full-res rendition", () => {
    // This is the whole point: the two URLs differ only in the signed transform,
    // so the stem is what lets pickBest compare them as one photo.
    expect(photoBaseFromUrl(THUMB)).toBe("753953991_122111787363372141_5417810366950726345");
    expect(photoBaseFromUrl(FULL)).toBe(photoBaseFromUrl(THUMB));
  });
  it("handles png/webp and other rendition suffixes", () => {
    expect(photoBaseFromUrl("https://scontent.x.fbcdn.net/v/t39/1_2_3_o.png?x=1")).toBe("1_2_3");
    expect(photoBaseFromUrl("https://scontent.x.fbcdn.net/v/t39/1_2_3_s.webp")).toBe("1_2_3");
  });
  it("returns null for non-photo urls", () => {
    expect(photoBaseFromUrl("data:image/svg+xml,%3Csvg")).toBeNull();
    expect(photoBaseFromUrl("https://scontent.x.fbcdn.net/v/t39/logo.png")).toBeNull();
    expect(photoBaseFromUrl(undefined)).toBeNull();
  });
});

describe("parseBoxFromUrl", () => {
  it("reads the theater's requested size box", () => {
    expect(parseBoxFromUrl(FULL)).toEqual({ width: 941, height: 1672 });
    expect(parseBoxFromUrl("https://x/y.jpg?ctp=s1122x1402")).toEqual({ width: 1122, height: 1402 });
    expect(parseBoxFromUrl("https://x/y.jpg?stp=dst-jpg_s960x960&a=1")).toEqual({ width: 960, height: 960 });
  });
  it("ignores a crop spec, which is not a size", () => {
    // stp=c0.241.941.941a_dst-jpg_tt6 is a CROP rectangle; treating it as a size
    // would make a 414px thumbnail look like a 941px original.
    expect(parseBoxFromUrl(THUMB)).toBeNull();
    expect(parseBoxFromUrl("https://x/y.jpg")).toBeNull();
  });
});

describe("parseCropFromUrl", () => {
  it("reads the square crop a thumbnail was cut with", () => {
    // This is the measured majority case: 34 of the 42 tiles that carried an
    // <img> on the reference profile. 941×941 out of a 941×1672 original — the
    // top 241px and the bottom ~490px are simply not in the file.
    expect(parseCropFromUrl(THUMB)).toEqual({ x: 0, y: 241, width: 941, height: 941 });
    expect(parseCropFromUrl("https://x/y.jpg?stp=c0.92.1122.1122a_dst-jpg_tt6")).toEqual({
      x: 0,
      y: 92,
      width: 1122,
      height: 1122,
    });
    // A non-zero x happens on landscape originals, and the crop token is not
    // always first in the underscore list.
    expect(parseCropFromUrl("https://x/y.jpg?stp=cp0_c129.0.1290.1290a_dst-jpg&oh=1")).toEqual({
      x: 129,
      y: 0,
      width: 1290,
      height: 1290,
    });
  });

  it("returns null for an UNCROPPED tile — the cheap 'whole frame' test", () => {
    expect(parseCropFromUrl(THUMB_WHOLE)).toBeNull();
    expect(parseCropFromUrl(COVER_IMG)).toBeNull();
    expect(parseCropFromUrl(FULL)).toBeNull();
    // A size box is not a crop; confusing the two is the bug parseBoxFromUrl
    // already guards against from the other side.
    expect(parseCropFromUrl("https://x/y.jpg?stp=dst-jpg_s960x960")).toBeNull();
    expect(parseCropFromUrl("https://x/y.jpg?stp=cp0_dst-jpg_e15_q65")).toBeNull();
  });

  it("returns null for a malformed or degenerate crop spec", () => {
    expect(parseCropFromUrl("https://x/y.jpg?stp=c0.241.941a_dst-jpg")).toBeNull(); // three numbers
    expect(parseCropFromUrl("https://x/y.jpg?stp=c0.241.941.941_dst-jpg")).toBeNull(); // no trailing a
    expect(parseCropFromUrl("https://x/y.jpg?stp=ca.b.c.da_dst-jpg")).toBeNull(); // not numbers
    expect(parseCropFromUrl("https://x/y.jpg?stp=c0.0.0.0a_dst-jpg")).toBeNull(); // zero-area box
  });

  it("returns null when there is no stp at all", () => {
    expect(parseCropFromUrl("https://x/y.jpg?_nc_cat=101&oh=00_AQB")).toBeNull();
    expect(parseCropFromUrl("https://x/y.jpg")).toBeNull();
    expect(parseCropFromUrl("")).toBeNull();
    expect(parseCropFromUrl(null)).toBeNull();
    expect(parseCropFromUrl(undefined)).toBeNull();
  });
});

describe("isCroppedThumb", () => {
  it("is false for any record that reached full resolution", () => {
    // The theater image is the whole frame, even when the tile it came from was
    // a crop — otherwise the panel would warn about photos that are fine.
    expect(isCroppedThumb({ thumb: THUMB, crop: { x: 0, y: 241, width: 941, height: 941 }, full: FULL })).toBe(false);
  });
  it("trusts the flags the content script stamped on the record", () => {
    expect(isCroppedThumb({ thumb: THUMB, crop: { x: 0, y: 1, width: 2, height: 3 } })).toBe(true);
    expect(isCroppedThumb({ thumb: THUMB_WHOLE, crop: null, cropped: false })).toBe(false);
  });
  it("falls back to the thumb url when the record carries no flags", () => {
    expect(isCroppedThumb({ thumb: THUMB })).toBe(true);
    expect(isCroppedThumb({ thumb: THUMB_WHOLE })).toBe(false);
    expect(isCroppedThumb({})).toBe(false);
    expect(isCroppedThumb(null)).toBe(false);
  });
});

describe("thumbCropStats / cropNotice", () => {
  it("counts only the photos that would actually ship as a thumbnail", () => {
    const recs = [
      { fbid: "1", thumb: THUMB },                 // cropped, ships as thumb
      { fbid: "2", thumb: THUMB_WHOLE },           // whole, ships as thumb
      { fbid: "3", thumb: THUMB, full: FULL },     // resolved — not a thumb ship
      { fbid: "4" },                               // nothing at all
    ];
    expect(thumbCropStats(recs)).toEqual({ total: 2, cropped: 1, whole: 1 });
    expect(thumbCropStats([])).toEqual({ total: 0, cropped: 0, whole: 0 });
    expect(thumbCropStats(null)).toEqual({ total: 0, cropped: 0, whole: 0 });
  });

  it("says out loud how much of the photo is missing, in pt-BR", () => {
    const msg = cropNotice({ total: 43, cropped: 34 });
    expect(msg).toContain("34 de 43");
    expect(msg).toContain("recortadas");
    expect(msg).toContain("alta resolução"); // points at the way out
  });

  it("is equally explicit when nothing was cropped", () => {
    expect(cropNotice({ total: 8, cropped: 0 })).toContain("Nenhuma das 8");
    expect(cropNotice({ total: 0, cropped: 0 })).toBeNull();
    expect(cropNotice(null)).toBeNull();
  });
});

describe("downloadUrlFor", () => {
  it("prefers the full-res url in both modes", () => {
    expect(downloadUrlFor({ full: FULL, thumb: THUMB }, "thumbs")).toBe(FULL);
    expect(downloadUrlFor({ full: FULL, thumb: THUMB }, "full")).toBe(FULL);
  });
  it("only falls back to the tile image in thumbnail mode", () => {
    expect(downloadUrlFor({ thumb: THUMB }, "thumbs")).toBe(THUMB);
    expect(downloadUrlFor({ thumb: THUMB }, "full")).toBeNull();
    expect(downloadUrlFor({ thumb: THUMB })).toBeNull(); // default is the strict mode
  });
  it("has nothing to offer for an empty record", () => {
    expect(downloadUrlFor({}, "thumbs")).toBeNull();
    expect(downloadUrlFor(null, "thumbs")).toBeNull();
  });
});

describe("pickBest", () => {
  it("picks the largest by area", () => {
    const best = pickBest([
      { url: "a.jpg", width: 414, height: 414 },
      { url: "b.jpg", width: 1254, height: 1254 },
      { url: "c.jpg", width: 941, height: 1672 },
    ]);
    // 941×1672 = 1_573_352 px, just ahead of 1254×1254 = 1_572_516 — area, not
    // width, is what decides.
    expect(best).toEqual({ url: "c.jpg", width: 941, height: 1672 });
  });
  it("falls back to the URL size box when the <img> has not decoded yet", () => {
    const best = pickBest([
      { url: THUMB, width: 414, height: 414 },
      { url: FULL, width: 0, height: 0 },
    ]);
    expect(best.url).toBe(FULL);
    expect(best.width).toBe(941);
    expect(best.height).toBe(1672);
  });
  it("still returns something when nothing has dimensions (first wins)", () => {
    const best = pickBest([{ url: "a.jpg" }, { url: "b.jpg" }]);
    expect(best).toEqual({ url: "a.jpg", width: null, height: null });
  });
  it("skips entries with no url and returns null for an empty set", () => {
    expect(pickBest([{ width: 9999, height: 9999 }, { url: "a.jpg", width: 1, height: 1 }]).url).toBe("a.jpg");
    expect(pickBest([])).toBeNull();
    expect(pickBest(null)).toBeNull();
  });
});

describe("dedupeByFbid", () => {
  it("keeps the first sighting's position and fills its gaps from later ones", () => {
    const out = dedupeByFbid([
      { fbid: "1", thumb: "t1.jpg", full: null },
      { fbid: "2", thumb: "t2.jpg", full: null },
      { fbid: "1", thumb: null, full: "f1.jpg", width: 941 },
    ]);
    expect(out.map((r) => r.fbid)).toEqual(["1", "2"]);
    expect(out[0]).toEqual({ fbid: "1", thumb: "t1.jpg", full: "f1.jpg", width: 941 });
  });

  it("never lets a later record clobber a value that is already there", () => {
    const out = dedupeByFbid([
      { fbid: "1", full: "good.jpg" },
      { fbid: "1", full: "stale.jpg" },
    ]);
    expect(out[0].full).toBe("good.jpg");
  });

  it("normalises numeric ids and drops records with none", () => {
    const out = dedupeByFbid([{ fbid: 7, thumb: "a" }, { fbid: "7", full: "b" }, { thumb: "orphan" }, null]);
    expect(out).toEqual([{ fbid: "7", thumb: "a", full: "b" }]);
  });

  it("does not mutate the input records", () => {
    const input = [{ fbid: "1", full: null }, { fbid: "1", full: "f.jpg" }];
    dedupeByFbid(input);
    expect(input[0].full).toBeNull();
  });
});

describe("summarize", () => {
  it("counts resolved vs pending", () => {
    expect(summarize([{ full: "a" }, { full: null }, { full: "b" }])).toEqual({ total: 3, resolved: 2, pending: 1 });
    expect(summarize([])).toEqual({ total: 0, resolved: 0, pending: 0 });
  });
});

describe("selectForZip", () => {
  const recs = [
    { fbid: "1", full: "a.jpg" },
    { fbid: "2", full: null },
    { fbid: "3", full: "c.jpg" },
    { fbid: "4", full: "d.jpg" },
  ];

  it("only takes photos whose full-res url was captured", () => {
    const { batch, unresolved, skipped } = selectForZip(recs, { maxCount: 10 });
    expect(batch.map((r) => r.fbid)).toEqual(["1", "3", "4"]);
    expect(unresolved).toBe(1);
    expect(skipped).toBe(0);
  });

  it("reports how many the count cap left out instead of hiding them", () => {
    const { batch, skipped } = selectForZip(recs, { maxCount: 2 });
    expect(batch.map((r) => r.fbid)).toEqual(["1", "3"]);
    expect(skipped).toBe(1);
  });

  it("applies the byte budget when an average size is known", () => {
    // 5 MB budget at an estimated 2 MB each → 2 photos.
    const { batch, skipped } = selectForZip(recs, { maxCount: 10, maxBytes: 5e6, avgBytes: 2e6 });
    expect(batch).toHaveLength(2);
    expect(skipped).toBe(1);
  });

  it("always allows at least one photo through the byte budget", () => {
    const { batch } = selectForZip(recs, { maxCount: 10, maxBytes: 1, avgBytes: 5e6 });
    expect(batch).toHaveLength(1);
  });

  it("resolves each entry's download url for the mode, and flags the thumbs", () => {
    const mixed = [
      { fbid: "1", full: FULL, thumb: THUMB },
      { fbid: "2", thumb: THUMB },
      { fbid: "3" },
    ];
    const strict = selectForZip(mixed, { maxCount: 10 });
    expect(strict.batch.map((r) => r.url)).toEqual([FULL]);
    expect(strict.batch[0].fromThumb).toBe(false);
    expect(strict.unresolved).toBe(2);

    const fast = selectForZip(mixed, { maxCount: 10, mode: "thumbs" });
    expect(fast.batch.map((r) => r.url)).toEqual([FULL, THUMB]);
    expect(fast.batch.map((r) => r.fromThumb)).toEqual([false, true]);
    expect(fast.unresolved).toBe(1); // only the record with no image at all
  });

  it("does not mutate the records it selects", () => {
    const input = [{ fbid: "1", thumb: THUMB }];
    selectForZip(input, { maxCount: 10, mode: "thumbs" });
    expect(input[0]).toEqual({ fbid: "1", thumb: THUMB });
  });
});

// ---------------------------------------------------------------------------
// CAPS. These were the tool's only untested paths: the profile it was built on
// has 43 photos against caps of 300/420/60 and 150-per-ZIP, so nothing here can
// be reached live. Each test drives the cap with a fake tile set or fake byte
// sizes, and then asserts the run REPORTS it — a cap that truncates in silence
// is the defect, not the cap.
// ---------------------------------------------------------------------------
describe("harvest caps", () => {
  it("leaves a normal run alone", () => {
    // The reference profile, to scale: 43 photos, 43 steps, 4 scrolls, grid done.
    expect(harvestCap({ photos: 43, steps: 43, scrolls: 4, growing: false })).toBeNull();
    expect(harvestCap({})).toBeNull();
    expect(harvestCap()).toBeNull();
  });

  it("stops a THUMBNAIL harvest at the photo cap and names it", () => {
    // Exactly the loop photos-scrape.js ingestTiles() runs, with 400 fake tiles.
    const tiles = Array.from({ length: 400 }, (_, i) => `fbid-${i}`);
    const store = new Map();
    let reason = null;
    for (const fbid of tiles) {
      if (!store.has(fbid) && (reason = harvestCap({ photos: store.size }))) break;
      store.set(fbid, { fbid, thumb: THUMB });
    }
    expect(store.size).toBe(HARVEST_CAPS.photos); // 300 kept…
    expect(reason).toBe("photos"); // …and the other 100 are ACCOUNTED FOR
    expect(capMessage(reason, HARVEST_CAPS, "thumbs")).toContain("300");
  });

  it("stops a FULL-RES walk at the photo cap before the step cap", () => {
    // A walk that resolves one photo per step reaches 300 photos at step 300,
    // long before the 420-step guard — so the message must say "fotos", not
    // "aberturas", or the advice it gives is the wrong advice.
    let photos = 0;
    let steps = 0;
    let reason = null;
    while (!(reason = harvestCap({ photos, steps }))) { photos++; steps++; }
    expect(reason).toBe("photos");
    expect(steps).toBe(HARVEST_CAPS.photos);
    expect(capMessage(reason, HARVEST_CAPS, "full")).toContain("300");
  });

  it("stops a LOOPING set at the step cap", () => {
    // The pathological set: the theater keeps advancing but every photo is one
    // we already walked, so `photos` never grows and only the step guard ends it.
    let steps = 0;
    let reason = null;
    while (!(reason = harvestCap({ photos: 12, steps }))) steps++;
    expect(reason).toBe("steps");
    expect(steps).toBe(HARVEST_CAPS.steps);
    expect(capMessage(reason, HARVEST_CAPS)).toContain("420");
  });

  it("reports the scroll cap only when the grid was STILL GROWING", () => {
    // Reaching the scroll budget on a grid that had already gone quiet is a
    // normal finish, not a truncation — warning there would cry wolf on every
    // large profile.
    expect(harvestCap({ scrolls: HARVEST_CAPS.scrolls, growing: true })).toBe("scroll");
    expect(harvestCap({ scrolls: HARVEST_CAPS.scrolls, growing: false })).toBeNull();
    expect(harvestCap({ scrolls: HARVEST_CAPS.scrolls - 1, growing: true })).toBeNull();
    expect(capMessage("scroll", HARVEST_CAPS)).toContain("60");
  });

  it("gives every cap a distinct sentence, and thumbnail mode its own advice", () => {
    const said = ["photos", "steps", "scroll"].map((r) => capMessage(r, HARVEST_CAPS));
    expect(new Set(said).size).toBe(3);
    for (const s of said) expect(s.length).toBeGreaterThan(20);
    // "colete de novo" is a lie in thumbnail mode: a repeat collect re-reads the
    // same first 300 tiles and the store is already full.
    expect(capMessage("photos", HARVEST_CAPS, "full")).toContain("colete de novo");
    expect(capMessage("photos", HARVEST_CAPS, "thumbs")).not.toContain("colete de novo");
    expect(capMessage("photos", HARVEST_CAPS, "thumbs")).toContain("limpe a lista");
  });
});

describe("zip caps report themselves", () => {
  it("says nothing when nothing was dropped", () => {
    expect(zipNotes()).toBeNull();
    expect(zipNotes({ skipped: 0, unresolved: 0, failed: 0 })).toBeNull();
  });

  it("names the per-ZIP photo cap with the count it left out", () => {
    // 200 resolved photos, 150 per archive → 50 must be spoken for.
    const recs = Array.from({ length: 200 }, (_, i) => ({ fbid: String(i), full: FULL }));
    const { batch, skipped } = selectForZip(recs, { maxCount: 150 });
    expect(batch).toHaveLength(150);
    expect(skipped).toBe(50);
    expect(zipNotes({ skipped, maxCount: 150 })).toContain("50 foto(s) ficaram de fora do limite de 150");
  });

  it("names the byte budget with the photo it stopped at", () => {
    // Fake byte sizes: 40 photos of 12 MB each against the 400 MB budget stops
    // partway through, and the note has to carry BOTH numbers.
    const MAX_BYTES = 400 * 1024 * 1024;
    const SIZE = 12 * 1024 * 1024;
    let bytes = 0;
    let stoppedAt = null;
    for (let i = 0; i < 40; i++) {
      if (bytes >= MAX_BYTES) { stoppedAt = i; break; }
      bytes += SIZE;
    }
    expect(stoppedAt).toBe(34); // 34×12 MB = 408 MB is the first read over budget
    const note = zipNotes({ stoppedAt, maxBytes: MAX_BYTES });
    expect(note).toContain("parou em 34");
    expect(note).toContain("400,0 MB");
  });

  it("also pre-empts the byte budget from an average size", () => {
    const recs = Array.from({ length: 40 }, (_, i) => ({ fbid: String(i), full: FULL }));
    const { batch, skipped } = selectForZip(recs, { maxCount: 150, maxBytes: 400 * 1024 * 1024, avgBytes: 12 * 1024 * 1024 });
    expect(batch).toHaveLength(33);
    expect(skipped).toBe(7);
    expect(zipNotes({ skipped, maxCount: 150 })).toContain("7 foto(s)");
  });

  it("stacks every reason a run fell short into one line", () => {
    const note = zipNotes({ skipped: 5, unresolved: 3, stoppedAt: 12, failed: 2, maxCount: 150, maxBytes: 4e8 });
    expect(note).toContain("5 foto(s)");
    expect(note).toContain("3 sem resolução alta");
    expect(note).toContain("parou em 12");
    expect(note).toContain("2 falharam");
    expect(note.split(" · ")).toHaveLength(4);
  });

  it("does not promise 'high resolution' in thumbnail mode", () => {
    expect(zipNotes({ unresolved: 3, mode: "thumbs" })).toBe("3 sem imagem nenhuma");
  });
});

describe("filename helpers (must behave exactly like igMedia/ttMedia)", () => {
  it("sanitizes the same characters and trims underscores at BOTH ends", () => {
    expect(sanitizeFilenamePart('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j");
    expect(sanitizeFilenamePart("/leading")).toBe("leading");
    expect(sanitizeFilenamePart("trailing/")).toBe("trailing");
    expect(sanitizeFilenamePart("///both///")).toBe("both");
    expect(sanitizeFilenamePart("___only___")).toBe("only");
    expect(sanitizeFilenamePart("////")).toBe("");
    expect(sanitizeFilenamePart(null)).toBe("");
    expect(sanitizeFilenamePart("x".repeat(80))).toHaveLength(40);
  });

  it("keeps accents — the ZIP's UTF-8 flag is what makes them safe", () => {
    expect(sanitizeFilenamePart("Astra Valé ✦")).toBe("Astra Valé ✦");
  });

  it("reads the extension off the url, normalising jpeg → jpg", () => {
    expect(extFromUrl(FULL)).toBe("jpg");
    expect(extFromUrl("https://x/y.JPEG?a=1")).toBe("jpg");
    expect(extFromUrl("https://x/y.png")).toBe("png");
    expect(extFromUrl("https://x/y.webp?stp=z")).toBe("webp");
    expect(extFromUrl("https://x/no-extension")).toBe("jpg");
    expect(extFromUrl("https://x/no-extension", "video")).toBe("mp4");
  });

  it("builds fb-<owner>-<fbid>.<ext>", () => {
    expect(filenameFor({ owner: "Astra Vale", fbid: "122111787357372141" }, "jpg")).toBe(
      "fb-Astra Vale-122111787357372141.jpg",
    );
    expect(filenameFor({ owner: "a/b", fbid: "9" }, "png")).toBe("fb-a_b-9.png");
    expect(filenameFor({ owner: "Astra", fbid: "9" }, "jpg", 2)).toBe("fb-Astra-9_2.jpg");
  });

  it("falls back to the profile key, then to 'perfil', rather than an empty segment", () => {
    expect(filenameFor({ ownerKey: "61591164255809", fbid: "9" }, "jpg")).toBe("fb-61591164255809-9.jpg");
    expect(filenameFor({ owner: "///", fbid: "9" }, "jpg")).toBe("fb-perfil-9.jpg");
    expect(filenameFor({ fbid: "9" }, "jpg")).toBe("fb-perfil-9.jpg");
  });
});

describe("stampFor / zipFilename", () => {
  it("stamps a sortable, filesystem-safe local timestamp", () => {
    expect(stampFor(new Date(2026, 6, 25, 16, 40, 12))).toBe("2026-07-25_16-40-12");
    expect(stampFor(new Date(2026, 0, 5, 3, 4, 5))).toBe("2026-01-05_03-04-05");
  });
  it("puts the archive in the shared socialmate folder", () => {
    expect(zipFilename("Astra Vale", new Date(2026, 6, 25, 16, 40, 12))).toBe(
      "socialmate-fotos/fb-Astra Vale-2026-07-25_16-40-12.zip",
    );
    expect(zipFilename("", new Date(2026, 6, 25, 16, 40, 12))).toBe(
      "socialmate-fotos/fb-perfil-2026-07-25_16-40-12.zip",
    );
  });
});

describe("fmtBytes", () => {
  it("formats with a pt-BR decimal comma", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(2048)).toBe("2 KB");
    expect(fmtBytes(2.5 * 1024 * 1024)).toBe("2,5 MB");
    expect(fmtBytes(null)).toBe("—");
  });
});
