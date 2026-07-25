import { describe, it, expect } from "vitest";
import {
  fbidFromHref,
  setFromHref,
  ownerKeyFromUrl,
  ownerNameFromTitle,
  isPhotosSurface,
  photoPermalink,
  photoBaseFromUrl,
  mergeCaptured,
  downloadUrlFor,
  dedupeByFbid,
  summarize,
  unresolvedPhotos,
  unresolvedManifest,
  UNRESOLVED_ENTRY,
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
// The grid tile's own image: a 941×941 SQUARE CROP of a 941×1672 original — the
// `c0.241.941.941a` token. The top 241 px and the bottom ~490 are not in the file.
const THUMB =
  "https://scontent.fubt4-1.fna.fbcdn.net/v/t39.30808-6/753953991_122111787363372141_5417810366950726345_n.jpg?stp=c0.241.941.941a_dst-jpg_tt6&_nc_cat=101&oh=00_AQB&oe=6A6A";
// The same photo's `viewer_image.uri` — no crop token, and the fbcdn stem is
// IDENTICAL to the thumbnail's, which is what makes the stem a usable join key.
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
  it("does not match a single-photo page or an unrelated tab", () => {
    // The harvest scrolls a GRID; a lone photo page has no grid to scroll, so
    // starting there has to be refused rather than silently collect nothing.
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
  it("gives the same stem for the tile crop and the uncropped viewer image", () => {
    // This is the whole point: the two URLs differ only in the signed transform,
    // so the stem joins a grid tile to its captured GraphQL row.
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

// ---------------------------------------------------------------------------
// The join. This is the new heart of the tool: grid tiles supply identity and
// order, the GraphQL capture supplies the uncropped image.
// ---------------------------------------------------------------------------
describe("mergeCaptured", () => {
  const tiles = [
    { fbid: "122111787357372141", thumb: THUMB, full: null },
    { fbid: "999", thumb: null, full: null },
  ];

  it("fills the full image from the row whose id IS the fbid", () => {
    // Verified live: 35 of 35 captured GraphQL ids matched a grid tile href.
    const out = mergeCaptured(tiles, [
      { id: "122111787357372141", full: FULL, width: 941, height: 1672, thumb: null },
    ]);
    expect(out[0].full).toBe(FULL);
    expect(out[0].width).toBe(941);
    expect(out[0].height).toBe(1672);
    expect(out[1].full).toBeNull(); // no row, no invention
  });

  it("falls back to the fbcdn stem when the id does not line up", () => {
    // Insurance for the day Facebook stops using the fbid as the node id: the
    // tile's crop and the viewer image share a filename stem.
    const out = mergeCaptured(tiles, [{ id: "some-opaque-node-id", full: FULL, width: 941, height: 1672 }]);
    expect(out[0].full).toBe(FULL);
  });

  it("NEVER substitutes the cropped thumbnail for a missing row", () => {
    // The one guarantee this rewrite exists to make.
    const out = mergeCaptured(tiles, []);
    expect(out[0].full).toBeNull();
    expect(out[0].thumb).toBe(THUMB);
  });

  it("leaves an already-resolved record alone and never mutates the input", () => {
    const input = [{ fbid: "1", thumb: THUMB, full: "keep.jpg", width: 10, height: 20 }];
    const out = mergeCaptured(input, [{ id: "1", full: FULL, width: 941, height: 1672 }]);
    expect(out[0].full).toBe("keep.jpg");
    expect(out[0].width).toBe(10);
    expect(input[0].full).toBe("keep.jpg");
  });

  it("ignores rows with no url or no id, and tolerates empty input", () => {
    expect(mergeCaptured(tiles, [{ id: "122111787357372141" }, { full: FULL }])[0].full).toBeNull();
    expect(mergeCaptured(null, null)).toEqual([]);
    expect(mergeCaptured(tiles, null)[0].full).toBeNull();
  });

  it("normalises a numeric row id against the string fbid", () => {
    const out = mergeCaptured([{ fbid: "7", thumb: null }], [{ id: 7, full: FULL, width: 1, height: 2 }]);
    expect(out[0].full).toBe(FULL);
  });

  it("nulls out a missing width/height rather than leaving them undefined", () => {
    const out = mergeCaptured([{ fbid: "7" }], [{ id: "7", full: FULL }]);
    expect(out[0].width).toBeNull();
    expect(out[0].height).toBeNull();
  });
});

describe("downloadUrlFor", () => {
  it("is the uncropped image or nothing at all", () => {
    expect(downloadUrlFor({ full: FULL, thumb: THUMB })).toBe(FULL);
    // The crop is NOT a fallback — handing it over as the photo is the defect.
    expect(downloadUrlFor({ thumb: THUMB })).toBeNull();
    expect(downloadUrlFor({})).toBeNull();
    expect(downloadUrlFor(null)).toBeNull();
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

describe("summarize / unresolvedPhotos", () => {
  it("counts resolved vs pending", () => {
    expect(summarize([{ full: "a" }, { full: null }, { full: "b" }])).toEqual({ total: 3, resolved: 2, pending: 1 });
    expect(summarize([])).toEqual({ total: 0, resolved: 0, pending: 0 });
  });
  it("hands back the records that have no full image", () => {
    const recs = [{ fbid: "1", full: "a" }, { fbid: "2", thumb: THUMB }, null];
    expect(unresolvedPhotos(recs).map((r) => r.fbid)).toEqual(["2"]);
    expect(unresolvedPhotos(null)).toEqual([]);
  });
});

describe("unresolvedManifest", () => {
  it("lists every missing photo with a permalink to check it by hand", () => {
    const txt = unresolvedManifest(
      [
        { fbid: "1", full: FULL },
        { fbid: "2", thumb: THUMB, set: "a.5" },
        { fbid: "3", permalink: "https://www.facebook.com/photo/?fbid=3" },
      ],
      "Astra Vale",
    );
    expect(txt).toContain("2 de 3");
    expect(txt).toContain("Astra Vale");
    expect(txt).toContain("2\thttps://www.facebook.com/photo/?fbid=2&set=a.5");
    expect(txt).toContain("3\thttps://www.facebook.com/photo/?fbid=3");
    expect(txt).not.toContain("\n1\t"); // the resolved one is in the ZIP, not the list
    expect(txt.endsWith("\n")).toBe(true);
  });

  it("says nothing when every photo resolved, so no entry is written", () => {
    expect(unresolvedManifest([{ fbid: "1", full: FULL }], "Astra")).toBeNull();
    expect(unresolvedManifest([], "Astra")).toBeNull();
    expect(unresolvedManifest(null, null)).toBeNull();
  });

  it("survives a missing owner", () => {
    const txt = unresolvedManifest([{ fbid: "2" }], null);
    expect(txt).toContain("1 de 1");
    expect(txt).not.toContain("Perfil:");
  });
});

describe("selectForZip", () => {
  const recs = [
    { fbid: "1", full: "a.jpg" },
    { fbid: "2", full: null },
    { fbid: "3", full: "c.jpg" },
    { fbid: "4", full: "d.jpg" },
  ];

  it("only takes photos whose uncropped url was captured", () => {
    const { batch, unresolved, skipped } = selectForZip(recs, { maxCount: 10 });
    expect(batch.map((r) => r.fbid)).toEqual(["1", "3", "4"]);
    expect(batch.map((r) => r.url)).toEqual(["a.jpg", "c.jpg", "d.jpg"]);
    expect(unresolved).toBe(1);
    expect(skipped).toBe(0);
  });

  it("counts a thumbnail-only record as unresolved, not as a download", () => {
    const { batch, unresolved } = selectForZip([{ fbid: "1", thumb: THUMB }], { maxCount: 10 });
    expect(batch).toEqual([]);
    expect(unresolved).toBe(1);
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

  it("does not mutate the records it selects", () => {
    const input = [{ fbid: "1", full: FULL }];
    selectForZip(input, { maxCount: 10 });
    expect(input[0]).toEqual({ fbid: "1", full: FULL });
  });
});

// ---------------------------------------------------------------------------
// CAPS. These are the tool's only untested paths: the profile it was built on
// has 43 photos against caps of 300/60 and 150-per-ZIP, so nothing here can be
// reached live. Each test drives the cap with a fake tile set or fake byte
// sizes, and then asserts the run REPORTS it — a cap that truncates in silence
// is the defect, not the cap.
// ---------------------------------------------------------------------------
describe("harvest caps", () => {
  it("leaves a normal run alone", () => {
    // The reference profile, to scale: 43 photos, 4 scrolls, grid done.
    expect(harvestCap({ photos: 43, scrolls: 4, growing: false })).toBeNull();
    expect(harvestCap({})).toBeNull();
    expect(harvestCap()).toBeNull();
  });

  it("stops the harvest at the photo cap and names it", () => {
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
    expect(capMessage(reason, HARVEST_CAPS)).toContain("300");
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

  it("gives each cap its own sentence, with advice that is actually true", () => {
    const said = ["photos", "scroll"].map((r) => capMessage(r, HARVEST_CAPS));
    expect(new Set(said).size).toBe(2);
    for (const s of said) expect(s.length).toBeGreaterThan(20);
    // "colete de novo" is a lie at the photo cap: a repeat collect re-reads the
    // same first 300 tiles into a store that is already full.
    expect(capMessage("scroll", HARVEST_CAPS)).toContain("colete de novo");
    expect(capMessage("photos", HARVEST_CAPS)).toContain("limpe a lista");
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

  it("points an unresolved photo at the list inside the archive", () => {
    // The gap must be findable from the download itself, not only from a panel
    // line that is gone as soon as the user closes the side panel.
    const note = zipNotes({ unresolved: 3 });
    expect(note).toContain("3 sem a imagem inteira");
    expect(note).toContain(UNRESOLVED_ENTRY);
  });

  it("stacks every reason a run fell short into one line", () => {
    const note = zipNotes({ skipped: 5, unresolved: 3, stoppedAt: 12, failed: 2, maxCount: 150, maxBytes: 4e8 });
    expect(note).toContain("5 foto(s)");
    expect(note).toContain("3 sem a imagem inteira");
    expect(note).toContain("parou em 12");
    expect(note).toContain("2 falharam");
    expect(note.split(" · ")).toHaveLength(4);
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
