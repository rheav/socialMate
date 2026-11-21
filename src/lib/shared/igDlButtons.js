// The profile's download buttons (socialMate 1.44): right after the Hub button in an
// Instagram profile's header, "Baixar capas" (one cover per post) and "Baixar posts"
// (each post's video or photo, every slide of a carousel), for the posts of THIS
// profile the page has loaded so far. INLINED into the Instagram bridge — see
// src/lib/shared/README.md before editing (no imports allowed in this file).
//
// The bridge owns the records and the downloads; this file owns the two buttons,
// what they say, and which files a post makes. Nothing here asks Instagram for
// anything: a reel's video link comes from the per-media lookup the page already
// runs (main-world.js enrichOne), and a video still without one is reported, not
// fetched. Approved mockup: docs/superpowers/specs/2026-11-17-ig-baixar-perfil/.

export const IG_DL_KINDS = ["covers", "posts"];
export const IG_DL_IDS = { covers: "fbw-dl-covers", posts: "fbw-dl-posts" };
/** The folder under the profile's: <handle>/capas, <handle>/posts. */
export const IG_DL_FOLDERS = { covers: "capas", posts: "posts" };
/** Facebook's (1.45): <profile>/capas, <profile>/reels — a profile's grid there is reels only. */
export const FB_DL_FOLDERS = { covers: "capas", posts: "reels" };
export const IG_DL_STYLE_ID = "fbw-dl-btn-style";

// Lucide's image-down, and the extension's own layers glyph (the story's "Baixar tudo").
const IG_DL_ICONS = {
  covers: '<path d="M10.3 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10l-3.1-3.1a2 2 0 0 0-2.814.014L6 21"/><path d="m14 19 3 3v-5.5"/><path d="m17 22 3-3"/><circle cx="9" cy="9" r="2"/>',
  posts: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>',
};
// The progress ring's length (r = 14.5).
const IG_DL_RING = 91.1;

// Same box, tip and dot as the Hub button beside it (HUB_BTN_CSS), so the three read as one row.
// Facebook (measured 2026-11-21): the row is inline text in a 32 px span, the dot's ring is
// the surface colour (--fbw-dl-ring), and the header's z-index:0 rows would cover the tip.
export const IG_DL_CSS = `
.fbw-dl{position:relative;width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;
  flex:none;border-radius:8px;cursor:pointer;color:inherit}
.fbw-dl:hover{background:rgba(128,128,128,.16)}
.fbw-dl:focus-visible{outline:2px solid #2e6ead;outline-offset:2px}
.fbw-dl>svg{width:20px;height:20px;display:block;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.fbw-dl[data-state="empty"]{opacity:.35;cursor:default}
.fbw-dl[data-state="empty"]:hover{background:none}
.fbw-dl[data-state="busy"]>svg.fbw-dl-glyph{opacity:.55}
.fbw-dl>svg.fbw-dl-ring{position:absolute;inset:0;width:32px;height:32px;transform:rotate(-90deg);display:none;stroke-width:2.5}
.fbw-dl[data-state="busy"]>svg.fbw-dl-ring{display:block}
.fbw-dl-ring .fbw-dl-track{stroke:rgba(128,128,128,.3)}
.fbw-dl-ring .fbw-dl-prog{stroke:#8ecae6;transition:stroke-dasharray .2s}
.fbw-dl .fbw-dl-dot{position:absolute;right:2px;top:3px;width:9px;height:9px;border-radius:50%;display:none;
  box-shadow:0 0 0 2px var(--fbw-dl-ring, rgb(var(--ig-primary-background, 255, 255, 255)))}
.fbw-dl[data-state="done"] .fbw-dl-dot{display:block;background:#22c55e}
.fbw-dl[data-state="partial"] .fbw-dl-dot{display:block;background:#ef4444}
.fbw-dl::after{content:attr(data-tip);position:absolute;top:calc(100% + 6px);left:50%;transform:translateX(-50%);
  z-index:10;width:max-content;max-width:260px;white-space:normal;text-align:center;pointer-events:none;padding:6px 10px;
  letter-spacing:normal;text-transform:none;
  border-radius:6px;background:#262626;color:#f5f5f5;font:500 12px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  opacity:0;transition:opacity .12s}
.fbw-dl:hover::after,.fbw-dl:focus-visible::after{opacity:1}
.fbw-dl[data-site="facebook"]{vertical-align:middle;margin-left:4px}
[role="main"] div:has(.fbw-dl[data-site="facebook"]:is(:hover,:focus-visible)){z-index:5}`;

/**
 * The files one post makes: [{ url, kind: "image" | "video", filename }].
 * `name(rec, ext, idx)` and `ext(url, kind)` are the bridge's baseNameFor and
 * extFromUrl (this file cannot import them). A video whose link has not come in yet
 * is a file with `url: null`: it counts and fails, so the button can say to wait.
 */
export function igDlFilesOf(rec, kind, name, ext) {
  if (kind === "covers") {
    const url = rec.image || rec.thumb || null;
    return [{ url, kind: "image", filename: name(rec, ext(url, "image")) }];
  }
  const one = (m, idx) => {
    const k = m.media_type === "video" ? "video" : "image";
    const url = (k === "video" ? m.video : m.image) || null;
    return { url, kind: k, filename: name(rec, ext(url, k), idx) };
  };
  if (rec.media_type === "carousel" && Array.isArray(rec.carousel) && rec.carousel.length) {
    return rec.carousel.map((slide, i) => one(slide, i + 1));
  }
  return [one(rec)];
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * What a button says. `s`: { state: "idle" | "empty" | "busy" | "done" | "partial",
 * posts, total, done, noLink, stopped }. `posts` is how many posts are loaded; `total`
 * and `done` count files (a carousel is several). `site` "facebook" speaks of reels,
 * and `offTab` is a Facebook profile away from its Reels tab.
 */
export function igDlTip(kind, s, site = "instagram") {
  const covers = kind === "covers";
  const fb = site === "facebook";
  if (s.state === "empty") {
    if (s.offTab) return "Abra a aba Reels do perfil para baixar capas e reels";
    return `Role a grade: nenhum ${fb ? "reel" : "post"} carregado ainda`;
  }
  if (s.state === "busy") return `Baixando ${s.done} de ${s.total}… clique para parar`;
  if (s.state === "done") {
    return `${plural(s.total, covers ? "capa baixada" : "arquivo baixado", covers ? "capas baixadas" : "arquivos baixados")}. Clique para baixar de novo`;
  }
  if (s.state === "partial") {
    const miss = s.total - s.done;
    if (s.stopped) return `Parado: ${s.done} de ${s.total} baixados. ${miss === 1 ? "Falta 1" : `Faltam ${miss}`}: clique para continuar`;
    const wait = s.noLink ? ` ${plural(s.noLink, "vídeo ainda sem link", "vídeos ainda sem link")}: espere uns segundos.` : "";
    return `${s.done} de ${s.total} baixados. ${miss === 1 ? "1 não veio: clique para tentar só ele." : `${miss} não vieram: clique para tentar só eles.`}${wait}`;
  }
  if (covers) return `Baixar ${plural(s.posts, "capa", "capas")}`;
  if (fb) return `Baixar ${plural(s.posts, "reel", "reels")}`;
  return `Baixar ${s.posts === 1 ? "1 post" : `${s.posts} posts e reels`}`;
}

/** Take the two buttons away (not a profile, the Hub button gone, a takeover). */
export function removeIgDlButtons(doc) {
  for (const id of Object.values(IG_DL_IDS)) doc.getElementById(id)?.remove();
}

/**
 * Put the two buttons right after `anchor` (the Hub button), or take them away when
 * there is none. `states`: { covers, posts } as igDlTip reads them. `onClick(kind)`
 * runs on a click or Enter/Space. `site` and `ring` (Facebook): the look and the dot
 * ring's colour, as the Hub button's place gives them. Idempotent, and it only writes
 * what changed: the page watches its own subtree for mutations.
 */
export function syncIgDlButtons(doc, { anchor, states, onClick, site = null, ring = null }) {
  if (!anchor || !anchor.parentElement) {
    removeIgDlButtons(doc);
    return;
  }
  let style = doc.getElementById(IG_DL_STYLE_ID);
  if (!style) {
    style = doc.createElement("style");
    style.id = IG_DL_STYLE_ID;
    (doc.head || doc.documentElement).appendChild(style);
  }
  if (style.textContent !== IG_DL_CSS) style.textContent = IG_DL_CSS;
  let prev = anchor;
  for (const kind of IG_DL_KINDS) {
    const existing = doc.getElementById(IG_DL_IDS[kind]);
    // A button another isolated world made (before an extension reload) carries a dead listener: replace it.
    let btn = existing && existing.__fbwDlFire ? existing : null;
    if (existing && !btn) existing.remove();
    if (!btn) {
      btn = doc.createElement("div");
      btn.id = IG_DL_IDS[kind];
      btn.className = "fbw-dl";
      btn.setAttribute("role", "button");
      btn.tabIndex = 0;
      btn.innerHTML =
        `<svg class="fbw-dl-glyph" viewBox="0 0 24 24" aria-hidden="true">${IG_DL_ICONS[kind]}</svg>` +
        `<svg class="fbw-dl-ring" viewBox="0 0 32 32" aria-hidden="true"><circle class="fbw-dl-track" cx="16" cy="16" r="14.5" fill="none"/>` +
        `<circle class="fbw-dl-prog" cx="16" cy="16" r="14.5" fill="none" stroke-dasharray="0 ${IG_DL_RING}"/></svg>` +
        `<span class="fbw-dl-dot"></span>`;
      const fire = (e) => {
        e.preventDefault();
        e.stopPropagation();
        btn.__fbwDlClick?.();
      };
      btn.__fbwDlFire = fire;
      btn.addEventListener("click", fire);
      btn.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") fire(e); });
    }
    btn.__fbwDlClick = () => onClick(kind);
    if (btn.previousElementSibling !== prev) prev.insertAdjacentElement("afterend", btn);
    if (site && btn.dataset.site !== site) btn.dataset.site = site;
    if (ring && btn.style.getPropertyValue("--fbw-dl-ring") !== ring) btn.style.setProperty("--fbw-dl-ring", ring);
    const s = states[kind];
    const tip = igDlTip(kind, s, site || "instagram");
    if (btn.dataset.state !== s.state) btn.dataset.state = s.state;
    if (btn.dataset.tip !== tip) {
      btn.dataset.tip = tip;
      btn.setAttribute("aria-label", tip);
    }
    const empty = s.state === "empty" ? "true" : null;
    if (btn.getAttribute("aria-disabled") !== empty) {
      if (empty) btn.setAttribute("aria-disabled", empty);
      else btn.removeAttribute("aria-disabled");
    }
    const share = s.state === "busy" && s.total ? s.done / s.total : 0;
    const dash = `${(share * IG_DL_RING).toFixed(1)} ${IG_DL_RING}`;
    const prog = btn.querySelector(".fbw-dl-prog");
    if (prog && prog.getAttribute("stroke-dasharray") !== dash) prog.setAttribute("stroke-dasharray", dash);
    prev = btn;
  }
}
