import { describe, it, expect } from "vitest";
import {
  DOWNLOAD_ROOT,
  downloadPath,
  underDownloadRoot,
  kindFromExt,
  sanitizeFilenamePart,
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
  expect(path.startsWith(DOWNLOAD_ROOT + "/")).toBe(true);
}

describe("downloadPath", () => {
  // The tree used to be root → platform → kind: 22 directories, with the platform
  // spelled a second time in every file name (fb-/ig-/tt-/pin-) and the kind a
  // second time in every extension. Now there are three buckets and one job for
  // them: keep a 200-cover thumb dump and a pile of JSON out of the way of the
  // media you actually went looking for.
  it("sorts by what the file IS, not by where it came from", () => {
    expect(downloadPath("video", "ig-ivy-X1.mp4")).toBe("social-mate/videos/ig-ivy-X1.mp4");
    expect(downloadPath("video", "tt-creator-1.mp4")).toBe("social-mate/videos/tt-creator-1.mp4");
    expect(downloadPath("image", "pin-user-9.jpg")).toBe("social-mate/imagens/pin-user-9.jpg");
    expect(downloadPath("image", "fb-perfil-9.jpg")).toBe("social-mate/imagens/fb-perfil-9.jpg");
  });

  it("keeps covers with the other images — the -thumb suffix already marks them", () => {
    expect(downloadPath("thumb", "fb-page-1-thumb.jpg")).toBe("social-mate/imagens/fb-page-1-thumb.jpg");
  });

  it("files everything that is data rather than media under dados", () => {
    expect(downloadPath("comments", "tt-999-x.json")).toBe("social-mate/dados/tt-999-x.json");
    expect(downloadPath("transcript", "fb-transcricao-1.txt")).toBe("social-mate/dados/fb-transcricao-1.txt");
    expect(downloadPath("sheet", "ig-tag_x-2026-08-15.xlsx")).toBe("social-mate/dados/ig-tag_x-2026-08-15.xlsx");
  });

  // fbPhotos names its album archive through the "image" kind, so under the old
  // per-platform map a ZIP landed in the photos folder. The extension is the
  // honest signal about what the bytes are, so it overrules the declared kind.
  it("lets the extension overrule a kind that would misfile the bytes", () => {
    expect(downloadPath("image", "fb-perfil-2026-08-16.zip")).toBe("social-mate/dados/fb-perfil-2026-08-16.zip");
    expect(downloadPath("image", "tt-creator-1.json")).toBe("social-mate/dados/tt-creator-1.json");
    expect(downloadPath("video", "ig-ivy-X1.vtt")).toBe("social-mate/dados/ig-ivy-X1.vtt");
    // …but only for data types. A .mov declared as an image is still an image
    // folder question, not a licence to re-file every mismatch.
    expect(downloadPath("image", "pin-user-9.png")).toBe("social-mate/imagens/pin-user-9.png");
  });

  it("keeps the file name exactly as the caller built it", () => {
    // Only the FOLDER changed in 0.80.0. The platform prefix, the author, the id
    // and the -thumb suffix are all still what the media libs produced.
    for (const name of ["ig-user-code_2.mp4", "fb-Astra Vale-122.jpg", "pin-user-1.webp"]) {
      expect(downloadPath("video", name).endsWith("/" + name)).toBe(true);
    }
  });

  it("never lets an owner name escape the folder", () => {
    // A profile can literally be named "../../etc" — Chrome would reject the download
    // outright, and the call sites swallow that error.
    const evil = downloadPath("thumb", "../../etc/passwd");
    assertAcceptableToChrome(evil);
    expect(evil).toBe("social-mate/imagens/etc/passwd");

    const absolute = downloadPath("video", "/etc/hosts.mp4");
    assertAcceptableToChrome(absolute);

    const windows = downloadPath("video", "..\\..\\Windows\\System32\\x.mp4");
    assertAcceptableToChrome(windows);
    expect(windows).toBe("social-mate/videos/Windows/System32/x.mp4");

    const dotdot = downloadPath("video", "..");
    assertAcceptableToChrome(dotdot);
  });

  it("scrubs characters that break a download or a filesystem", () => {
    expect(downloadPath("video", 'a:b*c?d"e<f>g|h.mp4')).toBe("social-mate/videos/a_b_c_d_e_f_g_h.mp4");
    // Accents and emoji are legal and must survive — Brazilian profile names use them.
    expect(downloadPath("image", "fb-Astra Valé ✦-9.jpg")).toBe("social-mate/imagens/fb-Astra Valé ✦-9.jpg");
  });

  it("never returns a folder with no file, whatever the caller passes", () => {
    for (const bad of [null, undefined, "", "   ", "/", "..", "././."]) {
      const p = downloadPath("video", bad);
      assertAcceptableToChrome(p);
      expect(p).toBe("social-mate/videos/arquivo");
    }
  });

  it("falls back to the root rather than inventing a folder for a kind it doesn't know", () => {
    expect(downloadPath("banana", "x.mp4")).toBe("social-mate/x.mp4");
    expect(downloadPath(null, "x.mp4")).toBe("social-mate/x.mp4");
  });
});

describe("underDownloadRoot", () => {
  it("returns an already-rooted path byte-identical", () => {
    for (const p of [
      "social-mate/videos/ig-ivy-X1.mp4",
      "social-mate/dados/run-x.json",
      downloadPath("video", "pin-user-1.mp4"),
    ]) {
      expect(underDownloadRoot(p)).toBe(p);
    }
  });

  // background.js's resolveDownloadPath tells a finished path from a bare name by
  // its ROOT SEGMENT, because a panel sends `kind: "video"` alongside a path it
  // already built. Keying off `kind` instead produced
  // "social-mate/videos/social-mate/videos/tt-x.mp4" — this is the property that
  // makes the guard safe to apply twice.
  it("is idempotent, so a finished path can be re-checked without nesting", () => {
    const once = downloadPath("video", "tt-creator-1.mp4");
    expect(underDownloadRoot(once)).toBe(once);
    expect(underDownloadRoot(underDownloadRoot(once))).toBe(once);
  });

  it("re-roots anything a caller forgot to build with downloadPath", () => {
    // This is the guard that makes it impossible to land in the Downloads ROOT —
    // the exact mess this module exists to end.
    expect(underDownloadRoot("ig-ivy-X1.mp4")).toBe("social-mate/ig-ivy-X1.mp4");
    expect(underDownloadRoot("socialmate-comments/fb-1.json")).toBe(
      "social-mate/socialmate-comments/fb-1.json",
    );
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
      assertAcceptableToChrome(underDownloadRoot(evil));
    }
    expect(underDownloadRoot("/etc/passwd")).toBe("social-mate/etc/passwd");
    expect(underDownloadRoot("C:\\Windows\\x.mp4")).toBe("social-mate/Windows/x.mp4");
    expect(underDownloadRoot(null)).toBe("social-mate/arquivo");
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
