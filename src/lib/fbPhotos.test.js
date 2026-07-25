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
  pickBest,
  dedupeByFbid,
  summarize,
  selectForZip,
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
