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
  it("puts every platform's media under one root, by platform then by kind", () => {
    expect(downloadPath("instagram", "video", "ig-ivy-X1.mp4")).toBe(
      "social-mate/instagram/videos/ig-ivy-X1.mp4",
    );
    expect(downloadPath("instagram", "image", "ig-ivy-X1.jpg")).toBe(
      "social-mate/instagram/imagens/ig-ivy-X1.jpg",
    );
    expect(downloadPath("tiktok", "video", "tt-creator-1.mp4")).toBe(
      "social-mate/tiktok/videos/tt-creator-1.mp4",
    );
    expect(downloadPath("pinterest", "image", "pin-user-9.jpg")).toBe(
      "social-mate/pinterest/imagens/pin-user-9.jpg",
    );
    // Facebook says "fotos", not "imagens" — the word Facebook itself uses in pt-BR.
    expect(downloadPath("facebook", "image", "fb-perfil-9.jpg")).toBe(
      "social-mate/facebook/fotos/fb-perfil-9.jpg",
    );
    expect(downloadPath("facebook", "thumb", "fb-page-1.jpg")).toBe(
      "social-mate/facebook/miniaturas/fb-page-1.jpg",
    );
    expect(downloadPath("tiktok", "comments", "tt-999-x.json")).toBe(
      "social-mate/tiktok/comentarios/tt-999-x.json",
    );
  });

  it("has no session/run-log pseudo-platform (removed in 0.68.0 with the run logs)", () => {
    expect(downloadPath("sessions", null, "run-2026-07-25.json")).toBe(
      "social-mate/run-2026-07-25.json",
    );
  });

  it("keeps the file name exactly as the caller built it", () => {
    // The point of the refactor: only the FOLDER changes, never the name.
    for (const name of ["ig-user-code_2.mp4", "fb-Astra Vale-122.jpg", "pin-user-1.webp"]) {
      expect(downloadPath("instagram", "video", name).endsWith("/" + name)).toBe(true);
    }
  });

  it("never lets an owner name escape the folder", () => {
    // A profile can literally be named "../../etc" — Chrome would reject the download
    // outright, and the call sites swallow that error.
    const evil = downloadPath("facebook", "thumb", "../../etc/passwd");
    assertAcceptableToChrome(evil);
    expect(evil).toBe("social-mate/facebook/miniaturas/etc/passwd");

    const absolute = downloadPath("instagram", "video", "/etc/hosts.mp4");
    assertAcceptableToChrome(absolute);

    const windows = downloadPath("instagram", "video", "..\\..\\Windows\\System32\\x.mp4");
    assertAcceptableToChrome(windows);
    expect(windows).toBe("social-mate/instagram/videos/Windows/System32/x.mp4");

    const dotdot = downloadPath("tiktok", "video", "..");
    assertAcceptableToChrome(dotdot);
  });

  it("scrubs characters that break a download or a filesystem", () => {
    expect(downloadPath("tiktok", "video", 'a:b*c?d"e<f>g|h.mp4')).toBe(
      "social-mate/tiktok/videos/a_b_c_d_e_f_g_h.mp4",
    );
    // Accents and emoji are legal and must survive — Brazilian profile names use them.
    expect(downloadPath("facebook", "image", "fb-Astra Valé ✦-9.jpg")).toBe(
      "social-mate/facebook/fotos/fb-Astra Valé ✦-9.jpg",
    );
  });

  it("never returns a folder with no file, whatever the caller passes", () => {
    for (const bad of [null, undefined, "", "   ", "/", "..", "././."]) {
      const p = downloadPath("instagram", "video", bad);
      assertAcceptableToChrome(p);
      expect(p).toBe("social-mate/instagram/videos/arquivo");
    }
  });

  it("falls back to the root rather than inventing folders for an unknown platform/kind", () => {
    expect(downloadPath("myspace", "video", "x.mp4")).toBe("social-mate/x.mp4");
    expect(downloadPath("instagram", "banana", "x.mp4")).toBe("social-mate/instagram/x.mp4");
  });
});

describe("underDownloadRoot", () => {
  it("returns an already-rooted path byte-identical", () => {
    for (const p of [
      "social-mate/instagram/videos/ig-ivy-X1.mp4",
      "social-mate/sessoes/run-x.json",
      downloadPath("pinterest", "video", "pin-user-1.mp4"),
    ]) {
      expect(underDownloadRoot(p)).toBe(p);
    }
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
