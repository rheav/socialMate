// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { FB_DL_FOLDERS, IG_DL_IDS, igDlFilesOf, igDlTip, removeIgDlButtons, syncIgDlButtons } from "./igDlButtons.js";

const name = (rec, ext, idx) => `${rec.username}-ig-${rec.code}${idx != null ? `_${idx}` : ""}.${ext}`;
const ext = (url, kind) => (url && /\.mp4/.test(url) ? "mp4" : kind === "video" ? "mp4" : "jpg");

afterEach(() => {
  document.body.innerHTML = "";
  document.getElementById("fbw-dl-btn-style")?.remove();
});

describe("igDlFilesOf", () => {
  const reel = { username: "mirelda.amber", code: "R1", media_type: "video", image: "https://cdn/r1.jpg", thumb: "https://cdn/r1t.jpg", video: "https://cdn/r1.mp4" };
  const carousel = {
    username: "iivymooon", code: "C1", media_type: "carousel", image: "https://cdn/c1.jpg",
    carousel: [{ media_type: "photo", image: "https://cdn/s1.jpg" }, { media_type: "video", image: "https://cdn/s2.jpg", video: "https://cdn/s2.mp4" }],
  };

  it("makes one cover per post, carousels included", () => {
    expect(igDlFilesOf(reel, "covers", name, ext)).toEqual([{ url: "https://cdn/r1.jpg", kind: "image", filename: "mirelda.amber-ig-R1.jpg" }]);
    expect(igDlFilesOf(carousel, "covers", name, ext)).toHaveLength(1);
  });

  it("makes the video of a reel, and every slide of a carousel, numbered", () => {
    expect(igDlFilesOf(reel, "posts", name, ext)).toEqual([{ url: "https://cdn/r1.mp4", kind: "video", filename: "mirelda.amber-ig-R1.mp4" }]);
    expect(igDlFilesOf(carousel, "posts", name, ext)).toEqual([
      { url: "https://cdn/s1.jpg", kind: "image", filename: "iivymooon-ig-C1_1.jpg" },
      { url: "https://cdn/s2.mp4", kind: "video", filename: "iivymooon-ig-C1_2.mp4" },
    ]);
  });

  it("keeps a reel whose video link has not come in as a file with no url, never its cover", () => {
    expect(igDlFilesOf({ ...reel, video: null }, "posts", name, ext)).toEqual([{ url: null, kind: "video", filename: "mirelda.amber-ig-R1.mp4" }]);
  });
});

describe("igDlTip", () => {
  it("says what a click does, in each state", () => {
    expect(igDlTip("covers", { state: "idle", posts: 16 })).toBe("Baixar 16 capas");
    expect(igDlTip("posts", { state: "idle", posts: 16 })).toBe("Baixar 16 posts e reels");
    expect(igDlTip("posts", { state: "idle", posts: 1 })).toBe("Baixar 1 post");
    expect(igDlTip("covers", { state: "empty", posts: 0 })).toBe("Role a grade: nenhum post carregado ainda");
    expect(igDlTip("covers", { state: "busy", total: 16, done: 7 })).toBe("Baixando 7 de 16… clique para parar");
    expect(igDlTip("covers", { state: "done", total: 16, done: 16 })).toBe("16 capas baixadas. Clique para baixar de novo");
    expect(igDlTip("posts", { state: "partial", total: 16, done: 14, noLink: 2 })).toBe(
      "14 de 16 baixados. 2 não vieram: clique para tentar só eles. 2 vídeos ainda sem link: espere uns segundos.",
    );
    expect(igDlTip("posts", { state: "partial", total: 16, done: 7, stopped: true })).toBe("Parado: 7 de 16 baixados. Faltam 9: clique para continuar");
  });

  it("adapts idle and empty tooltips for Facebook reels and off-tab profile views", () => {
    expect(FB_DL_FOLDERS).toEqual({ covers: "capas", posts: "reels" });
    expect(igDlTip("covers", { state: "idle", posts: 10 }, "facebook")).toBe("Baixar 10 capas");
    expect(igDlTip("posts", { state: "idle", posts: 10 }, "facebook")).toBe("Baixar 10 reels");
    expect(igDlTip("posts", { state: "idle", posts: 1 }, "facebook")).toBe("Baixar 1 reel");
    expect(igDlTip("covers", { state: "empty", posts: 0 }, "facebook")).toBe("Role a grade: nenhum reel carregado ainda");
    expect(igDlTip("posts", { state: "empty", posts: 0, offTab: true }, "facebook")).toBe(
      "Abra a aba Reels do perfil para baixar capas e reels",
    );
  });
});

describe("syncIgDlButtons", () => {
  const HEADER = '<header><div class="row"><div id="fbw-hub-btn" role="button"></div><span class="after"></span></div></header>';
  const states = { covers: { state: "idle", posts: 3 }, posts: { state: "busy", total: 4, done: 1 } };

  it("puts the two buttons right after the Hub button, once, and says what each does", () => {
    document.body.innerHTML = HEADER;
    const hub = document.getElementById("fbw-hub-btn");
    syncIgDlButtons(document, { anchor: hub, states, onClick() {} });
    syncIgDlButtons(document, { anchor: hub, states, onClick() {} });
    expect(hub.nextElementSibling.id).toBe(IG_DL_IDS.covers);
    expect(hub.nextElementSibling.nextElementSibling.id).toBe(IG_DL_IDS.posts);
    expect(document.querySelectorAll(".fbw-dl")).toHaveLength(2);
    const covers = document.getElementById(IG_DL_IDS.covers);
    expect(covers.getAttribute("aria-label")).toBe("Baixar 3 capas");
    expect(document.getElementById(IG_DL_IDS.posts).querySelector(".fbw-dl-prog").getAttribute("stroke-dasharray")).toBe("22.8 91.1");
  });

  it("runs the click with its kind, by mouse or keyboard", () => {
    document.body.innerHTML = HEADER;
    const onClick = vi.fn();
    syncIgDlButtons(document, { anchor: document.getElementById("fbw-hub-btn"), states, onClick });
    document.getElementById(IG_DL_IDS.covers).click();
    document.getElementById(IG_DL_IDS.posts).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onClick.mock.calls).toEqual([["covers"], ["posts"]]);
  });

  it("applies Facebook inline alignment, surface ring variable, and stacking CSS when site='facebook'", () => {
    document.body.innerHTML = HEADER;
    const hub = document.getElementById("fbw-hub-btn");
    syncIgDlButtons(document, {
      anchor: hub,
      site: "facebook",
      ring: "var(--surface-background, #fff)",
      states: { covers: { state: "idle", posts: 10 }, posts: { state: "idle", posts: 10 } },
      onClick() {},
    });
    const postsBtn = document.getElementById(IG_DL_IDS.posts);
    expect(postsBtn.dataset.site).toBe("facebook");
    expect(postsBtn.style.getPropertyValue("--fbw-dl-ring")).toBe("var(--surface-background, #fff)");
    expect(postsBtn.getAttribute("aria-label")).toBe("Baixar 10 reels");
    const css = document.getElementById("fbw-dl-btn-style").textContent;
    expect(css).toContain('.fbw-dl[data-site="facebook"]{vertical-align:middle;margin-left:4px}');
    expect(css).toContain("var(--fbw-dl-ring");
    expect(css).toContain('[role="main"] div:has(.fbw-dl[data-site="facebook"]:is(:hover,:focus-visible)){z-index:5}');
  });

  it("dims only the glyph of an empty button, so its tip stays solid and readable", () => {
    document.body.innerHTML = HEADER;
    syncIgDlButtons(document, { anchor: document.getElementById("fbw-hub-btn"), states, onClick() {} });
    const css = document.getElementById("fbw-dl-btn-style").textContent;
    expect(css).toContain('.fbw-dl[data-state="empty"]>svg.fbw-dl-glyph{opacity:.35}');
    expect(css).not.toContain('.fbw-dl[data-state="empty"]{opacity');
  });

  it("goes away with the Hub button", () => {
    document.body.innerHTML = HEADER;
    syncIgDlButtons(document, { anchor: document.getElementById("fbw-hub-btn"), states, onClick() {} });
    syncIgDlButtons(document, { anchor: null, states, onClick() {} });
    expect(document.querySelectorAll(".fbw-dl")).toHaveLength(0);
    removeIgDlButtons(document);
  });
});
