import { describe, it, expect, afterEach } from "vitest";
import {
  DOWNLOAD_ROOT,
  downloadPath,
  underDownloadRoot,
  kindFromExt,
  sanitizeFilenamePart,
  setDownloadPrefs,
  normalizeDlPrefs,
  DEFAULT_DL_PREFS,
} from "./downloadPath.js";

// chrome.downloads rejects a filename that is absolute, contains a ".." component or
// carries a drive letter — and every call site in this extension swallows download
// errors, so a bad path fails INVISIBLY. That is what these assertions guard.
function assertAcceptableToChrome(path) {
  expect(path.startsWith("/")).toBe(false);
  expect(/^[A-Za-z]:/.test(path)).toBe(false);
  expect(path.split("/")).not.toContain("..");
  expect(path.split("/")).not.toContain(".");
  expect(path.split("/").every(Boolean)).toBe(true); // no empty segments
}

// Under the DEFAULT prefs everything also lands inside social-mate/. That is a
// property of the default folder, not of Chrome — since 0.99.0 the folder is a
// setting and may legitimately be empty (straight into the browser's download
// directory), so the two assertions are separate.
function assertUnderDefaultRoot(path) {
  assertAcceptableToChrome(path);
  if (DOWNLOAD_ROOT) {
    expect(path.startsWith(DOWNLOAD_ROOT + "/")).toBe(true);
  }
}

describe("downloadPath", () => {
  // The tree used to be root → platform → kind: 22 directories, with the platform
  // spelled a second time in every file name (fb-/ig-/tt-/pin-) and the kind a
  // second time in every extension. Now there are three buckets and one job for
  // them: keep a 200-cover thumb dump and a pile of JSON out of the way of the
  // media you actually went looking for.
  it("sorts by what the file IS, not by where it came from", () => {
    expect(downloadPath("video", "ivy-ig-X1.mp4")).toBe("videos/ivy-ig-X1.mp4");
    expect(downloadPath("video", "tt-creator-1.mp4")).toBe("videos/tt-creator-1.mp4");
    expect(downloadPath("image", "pin-user-9.jpg")).toBe("imagens/pin-user-9.jpg");
    expect(downloadPath("image", "fb-perfil-9.jpg")).toBe("imagens/fb-perfil-9.jpg");
  });

  it("keeps covers with the other images — the -thumb suffix already marks them", () => {
    expect(downloadPath("thumb", "fb-page-1-thumb.jpg")).toBe("imagens/fb-page-1-thumb.jpg");
  });

  it("files everything that is data rather than media under dados", () => {
    expect(downloadPath("comments", "tt-999-x.json")).toBe("dados/tt-999-x.json");
    expect(downloadPath("transcript", "fb-transcricao-1.txt")).toBe("dados/fb-transcricao-1.txt");
    expect(downloadPath("sheet", "ig-tag_x-2026-08-15.xlsx")).toBe("dados/ig-tag_x-2026-08-15.xlsx");
  });

  // fbPhotos names its album archive through the "image" kind, so under the old
  // per-platform map a ZIP landed in the photos folder. The extension is the
  // honest signal about what the bytes are, so it overrules the declared kind.
  it("lets the extension overrule a kind that would misfile the bytes", () => {
    expect(downloadPath("image", "fb-perfil-2026-08-16.zip")).toBe("dados/fb-perfil-2026-08-16.zip");
    expect(downloadPath("image", "tt-creator-1.json")).toBe("dados/tt-creator-1.json");
    expect(downloadPath("video", "ig-ivy-X1.vtt")).toBe("dados/ig-ivy-X1.vtt");
    // …but only for data types. A .mov declared as an image is still an image
    // folder question, not a licence to re-file every mismatch.
    expect(downloadPath("image", "pin-user-9.png")).toBe("imagens/pin-user-9.png");
  });

  it("keeps the file name exactly as the caller built it", () => {
    // Only the FOLDER changed in 0.80.0. The platform prefix, the author, the id
    // and the -thumb suffix are all still what the media libs produced.
    for (const name of ["ig-user-code_2.mp4", "Astra Vale-fb-122.jpg", "pin-user-1.webp"]) {
      expect(downloadPath("video", name).endsWith("/" + name)).toBe(true);
    }
  });

  it("never lets an owner name escape the folder", () => {
    // A profile can literally be named "../../etc" — Chrome would reject the download
    // outright, and the call sites swallow that error.
    const evil = downloadPath("thumb", "../../etc/passwd");
    assertUnderDefaultRoot(evil);
    expect(evil).toBe("imagens/etc/passwd");

    const absolute = downloadPath("video", "/etc/hosts.mp4");
    assertUnderDefaultRoot(absolute);

    const windows = downloadPath("video", "..\\..\\Windows\\System32\\x.mp4");
    assertUnderDefaultRoot(windows);
    expect(windows).toBe("videos/Windows/System32/x.mp4");

    const dotdot = downloadPath("video", "..");
    assertUnderDefaultRoot(dotdot);
  });

  it("scrubs characters that break a download or a filesystem", () => {
    expect(downloadPath("video", 'a:b*c?d"e<f>g|h.mp4')).toBe("videos/a_b_c_d_e_f_g_h.mp4");
    // Accents and emoji are legal and must survive — Brazilian profile names use them.
    expect(downloadPath("image", "fb-Astra Valé ✦-9.jpg")).toBe("imagens/fb-Astra Valé ✦-9.jpg");
  });

  it("never returns a folder with no file, whatever the caller passes", () => {
    for (const bad of [null, undefined, "", "   ", "/", "..", "././."]) {
      const p = downloadPath("video", bad);
      assertUnderDefaultRoot(p);
      expect(p).toBe("videos/arquivo");
    }
  });

  it("falls back to the root rather than inventing a folder for a kind it doesn't know", () => {
    expect(downloadPath("banana", "x.mp4")).toBe("x.mp4");
    expect(downloadPath(null, "x.mp4")).toBe("x.mp4");
  });
});

describe("underDownloadRoot", () => {
  it("returns an already-rooted path byte-identical", () => {
    for (const p of [
      "videos/ivy-ig-X1.mp4",
      "dados/run-x.json",
      downloadPath("video", "pin-user-1.mp4"),
    ]) {
      expect(underDownloadRoot(p)).toBe(p);
    }
  });

  // background.js's resolveDownloadPath tells a finished path from a bare name by
  // its ROOT SEGMENT, because a panel sends `kind: "video"` alongside a path it
  // already built. Keying off `kind` instead produced
  // "videos/videos/tt-x.mp4" — this is the property that
  // makes the guard safe to apply twice.
  it("is idempotent, so a finished path can be re-checked without nesting", () => {
    const once = downloadPath("video", "tt-creator-1.mp4");
    expect(underDownloadRoot(once)).toBe(once);
    expect(underDownloadRoot(underDownloadRoot(once))).toBe(once);
  });

  it("re-roots anything a caller forgot to build with downloadPath", () => {
    // This is the guard that makes it impossible to land in the configured folder's
    // PARENT — the mess this module exists to end.
    expect(underDownloadRoot("ig-ivy-X1.mp4")).toBe("ig-ivy-X1.mp4");
    // A folder this module never chose is DROPPED, not carried along. Since 0.99.0
    // the root is a setting, so a path can arrive built under an older one; keeping
    // only the file name plus a bucket we recognise is what makes the guard
    // idempotent under whatever the prefs say now. ("dados" here comes from the
    // .json extension, which overrules any kind a caller claimed.)
    expect(underDownloadRoot("socialmate-comments/fb-1.json")).toBe("dados/fb-1.json");
    // A bucket the module DOES own survives, so a finished path is not re-derived.
    expect(underDownloadRoot("videos/tt-a-1.mp4")).toBe("videos/tt-a-1.mp4");
  });

  it("rejects absolute paths, traversal and drive letters", () => {
    for (const evil of [
      "/etc/passwd",
      "../../../etc/passwd",
      "C:\\Windows\\System32\\x.mp4",
      "//server/share/x.mp4",
      "..",
      "",
      null,
    ]) {
      assertUnderDefaultRoot(underDownloadRoot(evil));
    }
    // Only the file name survives an unknown tree, so a traversal has nothing left
    // to traverse with.
    expect(underDownloadRoot("/etc/passwd")).toBe("passwd");
    expect(underDownloadRoot("C:\\Windows\\x.mp4")).toBe("x.mp4");
    expect(underDownloadRoot(null)).toBe("arquivo");
  });
});

describe("kindFromExt", () => {
  it("routes mixed-kind media by the actual media, not the platform default", () => {
    // A pin, an IG carousel child or a story can be either.
    for (const e of ["mp4", "MOV", "webm", "m4v", "mkv"]) expect(kindFromExt(e)).toBe("video");
    for (const e of ["jpg", "jpeg", "png", "webp", "gif", "", null]) expect(kindFromExt(e)).toBe("image");
  });
});

describe("sanitizeFilenamePart", () => {
  // Moved here from five byte-identical copies (fbPhotos/fbReels/igMedia/ttMedia/
  // pinMedia); those now re-export this one. Behaviour must not have changed.
  it("keeps the behaviour the media libs relied on", () => {
    expect(sanitizeFilenamePart('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j");
    expect(sanitizeFilenamePart("///both///")).toBe("both");
    expect(sanitizeFilenamePart("____only____")).toBe("only");
    expect(sanitizeFilenamePart(null)).toBe("");
    expect(sanitizeFilenamePart("x".repeat(80))).toHaveLength(40);
    expect(sanitizeFilenamePart("Astra Valé ✦")).toBe("Astra Valé ✦");
  });
});

// ---------------------------------------------------------------------------
// The folder is a setting (0.99.0). "sem folders e mais folders" — a flat folder
// sorts by name, and every name starts with the creator's handle, so the creator
// IS the grouping. Chrome still refuses an absolute path, so the setting is always
// relative to the browser's own download directory.
// ---------------------------------------------------------------------------
describe("download prefs", () => {
  afterEach(() => setDownloadPrefs(DEFAULT_DL_PREFS));

  it("defaults to root of downloads folder and migrates legacy social-mate", () => {
    expect(normalizeDlPrefs(undefined)).toEqual({ folder: "", flat: false });
    expect(normalizeDlPrefs({ folder: "social-mate" })).toEqual({ folder: "", flat: false });
    expect(downloadPath("video", "ivy-ig-X1.mp4")).toBe("videos/ivy-ig-X1.mp4");
  });

  it("puts everything in one folder when flat is on", () => {
    setDownloadPrefs({ folder: "pasta-teste", flat: true });
    expect(downloadPath("video", "ivy-ig-X1.mp4")).toBe("pasta-teste/ivy-ig-X1.mp4");
    expect(downloadPath("thumb", "ivy-ig-X1-thumb.jpg")).toBe("pasta-teste/ivy-ig-X1-thumb.jpg");
    expect(downloadPath("sheet", "ig-tag_soulmate-2026-09-22.xlsx")).toBe(
      "pasta-teste/ig-tag_soulmate-2026-09-22.xlsx",
    );
  });

  it("drops into the browser's download directory when the folder is empty", () => {
    setDownloadPrefs({ folder: "", flat: true });
    expect(downloadPath("video", "ivy-ig-X1.mp4")).toBe("ivy-ig-X1.mp4");
    expect(underDownloadRoot("ivy-ig-X1.mp4")).toBe("ivy-ig-X1.mp4");
  });

  it("accepts a nested folder and scrubs each segment", () => {
    setDownloadPrefs({ folder: "pesquisa/instagram", flat: true });
    expect(downloadPath("video", "ivy-ig-X1.mp4")).toBe("pesquisa/instagram/ivy-ig-X1.mp4");
  });

  it("cannot be talked into an absolute path, a drive letter or a traversal", () => {
    // chrome.downloads.download rejects all three outright, so a setting that
    // produced one would download nothing and say nothing.
    for (const folder of ["/Users/rheavictor/Downloads", "C:\\Users\\x", "../../etc", "..", "."]) {
      const p = downloadPath("video", "x.mp4");
      setDownloadPrefs({ folder, flat: true });
      assertAcceptableToChrome(downloadPath("video", "x.mp4"));
      expect(p).not.toMatch(/^\//);
    }
    setDownloadPrefs({ folder: "/Users/rheavictor/Downloads", flat: true });
    expect(downloadPath("video", "x.mp4")).toBe("Users/rheavictor/Downloads/x.mp4");
    setDownloadPrefs({ folder: "../../etc", flat: true });
    expect(downloadPath("video", "x.mp4")).toBe("etc/x.mp4");
  });

  it("re-files a path built under the previous prefs", () => {
    // The panel and the worker each cache the prefs, and a path can outlive a
    // change (a queued download, a blob minted before the switch). The guard has to
    // land it where the CURRENT prefs say, not where its builder thought.
    const old = "social-mate/videos/ivy-ig-X1.mp4";
    setDownloadPrefs({ folder: "baixados", flat: true });
    expect(underDownloadRoot(old)).toBe("baixados/ivy-ig-X1.mp4");
    setDownloadPrefs({ folder: "baixados", flat: false });
    expect(underDownloadRoot(old)).toBe("baixados/videos/ivy-ig-X1.mp4");
  });
});
