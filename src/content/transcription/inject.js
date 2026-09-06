// Content script (isolated world) — NO on-page UI. It detects the Facebook video
// currently in view, scrapes its metadata (id, author, caption, counts, thumb),
// and publishes it to the side panel (via the background SW). The panel renders a
// "Current video" card with Transcribe / Download buttons; when clicked, the panel
// asks us (through the background) to force-play that video and kick off the job.
//
// FB fetches media off the main thread (worker), so we can't read media URLs here.
// We key everything to the video's OWN id (read from its permalink) so metadata +
// tracks never get crossed between the several videos FB autoplays at once.

if (location.hostname.endsWith("facebook.com") && !window.__fbwTranscribeInit) {
  window.__fbwTranscribeInit = true;

  // ---- generation takeover ----
  // An extension reload creates a fresh isolated world but leaves the previous
  // generation's observers/timers RUNNING (only its chrome.* dies) — two
  // generations then fight over the rails (zombie rails, spinners resetting).
  // window.postMessage crosses isolated worlds: announce ourselves; any older
  // generation that hears a foreign announcement shuts itself down.
  const FBW_GEN = Date.now() + ":" + Math.random();
  let fbwDisabled = false;
  window.addEventListener("message", (e) => {
    if (
      e.source === window &&
      e.data &&
      e.data.__fbwTakeover &&
      e.data.__fbwTakeover !== FBW_GEN &&
      !fbwDisabled
    ) {
      fbwDisabled = true;
      try { btnObserver?.disconnect(); } catch {}
      try { clearTimeout(btnTimer); } catch {}
      // Drop this generation's UI — the new generation redecorates from scratch.
      document
        .querySelectorAll(".fbw-acts, .fbw-thumbbtn, #fbw-btn-style, #fbw-overlay")
        .forEach((el) => el.remove());
    }
  });
  window.postMessage({ __fbwTakeover: FBW_GEN }, "*");

  // which social network this capture came from (IG/TikTok added later)
  const PLATFORM = /instagram\.com$/.test(location.hostname)
    ? "instagram"
    : /tiktok\.com$/.test(location.hostname)
      ? "tiktok"
      : "facebook";

  // ---- FB embedded-JSON duration table (accurate, unlike efg) ----
  // FB's initial <script type="application/json"> blocks carry each video's
  // real id, its true playable_duration_in_ms, and (in the same subtree) the
  // caption. efg's duration_s LIES (preview-cut durations on full videos, live
  // repro), so we read the honest duration here and use it to disambiguate the
  // wire registry. Only the initial batch is present (pagination parses off the
  // main thread), so this is a HINT layer, not the whole story — the
  // prime-window wire attribution below is the always-available fallback.
  const normCap = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/…?\s*(see more|ver mais|ver más)\s*$/i, "")
      .trim()
      .slice(0, 120);
  // Scan the embedded JSON for the video whose caption matches this post's, or
  // (fallback) whose accurate duration matches the DOM video. Returns a
  // confident { id } or null. Runs on demand (job time), not on scroll.
  function fbEmbeddedResolve(domCaption, domDuration) {
    const cap = normCap(domCaption);
    const byCaption = new Set();
    const byDuration = new Set();
    for (const s of document.querySelectorAll('script[type="application/json"]')) {
      const t = s.textContent || "";
      if (t.indexOf("videoDeliveryLegacyFields") < 0 && t.indexOf("playable_duration_in_ms") < 0)
        continue;
      let data;
      try { data = JSON.parse(t); } catch { continue; }
      (function walk(o, capCtx, depth) {
        if (!o || typeof o !== "object" || depth > 26) return;
        if (Array.isArray(o)) { for (const v of o) walk(v, capCtx, depth + 1); return; }
        let cc = capCtx;
        if (o.message && typeof o.message.text === "string") cc = o.message.text;
        const id =
          typeof o.id === "string" && /^\d{6,}$/.test(o.id) &&
          (o.videoDeliveryLegacyFields || o.playable_duration_in_ms != null)
            ? o.id
            : null;
        if (id) {
          if (cap && cap.length >= 12) {
            const rc = normCap(cc);
            const n = Math.min(40, cap.length, rc.length);
            if (n >= 12 && cap.slice(0, n) === rc.slice(0, n)) byCaption.add(id);
          }
          const durMs = o.playable_duration_in_ms;
          if (durMs && Number.isFinite(domDuration) && Math.abs(durMs / 1000 - domDuration) <= 1.5)
            byDuration.add(id);
        }
        for (const k in o) walk(o[k], cc, depth + 1);
      })(data, null, 0);
    }
    if (byCaption.size === 1) return { id: [...byCaption][0] };
    if (byDuration.size === 1) return { id: [...byDuration][0] };
    return null;
  }

  // ---- pick the video currently in view ----
  // The video the user is WATCHING = the one most centered in the viewport. We score
  // by visible area minus distance-from-center. No "is playing" bonus: FB autoplays
  // several at once, so playing-state made the pick jump around and let an offscreen
  // playing video out-compete the centered one (e.g. the paused main video on /watch
  // never reclaimed focus after scrolling back up).
  function pickActiveVideo() {
    const vh = window.innerHeight,
      vw = window.innerWidth;
    let best = null,
      bestScore = -Infinity;
    document.querySelectorAll("video").forEach((v) => {
      const r = v.getBoundingClientRect();
      if (r.width < 140 || r.height < 100) return;
      const visH = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      const visW = Math.min(r.right, vw) - Math.max(r.left, 0);
      if (visH <= 0 || visW <= 0) return;
      const visArea = visH * visW;
      if (visArea / (r.width * r.height) < 0.35) return;
      const dist = Math.abs(r.top + r.height / 2 - vh / 2);
      const score = visArea - dist * 350;
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    });
    return best;
  }

  // ---- metadata scraping ----
  function grabThumb(videoEl) {
    // A real frame from the playing video (FB's MSE video is NOT canvas-tainted) —
    // beats the avatar/black poster fallbacks. 180px/q0.6: the Library card
    // renders ~250px wide, and the old 90px/q0.45 thumb read as pixelated there.
    try {
      if (videoEl.readyState >= 2 && videoEl.videoWidth) {
        const W = 180;
        const cv = document.createElement("canvas");
        cv.width = W;
        cv.height =
          Math.round(W * (videoEl.videoHeight / videoEl.videoWidth)) || 270;
        cv.getContext("2d").drawImage(videoEl, 0, 0, cv.width, cv.height);
        return cv.toDataURL("image/jpeg", 0.6);
      }
    } catch {}
    if (videoEl.poster) return videoEl.poster;
    const host = videoEl.closest('[role="article"]') || videoEl.closest("div");
    const img = host && host.querySelector('img[src*="fbcdn"]');
    return img ? img.src : null;
  }
  // <<< inline:src/lib/shared/fbCounts.js
// GENERATED by scripts/gen-inline.mjs — do not edit here.
// Edit src/lib/shared/fbCounts.js and run `npm run gen:inline`.
// Engagement counts (reactions / comments / shares / views) read off a Facebook
// post or reel unit. Canonical source — inlined verbatim into the import-free
// capture scripts by scripts/gen-inline.mjs, see ./README.md.
//
// Two layouts exist:
//   • feed / reel rail: a bare number next to each action control, in the order
//     [reactions, comments, shares];
//   • watch theater: a word summary ("2 · 1 comentário · 103 visualizações")
//     rendered after the Share control, with no per-control numbers.
//
// Two things this deliberately does NOT do the obvious way:
//   1. It anchors on the COMMENT control, not the Like one. "Curtir" is the only
//      label that changes with state — once the account has reacted it reads
//      "Amei" / "Remover Curtir", and a like-anchored scan then found no row and
//      returned null, so the reel was filed with no counts at all.
//   2. It collects TEXT NODES, not leaf elements. FB ships variants where the
//      number shares its span with an icon; a leaf-elements-only scan skips that
//      element and silently drops the count.
const COUNT_RE = /^\d[\d.,]*\s?(mil|k|m|mi|rb|jt|tis)?$/i;
const COUNT_LBL = {
  like: /^(like|curtir|gostei|me gusta|j'aime|mi piace|gefällt mir)$/i,
  comment: /leave a comment|comentar|coment[áa]rio|escrever|kommentar|commenter|commenta/i,
  share: /^(share|compartilhar|compartir|partager|teilen|condividi)$/i,
};

function actionControls(root) {
  return [...root.querySelectorAll('[aria-label][role="button"]')];
}
function hasLabel(root, re) {
  return actionControls(root).some((b) => re.test(b.getAttribute("aria-label") || ""));
}
// Every text node under `el`, trimmed. Text nodes have no children by
// definition, so this reaches numbers an element-leaf scan cannot see.
function textNodes(el, out = []) {
  for (const n of el.childNodes) {
    if (n.nodeType === 3) {
      const t = (n.nodeValue || "").trim();
      if (t) out.push(t);
    } else if (n.nodeType === 1) textNodes(n, out);
  }
  return out;
}

// The Share control's label is only the bare word "Compartilhar" on a reel rail.
// In the search / hashtag feed the same control reads "Send this to friends or
// post it on your profile." (pt-BR: "Envie para seus amigos…"), which the exact
// COUNT_LBL.share above deliberately does not match. This wider form is used only
// by readCountsByControl, so the reel scrapers keep their tighter matching.
const SHARE_LBL_WIDE =
  /^(share|compartilhar|compartir|partager|teilen|condividi)\b|send this to|envie para|env[íi]a esto|envoyer|invia questo|sende dies/i;

// A reaction-count tooltip ("Like: 295 people", "Amei: 3,3 mil pessoas") is also a
// [role="button"][aria-label] inside the action row. Every one of them carries a
// colon; no action control does.
const isTooltipCtrl = (b) => (b.getAttribute("aria-label") || "").indexOf(":") >= 0;

function centerOf(node) {
  const el = node.nodeType === 1 ? node : node.parentElement;
  if (!el || !el.getBoundingClientRect) return null;
  const b = el.getBoundingClientRect();
  if (!b.width && !b.height) return null; // never laid out (unmounted, or jsdom)
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
}

/**
 * The action row's counts, each filed under the control it belongs to.
 *
 * WHY THIS EXISTS BESIDE readPostCounts: that one reads the row's bare numbers
 * POSITIONALLY, as [reactions, comments, shares]. Facebook prints NO number beside
 * a control whose count is zero, so a post with no comments renders "4 … 2" and the
 * positional read files its 2 shares as 2 comments — which silently passes a
 * "≥ 2 comments" filter. Verified live on /search/top?q=%23auralytrend
 * (2026-08-15): numbers at x≈1027 and x≈1131 against controls at like x≈1013,
 * comment x≈1065, share x≈1117.
 *
 * So each number is filed by WHERE IT IS, not by how many came before it:
 *   1. inside one of the three controls → that control (survives any layout);
 *   2. otherwise the nearest control by centre distance;
 *   3. and if nothing was ever laid out (an unmounted post, or a test DOM), a
 *      3-number row falls back to the positional reading.
 *
 * Returns the raw localized strings — parse with parseCount from ./counts.js —
 * or null when the post has no action row yet, which on a virtualized feed means
 * "not mounted", not "no engagement".
 */
function readCountsByControl(container) {
  if (!container) return null;
  const anchor = actionControls(container).find((b) =>
    COUNT_LBL.comment.test(b.getAttribute("aria-label") || ""),
  );
  if (!anchor) return null;

  // Climb to the smallest ancestor holding the whole action row, and never past
  // the post itself — on a reacted post the "Like" label is gone, and an unbounded
  // climb would walk into the neighbouring post's row.
  let row = anchor;
  for (let i = 0; i < 7 && row.parentElement && row !== container; i++) {
    row = row.parentElement;
    if (actionControls(row).filter((b) => !isTooltipCtrl(b)).length >= 2) break;
  }

  const controls = actionControls(row).filter((b) => !isTooltipCtrl(b));
  const at = controls.indexOf(anchor);
  const share = controls.find((b) => SHARE_LBL_WIDE.test(b.getAttribute("aria-label") || ""));
  // The like control is whatever action sits before Comment in the bar. Matching
  // it by label would need every reaction word in every locale ("Amei", "Remover
  // Curtir", "Change Like reaction"); its POSITION never changes.
  const like = at > 0 ? controls[0] : null;
  const slots = [
    ["like", like],
    ["comment", anchor],
    ["share", share || null],
  ].filter(([, el]) => el);

  const out = { like: null, comment: null, share: null };
  const numbers = [];
  (function walk(el) {
    for (const n of el.childNodes) {
      if (n.nodeType === 3) {
        const t = (n.nodeValue || "").trim();
        if (t && t.length <= 8 && COUNT_RE.test(t)) numbers.push(n);
      } else if (n.nodeType === 1) walk(n);
    }
  })(row);

  let placed = 0;
  for (const node of numbers) {
    let kind = null;
    for (const [k, el] of slots) if (el.contains(node)) kind = k;
    if (!kind) {
      const c = centerOf(node);
      let best = Infinity;
      if (c)
        for (const [k, el] of slots) {
          const cc = centerOf(el);
          if (!cc) continue;
          // Vertical distance is weighted: a wrapped row stacks the controls, and
          // a number one line down belongs to the control above it, not to the one
          // that happens to share its column.
          const d = Math.hypot(c.x - cc.x, (c.y - cc.y) * 3);
          if (d < best) {
            best = d;
            kind = k;
          }
        }
    }
    if (kind && out[kind] == null) {
      out[kind] = (node.nodeValue || "").trim();
      placed++;
    }
  }

  // Nothing could be placed by containment OR geometry (never laid out): fall back
  // to the positional reading, which is right whenever all three numbers are shown.
  if (!placed && numbers.length === 3) {
    const t = (n) => (n.nodeValue || "").trim();
    return { like: t(numbers[0]), comment: t(numbers[1]), share: t(numbers[2]) };
  }
  return out;
}

function readPostCounts(container) {
  if (!container) return null;
  // (a) bare numbers from the action row
  const bare = [];
  const controls = actionControls(container);
  const anchor =
    controls.find((b) => COUNT_LBL.comment.test(b.getAttribute("aria-label") || "")) ||
    controls.find((b) => COUNT_LBL.like.test(b.getAttribute("aria-label") || ""));
  if (anchor) {
    // Climb to the smallest ancestor holding the whole action row. "Holds the
    // row" = it carries the comment control plus at least one of the other two,
    // so it works whether we anchored on Comment or on Like.
    let row = anchor;
    for (let i = 0; i < 7 && row.parentElement; i++) {
      row = row.parentElement;
      if (
        hasLabel(row, COUNT_LBL.comment) &&
        (hasLabel(row, COUNT_LBL.like) || hasLabel(row, COUNT_LBL.share))
      )
        break;
    }
    for (const t of textNodes(row)) if (t.length <= 8 && COUNT_RE.test(t)) bare.push(t);
  }
  // (b) word summary after the Share control
  const text = (container.innerText || container.textContent || "").replace(/\s+/g, " ");
  const SHARE_W =
    /\b(?:share|compartilhar|compartilhamentos?|compartir|partager|condividi|teilen)\b/i;
  const af = SHARE_W.test(text) ? text.split(SHARE_W).pop() : "";
  const num = "([\\d.,]+\\s?(?:mil|k|m|mi|rb|jt)?)";
  const w = (re) => {
    const m = af.match(new RegExp(re, "i"));
    return m ? m[1].trim() : null;
  };
  const reactW = (af.trim().match(/^(\d[\d.,]*\s?(?:mil|k|m|mi)?)/i) || [])[1];
  const counts = {
    like: bare[0] || (reactW ? reactW.trim() : null),
    comment:
      w(num + "\\s+(?:comments?|coment[áa]rios?|comentarios?|commentaires?|commenti|kommentare?)\\b") ||
      bare[1] ||
      null,
    share:
      w(num + "\\s+(?:shares?|compartilhamentos?|compartidos?|partages?|condivisioni|freigaben)\\b") ||
      bare[2] ||
      null,
    views: w(num + "\\s*(?:views?|visualiz\\w*)\\b"),
  };
  return counts.like || counts.comment || counts.share || counts.views ? counts : null;
}
// >>> inline:end
  // <<< inline:src/lib/shared/fbPermalink.js
// GENERATED by scripts/gen-inline.mjs — do not edit here.
// Edit src/lib/shared/fbPermalink.js and run `npm run gen:inline`.
// Where a captured Facebook video actually lives. Canonical source — inlined
// verbatim into the import-free capture scripts by scripts/gen-inline.mjs.
//
// A video id ALONE does not say which URL opens it, and getting that wrong is not
// a dead link — it opens somebody else's video. Checked live on 2026-08-15:
//
//   /reel/<id>          opened the right video for every id tried, including ids
//                       whose record had been stored in watch form, and it is the
//                       form Facebook's own markup uses for reels
//   /watch/?v=<id>      usually right, but this route falls back to the reels FEED
//                       when Facebook won't serve the item — which is how a card
//                       opened "a totally different one"
//   /video.php?v=<id>   redirects into /watch/?v=<id>, so it inherits that
//
// (An earlier read of this said /watch/ ALWAYS bounces reels to the feed. That was
// measured while Facebook was serving this profile error pages, and the same probe
// gave the opposite answer an hour later. Don't rebuild anything on that signal.)
//
// So: capture records the FORM the post's own link used, and anything left over
// from before that is linked as a reel.
const KIND = { reel: "reel", video: "video" };

/**
 * The video a Facebook link points at: `{ id, kind }`, or null when it points at
 * no video. `kind` is "reel" for /reel/<id> and "video" for /videos/<id> and
 * ?v=<id> — the two shapes that need different permalinks.
 */
function fbVideoRef(href) {
  const s = String(href || "");
  if (!s) return null;
  const reel = s.match(/\/reel\/(\d+)/);
  if (reel) return { id: reel[1], kind: KIND.reel };
  const videos = s.match(/\/videos\/(\d+)/);
  if (videos) return { id: videos[1], kind: KIND.video };
  const v = s.match(/[?&]v=(\d+)/);
  if (v) return { id: v[1], kind: KIND.video };
  return null;
}

/**
 * The URL to open for a captured video. An unknown kind gets the reel form: it is
 * what this extension captures most, and a wrong reel URL fails visibly instead of
 * silently playing a stranger's video.
 */
function fbPermalink(ref) {
  const id = ref && ref.id;
  if (!id) return null;
  return ref.kind === KIND.video
    ? `https://www.facebook.com/watch/?v=${id}`
    : `https://www.facebook.com/reel/${id}`;
}

/**
 * The URL a Library card should open.
 *
 * Non-Facebook records keep whatever they stored (TikTok/Instagram/Pinterest URLs
 * are already canonical). A Facebook record stored before the capture fix carries
 * /watch/?v=<id>, which is the route that can dump the viewer into the reels feed
 * — rebuild those as /reel/<id>, which addressed every id correctly in testing.
 *
 * `videoKind` is what keeps that rebuild off the records it would BREAK. Capture
 * records it ("reel" or "video") from the post's own link, and a real page-video
 * post — /<page>/videos/<id>, or the theater's ?v=<id> — is stored in watch form
 * ON PURPOSE, because that is the URL that opens it. Rewriting one of those to
 * /reel/<id> points the card at something that is not a reel. So only a record
 * with no kind at all (legacy: captured before the fix, when watch form meant a
 * reel) is rebuilt.
 */
function fbCardLink({ platform, videoId, sourceUrl, videoKind } = {}) {
  if (platform && platform !== "facebook") return sourceUrl || null;
  if (!sourceUrl)
    return videoId ? fbPermalink({ id: videoId, kind: videoKind || KIND.reel }) : null;
  if (!videoId || !/\/watch\/\?/.test(sourceUrl)) return sourceUrl;
  if (videoKind === KIND.video) return sourceUrl; // captured as a video post — watch IS its URL
  return fbPermalink({ id: videoId, kind: KIND.reel });
}
// >>> inline:end
  // <<< inline:src/lib/shared/captureIdentity.js
// GENERATED by scripts/gen-inline.mjs — do not edit here.
// Edit src/lib/shared/captureIdentity.js and run `npm run gen:inline`.
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

function sameCapture(a, b) {
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
// >>> inline:end

  // Reel pages hold 2–3 <video> elements (current + preloaded), which trips the
  // generic climb's "stop at >1 video" guard before it reaches the caption/rail.
  // Anchor instead to the active reel card: climb from the "Change Position"
  // slider (a stable, non-localized aria-label) to the block holding its action
  // rail. Returns null when not on a reel surface / the slider isn't present.
  function reelCardUnit() {
    if (!/\/reel\//.test(location.pathname)) return null;
    const slider = document.querySelector(
      'div[role="slider"][aria-label="Change Position"]',
    );
    if (!slider) return null;
    let n = slider;
    for (let i = 0; i < 25 && n && n !== document.body; i++) {
      if (
        n.querySelector('[role="button"][aria-label][aria-haspopup="menu"]') &&
        (n.innerText || "").trim().length > 20
      )
        return n;
      n = n.parentElement;
    }
    return null;
  }
  // Climb to the largest SINGLE-post ancestor: stop at the virtualized feed
  // scroller, or once the ancestor holds more than one video (= multiple posts).
  // This reaches the full post block (header + caption + action bar) without
  // spilling into neighbours.
  function findPostUnit(videoEl) {
    const reel = reelCardUnit();
    if (reel) return reel;
    // Feed surfaces (hashtag/home/profile): the post is a direct child of the
    // [role="feed"] scroller — a clean boundary that never spills into
    // neighbours and isn't fooled by the aria-hidden "Facebook" watermark spans
    // FB scatters inside each post (they poison the text-length climb below).
    const feed = videoEl.closest?.('[role="feed"]');
    if (feed) {
      let n = videoEl;
      while (n && n.parentElement !== feed) n = n.parentElement;
      if (n && (n.innerText || "").trim().length > 30) return n;
    }
    let el = videoEl,
      best = null;
    for (let i = 0; i < 22 && el; i++) {
      const txt = (el.innerText || "").trim();
      // Watermark spam guard — innerText separates the spans with NEWLINES, so
      // match any whitespace between the repeats, not just spaces.
      if (/(?:Facebook\s*){4}/.test(txt)) break;
      if ((el.querySelectorAll?.("video") || []).length > 1) break;
      if (txt.length > 30) best = el;
      el = el.parentElement;
    }
    return best;
  }

  function looksLikeName(s) {
    return (
      !!s &&
      s.length > 1 &&
      s.length < 60 &&
      /[a-zA-ZÀ-ɏ]/.test(s) &&
      !/https?:|www\.|\.com\b/i.test(s) &&
      !/#\w/.test(s) &&
      !/online status|active now|^active$|^follow$|^seguir$/i.test(s)
    );
  }
  function cleanHref(href) {
    if (!href) return null;
    try {
      const u = new URL(href, location.origin);
      const id = u.searchParams.get("id");
      return u.pathname + (id ? `?id=${id}` : "");
    } catch {
      return href.split("?")[0];
    }
  }
  // Reel pages label the author only on the follow control — which reads
  // "Seguir <name>"/"Follow <name>" when not followed and "Seguindo <name>"/
  // "Following <name>" when already followed — because the visible profile links
  // are generic ("Ver perfil do dono" / "View owner's profile"). Read the name
  // off that button (both states); fall back to the general link scan below.
  const FOLLOW_NAME_RE =
    /^(?:follow(?:ing)?|seguir|seguindo|siguiendo|suivre|suivi|segui|segues|folgen|folge ich)\s+(.+)$/i;
  function authorFromFollowBtn(container) {
    for (const b of container.querySelectorAll('[role="button"][aria-label]')) {
      const m = (b.getAttribute("aria-label") || "").trim().match(FOLLOW_NAME_RE);
      if (m && looksLikeName(m[1])) {
        // Attach the owner profile URL if one is present in the card.
        const link = container.querySelector('a[href*="/profile.php?id="], a[href*="/user/"]');
        return { name: m[1].slice(0, 60), url: link ? cleanHref(link.getAttribute("href")) : null };
      }
    }
    return null;
  }
  // Name-driven (not href-whitelisted): the author link varies wildly by surface
  // (/profile.php, vanity /name, page tab /watch/<pageId>/, …). We just take the
  // first link that ISN'T a hashtag / specific video / external / generic-owner,
  // whose aria-label or text reads like a name (aria stays clean even when FB
  // scrambles the text).
  const GENERIC_OWNER_RE =
    /^(ver (o )?perfil( do dono)?|view (owner'?s )?profile|voir le profil|ver el perfil)/i;
  function grabAuthor(container) {
    if (!container) return null;
    const followName = authorFromFollowBtn(container);
    if (followName) return followName;
    for (const a of container.querySelectorAll("a[href]")) {
      // FB anti-scrape noise: aria-hidden "Facebook" watermark links and
      // invisible decoy anchors (zero-size rects) — never the author.
      if (a.closest('[aria-hidden="true"]')) continue;
      const rr = a.getBoundingClientRect();
      if (!rr.width && !rr.height) continue;
      const href = a.getAttribute("href") || "";
      if (/\/hashtag\/|[?&]v=|l\.php|\/sharer|\/photo|\/posts\//i.test(href))
        continue;
      const aria = (a.getAttribute("aria-label") || "").trim();
      if (
        /^(a link to a video|enlarge|play|video|story|leave a comment)/i.test(
          aria,
        )
      )
        continue;
      const alt = a
        .querySelector("img")
        ?.getAttribute("alt")
        ?.replace(/,?\s*(profile picture|foto do perfil|imagem do perfil)/i, "")
        .trim();
      // A generic "View owner's profile" aria carries no name — prefer the link's
      // own text/strong/alt in that case rather than skipping the link entirely
      // (the visible name, e.g. "Laura Shift", lives in the text node).
      const usableAria = GENERIC_OWNER_RE.test(aria) ? "" : aria;
      const raw =
        usableAria ||
        a
          .querySelector('strong, h2, h3, h4, span[dir="auto"]')
          ?.textContent?.trim() ||
        alt ||
        (a.textContent || "").trim();
      // drop trailing "..., view story / view profile / ver perfil" suffixes
      const cand = (raw || "")
        .replace(
          /,\s*(view story|view profile|ver (story|perfil|o perfil)|story)\b.*$/i,
          "",
        )
        .trim();
      if (looksLikeName(cand))
        return { name: cand.slice(0, 60), url: cleanHref(href) };
    }
    for (const img of container.querySelectorAll("img[alt]")) {
      const alt = (img.getAttribute("alt") || "")
        .replace(/,?\s*(profile picture|foto do perfil|imagem do perfil)/i, "")
        .trim();
      if (looksLikeName(alt)) return { name: alt.slice(0, 60), url: null };
    }
    return null;
  }
  // Prefer a hashtag-bearing block (the real caption); reject FB's scramble
  // artifacts (blocks where most lines are single characters).
  function grabCaption(container) {
    if (!container) return null;
    let hashBlock = null,
      longBlock = null;
    container.querySelectorAll('[dir="auto"]').forEach((n) => {
      if (n.querySelector("video")) return;
      // FB anti-scrape noise: watermark spans live under aria-hidden subtrees,
      // and decoy text blocks (scrambled strings, fake domains) render with
      // zero-size rects. Real captions are visible and aria-exposed.
      if (n.closest('[aria-hidden="true"]')) return;
      const rc = n.getBoundingClientRect();
      if (!rc.width || !rc.height) return;
      const t = (n.innerText || "").trim();
      if (t.length < 6) return;
      const lines = t.split("\n");
      if (
        lines.length > 3 &&
        lines.filter((l) => l.trim().length <= 1).length / lines.length > 0.5
      )
        return;
      if (/#\w/.test(t)) {
        if (!hashBlock || t.length > hashBlock.length) hashBlock = t;
      } else if (t.length > 30 && /\s/.test(t)) {
        if (!longBlock || t.length > longBlock.length) longBlock = t;
      }
    });
    const best = hashBlock || longBlock;
    return best
      ? best.replace(/\s*(See more|Ver mais|Ver más)\s*$/i, "").slice(0, 2000)
      : null;
  }
  // The reel/video-permalink id straight off the page URL — reel pages
  // (/reel/<id>) and video pages (/watch/?v=, /<user>/videos/<id>) don't hang a
  // permalink near the player, so the ancestor-link scan below misses them.
  function urlPathVideoId() {
    try {
      const u = new URL(location.href);
      const m = u.pathname.match(/\/reel\/(\d+)|\/videos\/(\d+)/);
      if (m) return m[1] || m[2];
      return u.searchParams.get("v");
    } catch {
      return null;
    }
  }
  function grabVideoId(container, videoEl) {
    // On a reel/video permalink surface, the URL id IS this video — trust it first.
    const fromUrl = urlPathVideoId();
    if (fromUrl && /\/(reel|watch|videos)\b/.test(location.pathname + location.search))
      return fromUrl;
    const ref = grabVideoRef(container, videoEl);
    if (ref) return ref.id;
    // Fallback: the page URL id (theater MAIN video, or any surface missed above).
    return fromUrl;
  }
  // The post's own permalink link, as { id, kind }. The KIND matters: a reel id put
  // into a /watch/?v= URL sends Facebook to the bare reels feed, which then plays an
  // arbitrary reel — a Library card that opened a stranger's video. See
  // src/lib/shared/fbPermalink.js for the verified redirect behaviour.
  function grabVideoRef(container, videoEl) {
    let el = container || videoEl;
    for (let k = 0; k < 5 && el; k++) {
      const links =
        el.querySelectorAll?.(
          'a[href*="v="], a[href*="/videos/"], a[href*="/reel/"]',
        ) || [];
      for (const a of links) {
        const ref = fbVideoRef(a.getAttribute("href") || "");
        if (ref) return ref;
      }
      el = el.parentElement;
    }
    return null;
  }
  // Every plausible numeric media id from the post (clean permalink ids + any
  // 15-19 digit run in the markup). FB buries the real video_id in the post even
  // when no link exposes it (/stories/ posts), so we hand the background ALL
  // candidates and it intersects them with the fbcdn tracks it actually captured.
  // Computed at job time only (outerHTML scan), never on the scroll-publish path.
  function grabVideoIdCandidates(container, videoEl) {
    const ids = new Set();
    const best = grabVideoId(container, videoEl);
    if (best) ids.add(best);
    const root = container || videoEl;
    if (root) {
      for (const a of root.querySelectorAll("a[href]")) {
        const m = (a.getAttribute("href") || "").match(
          /[?&]v=(\d+)|\/videos\/(\d+)|\/reel\/(\d+)/,
        );
        if (m) ids.add(m[1] || m[2] || m[3]);
      }
      const big = (root.outerHTML || "").match(/\d{15,19}/g);
      if (big) for (const n of big.slice(0, 40)) ids.add(n);
    }
    return Array.from(ids);
  }
  // Media URLs for a video, read from FB's own embedded page JSON (the
  // `videoDeliveryLegacyFields` in <script type="application/json"> blocks) so
  // Download/Transcribe work even for a video whose fbcdn tracks we never saw on
  // the wire (e.g. served from cache). Returns, for the video whose nearest
  // ancestor id is in `ids`:
  //   { progressive, audio }
  //   • progressive — a single MP4 with audio+video (best for Download; HD-pref)
  //   • audio       — the audio-only representation base_url (best for
  //                   Transcribe: small, fast to decode — NOT the whole video)
  // Runs only on demand, and only JSON.parses the few scripts that mention both
  // an id and a media url.
  function fbEmbeddedMediaFor(ids) {
    if (!ids || !ids.size) return {};
    let prog = null;
    let audio = null;
    for (const s of document.querySelectorAll('script[type="application/json"]')) {
      const t = s.textContent || "";
      if (t.indexOf("progressive_url") < 0 && t.indexOf("base_url") < 0) continue;
      let mentions = false;
      for (const id of ids) {
        if (id && t.indexOf(id) >= 0) { mentions = true; break; }
      }
      if (!mentions) continue;
      let data;
      try { data = JSON.parse(t); } catch { continue; }
      (function walk(o, ancId) {
        if (!o || typeof o !== "object") return;
        if (Array.isArray(o)) { for (const v of o) walk(v, ancId); return; }
        const myId =
          typeof o.id === "string" && /^\d{6,}$/.test(o.id)
            ? o.id
            : o.video_id != null
              ? String(o.video_id)
              : ancId;
        if (ids.has(myId)) {
          if (typeof o.progressive_url === "string") {
            const hd = /hd/i.test(o.metadata?.quality || "");
            if (!prog || (hd && !prog.hd)) prog = { url: o.progressive_url, hd };
          }
          if (
            typeof o.base_url === "string" &&
            /audio/i.test(o.mime_type || o.mimeType || "")
          ) {
            if (!audio) audio = o.base_url;
          }
        }
        for (const k in o) walk(o[k], myId);
      })(data, null);
      if (prog && prog.hd && audio) break;
    }
    return { progressive: prog ? prog.url : null, audio };
  }
  // A clean, shareable permalink for the current reel/video so a saved transcript
  // can link straight back to it (re-transcribe / re-download later).
  function currentSourceUrl(container, videoEl) {
    const rm = location.pathname.match(/\/reel\/(\d+)/);
    if (rm) return `https://www.facebook.com/reel/${rm[1]}`;
    const vm = location.pathname.match(/\/videos\/(\d+)/);
    if (vm) return `https://www.facebook.com/watch/?v=${vm[1]}`;
    try {
      const v = new URL(location.href).searchParams.get("v");
      if (v) return `https://www.facebook.com/watch/?v=${v}`;
    } catch {}
    // A feed post (warmer auto-capture). The id alone is NOT enough to build a
    // permalink: /watch/?v=<reel id> bounces to the bare reels feed and plays an
    // arbitrary reel. Use the form the post's own link was written in, and only
    // fall back to a guess when the post exposes no link at all.
    const ref = grabVideoRef(container, videoEl);
    if (ref) return fbPermalink(ref);
    const id = grabVideoId(container, videoEl);
    if (id) return fbPermalink({ id });
    return location.href.split("?")[0];
  }
  // Which SHAPE this post's link had: "reel" or "video". Stored beside the URL so
  // a Library card can tell a watch URL that is correct (a real /videos/ post)
  // from a legacy record that stored watch form for a reel — see fbCardLink.
  function currentVideoKind(container, videoEl) {
    if (/\/reel\/\d+/.test(location.pathname)) return "reel";
    if (/\/videos\/\d+/.test(location.pathname)) return "video";
    try {
      if (new URL(location.href).searchParams.get("v")) return "video";
    } catch {}
    const ref = grabVideoRef(container, videoEl);
    return ref ? ref.kind : null; // no link at all → unknown, and unknown stays null
  }
  function grabMeta(videoEl) {
    const container = findPostUnit(videoEl);
    return {
      videoId: grabVideoId(container, videoEl),
      platform: PLATFORM,
      thumb: grabThumb(videoEl),
      counts: readPostCounts(container),
      author: grabAuthor(container),
      caption: grabCaption(container),
      sourceUrl: currentSourceUrl(container, videoEl),
      videoKind: currentVideoKind(container, videoEl),
      // The one piece of post metadata Facebook gives up for free. It is read off
      // the DOM video, NOT from `durationHint`: that hint is deliberately withheld
      // for permalink ids (it must never cross to a same-length neighbour), so a
      // reel opened on its own page would have carried no duration at all.
      // Everything else the Library line would like — post date, view count,
      // follower count — is genuinely absent here: verified live on a reel that
      // the embedded JSON we already walk has no creation_time and an `owner` of
      // just `{__typename, id}`, and that the DOM carries no date element either.
      durationS:
        videoEl && Number.isFinite(videoEl.duration) && videoEl.duration > 1
          ? Math.round(videoEl.duration * 10) / 10
          : null,
    };
  }
  // A scrape you can trust. A reel page updates location.href ~150-175 ms BEFORE
  // it swaps the mounted card (measured live over three reel changes), and the id
  // comes from the URL while the author/caption/counts come from the card — so a
  // single scrape taken in that window files one reel's engagement under the next
  // reel's id. Wait for two consecutive reads to agree, re-resolving the active
  // video each round so we follow FB's node swaps. A page that never settles is
  // still captured, just without the guarantee.
  const SETTLE_MS = 220;
  async function settleCapture(getVideo) {
    let video = getVideo();
    let prev = video ? grabMeta(video) : null;
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      video = getVideo() || video;
      const next = video ? grabMeta(video) : null;
      if (sameCapture(prev, next)) return video;
      prev = next;
    }
    return video;
  }
  // Counts hydrate late, and some FB variants render the action rail after the
  // caption. The record used to be written from ONE scrape and never refreshed,
  // so a miss at request time was permanent: the reel landed in the Library with
  // `counts: null` next to a perfectly good author, caption and thumbnail, and
  // leaving the reel made it unrecoverable. Retry while the page still shows THIS
  // video and patch the stored record (the patch only fills gaps — see
  // src/lib/shared/metaMerge.js).
  const BACKFILL_MS = [400, 1000, 2200];
  // <<< inline:src/lib/shared/txLang.js
// GENERATED by scripts/gen-inline.mjs — do not edit here.
// Edit src/lib/shared/txLang.js and run `npm run gen:inline`.
// The BR/EN transcription-language control that lives ON the page: the persisted
// choice, the little badge on a Transcribe button, and the two-item menu that opens
// when you press one. INLINED into content scripts — see src/lib/shared/README.md
// before editing (no imports allowed in this file).
//
// Facebook grew this first and Instagram/TikTok only got the storage half of it:
// they read `fbw_transcript_language` but had no way to SET it, so on Instagram the
// language was whatever the Facebook rail had last been left on. The three scripts
// also carried three hand-copied `normTxLang`/`getTxLang` pairs — the same drift
// this directory exists to stop.
//
// Deliberately NOT here: which button gets a badge, and when the badge is
// repainted. Each overlay has its own button class and its own render loop, so a
// platform opts a button in with enableTxBadge() and calls updateTxBadges() from
// whatever loop it already runs.

const TX_LANG_KEY = "fbw_transcript_language";
const TX_LANG_DEFAULT = "br";
const TX_LANG_OPTIONS = [
  { value: "br", label: "Português", short: "BR" },
  { value: "en", label: "English", short: "EN" },
];

function normTxLang(value) {
  const lang = String(value || "").trim().toLowerCase();
  if (lang === "en") return "en";
  if (lang === "br" || lang === "pt") return "br";
  return TX_LANG_DEFAULT;
}

function txLangInfo(value) {
  const lang = normTxLang(value);
  return TX_LANG_OPTIONS.find((o) => o.value === lang) || TX_LANG_OPTIONS[0];
}

// Where the menu goes for a button at `rect`, inside a `view` of {width,height}.
//
// Preferred side is LEFT of the button — the Facebook rail sits on the video's left
// edge and a menu opening rightwards would cover the video. A button too close to
// the left edge for that (Instagram's tile actions sit at left:7px) flips to the
// right instead of being clamped into a strip overlapping itself.
const TX_LANG_MENU_W = 124;
function txLangMenuPos(rect, view) {
  const preferred = rect.left - 102;
  const left = preferred < 8 ? rect.right + 6 : preferred;
  return {
    top: Math.max(8, Math.min(view.height - 92, rect.top)),
    left: Math.max(8, Math.min(view.width - 132, left)),
  };
}

const TX_LANG_CSS = `
.fbw-lang-host{position:relative}
.fbw-lang-badge{position:absolute;right:-5px;bottom:-5px;min-width:18px;height:14px;padding:0 3px;border-radius:5px;
  display:grid;place-items:center;background:rgba(15,23,42,.96);color:#dbeafe;border:1px solid rgba(150,185,255,.55);
  font:800 8px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0;pointer-events:none}
.fbw-lang-menu{position:fixed;z-index:2147483600;display:grid;gap:4px;width:${TX_LANG_MENU_W}px;padding:6px;border-radius:9px;
  background:rgba(17,24,44,.98);border:1px solid rgba(150,185,255,.42);box-shadow:0 8px 24px rgba(0,0,0,.45);
  font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#fff}
.fbw-lang-menu button{height:30px;border:0;border-radius:6px;background:transparent;color:#e5e7eb;text-align:left;
  padding:0 8px;cursor:pointer;font:inherit}
.fbw-lang-menu button:hover,.fbw-lang-menu button.active{background:rgba(59,130,246,.24);color:#fff}`;

// On <html>, not <body>: the menu itself is appended there (outside the page's
// React root, which reconciles <body> children away), so its rules must survive
// the same way.
function ensureTxLangStyle() {
  if (document.getElementById("fbw-lang-style")) return;
  const s = document.createElement("style");
  s.id = "fbw-lang-style";
  s.textContent = TX_LANG_CSS;
  (document.head || document.documentElement).appendChild(s);
}

let txLangCache = TX_LANG_DEFAULT;
// The buttons that asked for a badge. A Set (not a selector) because each overlay
// names its buttons differently, and pruning on the way past keeps rails that FB
// remounts constantly from leaking entries.
const txBadged = new Set();

async function getTxLang() {
  try {
    const r = await chrome.storage.local.get(TX_LANG_KEY);
    txLangCache = normTxLang(r?.[TX_LANG_KEY]);
  } catch {
    /* storage gone (extension reloaded under us) — keep the cached value */
  }
  return txLangCache;
}

async function setTxLang(value) {
  txLangCache = normTxLang(value);
  try {
    await chrome.storage.local.set({ [TX_LANG_KEY]: txLangCache });
  } catch {
    /* the caller still gets the normalized value for THIS job */
  }
  updateTxBadges();
  return txLangCache;
}

/** Opt a Transcribe button in: it gets the badge now and on every refresh. */
function enableTxBadge(btn) {
  if (!btn) return;
  ensureTxLangStyle();
  btn.classList.add("fbw-lang-host");
  txBadged.add(btn);
  paintTxBadge(btn);
}

/** Repaint one button's badge — a no-op for buttons that never opted in, so a
 *  platform's shared "button changed state" hook can call it blindly. */
function addTxBadge(btn) {
  if (btn && txBadged.has(btn)) paintTxBadge(btn);
}

function paintTxBadge(btn) {
  let badge = btn.querySelector(".fbw-lang-badge");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "fbw-lang-badge";
    btn.appendChild(badge);
  }
  badge.textContent = txLangInfo(btn.dataset.lang || txLangCache).short;
}

/** Repaint every opted-in badge, dropping buttons whose rail has been torn down.
 *  Busy buttons are skipped: their glyph is a spinner the badge would sit on. */
function updateTxBadges() {
  for (const btn of txBadged) {
    if (!btn.isConnected) {
      txBadged.delete(btn);
      continue;
    }
    if (!btn.classList.contains("busy")) paintTxBadge(btn);
  }
}

/** Load the stored choice and keep every badge in step with it — including when
 *  the OTHER platform's rail changes it in another tab. */
function watchTxLang() {
  getTxLang().then(updateTxBadges).catch(() => {});
  chrome.storage?.onChanged?.addListener?.((changes, area) => {
    if (area !== "local" || !changes[TX_LANG_KEY]) return;
    txLangCache = normTxLang(changes[TX_LANG_KEY].newValue);
    updateTxBadges();
  });
}

let txLangMenu = null;
let txLangOutside = null;

function closeTxLangMenu() {
  if (txLangOutside) {
    document.removeEventListener("pointerdown", txLangOutside, true);
    window.removeEventListener("blur", closeTxLangMenu);
    window.removeEventListener("scroll", closeTxLangMenu, true);
    txLangOutside = null;
  }
  if (txLangMenu) {
    txLangMenu.remove();
    txLangMenu = null;
  }
}

/**
 * Open the BR/EN menu for `btn`; `onPick(lang)` runs after the choice is saved.
 * A busy button is ignored — its job is already in flight.
 */
function openTxLangMenu(btn, onPick) {
  if (!btn || btn.classList.contains("busy")) return;
  ensureTxLangStyle();
  closeTxLangMenu();
  const pos = txLangMenuPos(btn.getBoundingClientRect(), {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const menu = document.createElement("div");
  menu.className = "fbw-lang-menu";
  menu.setAttribute("role", "menu");
  menu.style.top = `${pos.top}px`;
  menu.style.left = `${pos.left}px`;
  for (const opt of TX_LANG_OPTIONS) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = opt.value === txLangCache ? "active" : "";
    item.textContent = opt.label;
    // The host page (FB's reel player, IG's story viewer) toggles playback on the
    // pointer sequence, so the whole sequence is swallowed — not just the click.
    item.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
    item.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const lang = await setTxLang(opt.value);
      btn.dataset.lang = lang;
      closeTxLangMenu();
      onPick(lang);
    });
    menu.appendChild(item);
  }
  txLangMenu = menu;
  document.documentElement.appendChild(menu);
  // Next tick: the click that OPENED the menu is still travelling, and a listener
  // armed synchronously would see it as an outside click and close immediately.
  setTimeout(() => {
    txLangOutside = (e) => {
      if (menu.contains(e.target) || btn.contains(e.target)) return;
      closeTxLangMenu();
    };
    document.addEventListener("pointerdown", txLangOutside, true);
    window.addEventListener("blur", closeTxLangMenu, { once: true });
    window.addEventListener("scroll", closeTxLangMenu, { once: true, capture: true });
  }, 0);
}
// >>> inline:end
  // <<< inline:src/lib/shared/railTarget.js
// GENERATED by scripts/gen-inline.mjs — do not edit here.
// Edit src/lib/shared/railTarget.js and run `npm run gen:inline`.
// Which video a floating overlay rail is actually pointing at. INLINED into content
// scripts — see src/lib/shared/README.md before editing (no imports allowed here).
//
// Feed rails are `position: fixed` and repositioned from a scroll handler. When that
// handler cannot run — a hidden tab never fires requestAnimationFrame — the rail
// keeps its SCREEN position while the feed scrolls underneath it, so a button drawn
// for post A ends up sitting next to post B. Clicking it used to transcribe A under
// B's metadata: the wrong transcript, with nothing on screen suggesting anything was
// off. Geometry is the tie-breaker, because geometry is what the user actually sees.
//
// `slack` allows for the 10px inset the rail is drawn at, plus a rail taller than
// its media's top edge.

/** Is `rail`'s anchor (its top-left) inside `media`, allowing `slack` above/left? */
function railHitsMedia(rail, media, slack = 40) {
  if (!rail || !media) return false;
  return (
    rail.top >= media.top - slack &&
    rail.top <= media.bottom &&
    rail.left >= media.left - slack &&
    rail.left <= media.right
  );
}

/**
 * The index into `mediaRects` the rail is over, or -1.
 * First hit wins — rails sit at the top-left of their media, and feed media do not
 * overlap, so a second hit would be a media element stacked on another.
 */
function mediaUnderRail(rail, mediaRects, slack = 40) {
  if (!rail || !Array.isArray(mediaRects)) return -1;
  return mediaRects.findIndex((m) => railHitsMedia(rail, m, slack));
}

/**
 * Can this rail's BOUND media still be trusted?
 *
 * A rail anchored in the page next to its video (`floating: false`) always can —
 * it moves with the post by construction, and it is not drawn inside the media box,
 * so a containment test would wrongly reject it. A floating rail can only be trusted
 * while it is still drawn over the media it was bound to.
 */
function boundMediaIsStale({ floating, connected, railRect, boundRect }, slack = 40) {
  if (!connected) return true;
  if (!floating) return false;
  return !railHitsMedia(railRect, boundRect, slack);
}
// >>> inline:end
  watchTxLang();
  async function backfillCounts(msg, getVideo) {
    if (!msg || !msg.videoId || msg.counts) return;
    for (const wait of BACKFILL_MS) {
      await new Promise((r) => setTimeout(r, wait));
      const video = getVideo();
      if (!video || !video.isConnected) return;
      const meta = grabMeta(video);
      if (meta.videoId !== msg.videoId) return; // moved on — this is another post now
      if (!meta.counts) continue;
      chrome.runtime
        .sendMessage({ type: "FBW_META_PATCH", videoId: msg.videoId, counts: meta.counts })
        .catch(() => {});
      return;
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Background job results → flip the matching on-page button to ✓/✗.
    if (msg?.type === "FBW_TRANSCRIBE_RESULT") resolvePending?.("transcribe", !!msg.success);
    if (msg?.type === "FBW_DOWNLOAD_RESULT") resolvePending?.("download", !!msg.success);
    // Liveness probe (background sets the panel's reload hint from the reply).
    if (msg?.type === "FBW_PING") sendResponse?.({ ok: true });
  });

  // ============================================================
  // Playhead reporter — the panel highlights a stored transcript in time with the
  // video playing HERE. The page owns the clock: it publishes {videoId, t} and the
  // panel decides which line that is (lib/playhead.js).
  //
  // Measured on a live reel: `timeupdate` fires ~3.8×/s (median gap 265 ms), which
  // is ~5 updates per 1.31 s chunk — no rAF loop, no polling.
  //
  // videoId travels with EVERY tick on purpose. A reel page updates location.href
  // 150-175 ms before it swaps the mounted card, so a time and an id sampled
  // apart can belong to different reels; sending them together lets the panel
  // refuse a mismatched pair instead of scrubbing the wrong transcript.
  // ============================================================
  const PLAYHEAD_PORT = "fbw-playhead";
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PLAYHEAD_PORT || fbwDisabled) return;
    let video = null;
    let dead = false;
    const post = () => {
      if (dead || !video || !video.isConnected) return;
      const t = video.currentTime;
      if (!Number.isFinite(t)) return;
      try {
        port.postMessage({
          videoId: urlPathVideoId() || grabVideoId(findPostUnit(video), video),
          t,
          paused: video.paused,
          duration: Number.isFinite(video.duration) ? video.duration : null,
        });
      } catch {
        dead = true; // port closed under us (panel shut)
      }
    };
    const EVENTS = ["timeupdate", "play", "pause", "seeked", "ended"];
    const detach = () => {
      if (!video) return;
      for (const e of EVENTS) video.removeEventListener(e, post);
      video = null;
    };
    // FB swaps <video> nodes on every reel change, so the reporter re-binds
    // instead of holding one node. Cheap: a pick + identity check, twice a second.
    const rebind = () => {
      if (dead) return;
      const next = pickActiveVideo();
      if (next === video && (!video || video.isConnected)) return;
      detach();
      video = next;
      if (!video) return;
      for (const e of EVENTS) video.addEventListener(e, post);
      post(); // paint immediately, don't wait for the next tick
    };
    const iv = setInterval(rebind, 500);
    rebind();
    port.onMessage.addListener((msg) => {
      // Click-to-seek from the panel. Verified live: FB does not fight a JS seek
      // (11.71 → 23.71 landed at 24.00 and kept playing). Refuse when the page has
      // moved on to another video — seeking the wrong reel is worse than no seek.
      if (msg?.type !== "seek" || !video || !video.isConnected) return;
      const here = urlPathVideoId() || grabVideoId(findPostUnit(video), video);
      if (msg.videoId && here && msg.videoId !== here) return;
      try {
        video.currentTime = Math.max(0, Number(msg.t) || 0);
        if (video.paused) video.play().catch(() => {});
      } catch {}
    });
    port.onDisconnect.addListener(() => {
      dead = true;
      clearInterval(iv);
      detach();
    });
  });

  // ---- auto-capture (driven by the warmer engine in the same tab) ----
  // content.js (the warmer) dispatches a "__fbw_auto_capture" window event when an
  // in-view video post clears the user's thresholds. We grab that video's metadata
  // and kick off transcribe/download jobs and/or stash it in the Saved (favorites)
  // tab. The warmer already played the video, so its fbcdn tracks are captured.
  // Auto-capture "favoritar". An UPSERT, never a toggle — favouriting a post that
  // is already saved must refresh it, not remove it. The background performs the
  // merge (keeping any existing transcript text/chunks) inside its serialized
  // queue, so this can no longer lose an update to a concurrent save.
  async function saveFavorite(meta) {
    try {
      await chrome.runtime.sendMessage({
        type: "FBW_SAVED_UPSERT",
        entry: { ...meta, videoId: meta.videoId, autoSaved: true, updatedAt: Date.now() },
      });
    } catch {}
  }
  async function autoCapture(opts) {
    let v = pickActiveVideo();
    if (!v) return;
    try {
      v.play();
    } catch {}
    // The warmer fires this while it is still scrolling, which is precisely the
    // reel-swap window — settle before reading anything off the page.
    v = (await settleCapture(() => pickActiveVideo() || v)) || v;
    const meta = grabMeta(v);
    const candidates = grabVideoIdCandidates(findPostUnit(v), v);
    // /stories/ feed posts expose no clean permalink → meta.videoId is null. Fall
    // back to the first candidate so auto-capture still fires (the background
    // resolves the real track from the candidate list).
    const id = meta.videoId || candidates[0] || null;
    if (!id) return;
    meta.videoId = id;
    if (opts.favorite) saveFavorite(meta);
    // Route through videoJobMessage so auto-capture also uses the embedded
    // progressive_url when present (works on cached videos, no mux needed).
    if (opts.transcribe) {
      const msg = await videoJobMessage("transcribe", v, undefined, undefined, await getTxLang());
      chrome.runtime.sendMessage(msg).catch(() => {});
      backfillCounts(msg, () => pickActiveVideo());
    }
    if (opts.download) {
      const msg = await videoJobMessage("download", v);
      chrome.runtime.sendMessage(msg).catch(() => {});
    }
  }
  window.addEventListener("__fbw_auto_capture", (e) =>
    autoCapture(e.detail || {}),
  );

  // ============================================================
  // In-page action buttons — a small Download/Transcribe rail on each feed
  // video, reel, and video-post, plus Download on standalone photo posts.
  // Vanilla DOM, no per-node listeners: one <style>, one debounced
  // MutationObserver (disconnected while we append so we never re-trigger
  // ourselves), dataset-flag dedup, and a size gate. Handlers act on the
  // SPECIFIC media the button belongs to — not the centered pick. Result
  // messages from the background flip the button to ✓/✗ (FIFO by kind).
  // ============================================================
  const BTN = { size: 30, iconSize: 16, minMedia: 220, minImg: 250 };
  let btnStyleAdded = false;
  const BTN_SVG = {
    dl: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
    tx: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    cm: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    ok: '<polyline points="20 6 9 17 4 12"/>',
    err: '<line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/>',
  };
  const btnIcon = (name, size = BTN.iconSize) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="${size}" height="${size}">${BTN_SVG[name]}</svg>`;
  function ensureBtnStyle() {
    if (btnStyleAdded) return;
    btnStyleAdded = true;
    const s = document.createElement("style");
    s.id = "fbw-btn-style";
    s.textContent = `
      .fbw-acts{position:absolute;top:10px;left:10px;display:flex;flex-direction:column;gap:6px;z-index:8;pointer-events:none}
      .fbw-acts.reel{top:26%;left:auto;right:12px}
      .fbw-actbtn{position:relative;pointer-events:auto;display:grid;place-items:center;width:${BTN.size}px;height:${BTN.size}px;
        border-radius:9px;cursor:pointer;color:#fff;background:rgba(30,64,140,.92);
        border:1px solid rgba(150,185,255,.5);box-shadow:0 2px 10px rgba(20,60,160,.35);
        transition:background .15s,color .15s,transform .1s}
      .fbw-actbtn:hover{background:rgba(32,112,244,.92);transform:translateY(-1px)}
      .fbw-actbtn[data-tip]:hover::after{content:attr(data-tip);position:absolute;right:calc(100% + 8px);top:50%;
        transform:translateY(-50%);background:rgba(17,24,44,.96);color:#fff;font:600 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        padding:5px 8px;border-radius:6px;white-space:nowrap;pointer-events:none;z-index:12;
        box-shadow:0 2px 8px rgba(0,0,0,.45);border:1px solid rgba(150,185,255,.28)}
      .fbw-actbtn:active{transform:translateY(0)}
      .fbw-actbtn.busy{color:#93c5fd;cursor:default}
      .fbw-actbtn.busy svg{animation:fbw-spin 1s linear infinite}
      #fbw-overlay{position:fixed;left:0;top:0;width:0;height:0;z-index:2147482000;pointer-events:none}
      .fbw-actbtn.ok{color:#34d399;border-color:rgba(52,211,153,.6)}
      .fbw-actbtn.err{color:#f87171;border-color:rgba(248,113,113,.6)}
      /* .fbw-lang-badge / .fbw-lang-menu live in src/lib/shared/txLang.js, which
         injects its own <style> — the same rules now serve IG and TikTok too. */
      @keyframes fbw-spin{to{transform:rotate(360deg)}}
      .fbw-thumbbtn{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:flex;align-items:center;gap:8px;
        padding:10px 15px;border-radius:11px;cursor:pointer;color:#fff;font-size:13px;font-weight:600;
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;border:1px solid rgba(160,190,255,.3);
        background:linear-gradient(135deg,#1877f2,#3c7cfc);box-shadow:0 4px 16px rgba(24,119,242,.4);transition:transform .12s,box-shadow .12s}
      .fbw-thumbbtn:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(24,119,242,.5)}
      .fbw-thumbbtn:active{transform:translateY(0)}`;
    (document.head || document.documentElement).appendChild(s);
  }

  const sanitFb = (s) =>
    String(s || "").replace(/[\\/:*?"<>|]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

  // Nudge THIS video to (re)fetch its fbcdn tracks so the background can resolve
  // them, WITHOUT disrupting playback: only play it if it's paused, and never
  // pause the neighbours (pausing the on-screen reel was the visible glitch).
  // The video a button acts on. On reel surfaces FB swaps <video> nodes and
  // preloads neighbours, so the node captured at decoration time can be the wrong
  // one — resolve the active reel at click time instead. Feed/video-post posts
  // each own a stable node, so the bound node is correct there.
  function targetVideoFor(boundVideo) {
    if (/\/reel\//.test(location.pathname)) return pickActiveVideo() || boundVideo;
    return boundVideo;
  }
  // Biggest fbcdn/scontent photo inside a post unit (skips avatars via size gate).
  function largestImageIn(unit) {
    let best = null, bestArea = 0;
    for (const img of unit.querySelectorAll("img")) {
      const src = img.currentSrc || img.src || "";
      if (!/fbcdn|scontent/.test(src)) continue;
      const r = img.getBoundingClientRect();
      const area = r.width * r.height;
      if (r.width < 150 || r.height < 150) continue;
      if (area > bestArea) { bestArea = area; best = img; }
    }
    return best;
  }

  // ---- pending-job feedback (FIFO by kind; result msgs flip the icon) ----
  const pending = { transcribe: [], download: [] };
  function setBtnState(btn, state) {
    btn.classList.remove("busy", "ok", "err");
    if (state === "busy") { btn.classList.add("busy"); btn.innerHTML = btnIcon(btn.dataset.kind || "dl"); }
    else if (state === "ok") { btn.classList.add("ok"); btn.innerHTML = btnIcon("ok"); }
    else if (state === "err") { btn.classList.add("err"); btn.innerHTML = btnIcon("err"); }
    else btn.innerHTML = btnIcon(btn.dataset.kind || "dl");
    addTxBadge(btn);
  }
  function markBusy(kind, btn) {
    setBtnState(btn, "busy");
    pending[kind].push(btn);
    // Safety revert so a lost result never leaves a permanent spinner.
    btn._revert = setTimeout(() => {
      const i = pending[kind].indexOf(btn);
      if (i >= 0) pending[kind].splice(i, 1);
      if (btn.isConnected) setBtnState(btn, "idle");
    }, 180000);
  }
  function resolvePending(kind, ok) {
    const btn = pending[kind].shift();
    if (!btn) return;
    clearTimeout(btn._revert);
    if (!btn.isConnected) return;
    setBtnState(btn, ok ? "ok" : "err");
    const idleTitle = btn.dataset.kind === "tx" ? "Transcrever vídeo" : "Baixar vídeo";
    btn.title = ok ? idleTitle : "Não foi possível capturar a mídia — deixe o vídeo tocar uma vez e tente de novo";
    setTimeout(() => {
      if (btn.isConnected) { setBtnState(btn, "idle"); btn.title = idleTitle; }
    }, 2500);
  }

  // Prime a video so its fbcdn tracks are actually fetched (and thus captured by
  // the background) before we ask for a job. FB only streams the centred video
  // and unloads the rest, so a feed button on an off-centre/paused post would
  // otherwise resolve nothing. Centre it (feed only), play it, and wait until it
  // is genuinely advancing — up to ~3.5s.
  function mostlyInView(el) {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight * 1.05 && r.height > 0;
  }
  async function primeVideo(video) {
    if (!video) return;
    if (!/\/reel\//.test(location.pathname) && !mostlyInView(video))
      video.scrollIntoView({ block: "center" });
    const t0 = video.currentTime;
    if (video.paused) { try { await video.play(); } catch {} }
    // Prime-window attribution needs WIRE events — a replay served from the
    // already-buffered MSE ranges emits none. If there's an unbuffered stretch,
    // hop into it briefly to force fresh segment fetches, then hop back.
    try {
      const b = video.buffered;
      const dur = video.duration;
      if (Number.isFinite(dur) && dur > 12 && b.length) {
        const lastEnd = b.end(b.length - 1);
        const gapAt = lastEnd + 2;
        if (gapAt < dur - 2) {
          const back = video.currentTime;
          video.currentTime = gapAt;
          await new Promise((r) => setTimeout(r, 900));
          video.currentTime = back;
        }
      }
    } catch {}
    for (let i = 0; i < 14; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (!video.paused && video.currentTime > t0 + 0.15) break;
    }
  }
  // Build the job message for a video: prefer the page's embedded progressive_url
  // (works even for cached videos), fall back to the captured-track pipeline
  // (videoId + candidates) when no embedded URL is present.
  //
  // Id resolution, most→least trusted:
  //   1. permalink/URL id (reel, watch, video-post) — never second-guessed;
  //   2. duration match against the background's captured tracks — feed posts
  //      (hashtag/home) bury the real video_id in page JSON only, so the markup
  //      can't name it, but the DOM video's duration pairs it to an efg
  //      duration_s deterministically (recency alone crosses to prefetches);
  //   3. first markup candidate — a guess; flagged !idConfident so the eager
  //      Library card isn't written under an id the background may not use.
  async function videoJobMessage(kind, video, primedAt, onFeedOverride, language) {
    const unit = findPostUnit(video) || video;
    const meta = grabMeta(video);
    const candidates = grabVideoIdCandidates(unit, video);
    const durationHint =
      Number.isFinite(video.duration) && video.duration > 1
        ? Math.round(video.duration * 10) / 10
        : null;
    let id = meta.videoId || null;
    const fromPermalink = !!id;
    let idConfident = fromPermalink;
    // Feed resolution #1: FB's embedded JSON, matched by this post's caption
    // (unique) or accurate playable duration. Present only for the initial
    // batch, but when present it's a trusted id with no wire dependence.
    if (!id) {
      const emb = fbEmbeddedResolve(meta.caption, video.duration);
      if (emb) {
        id = emb.id;
        idConfident = true;
        meta.videoId = id;
        meta.sourceUrl = `https://www.facebook.com/watch/?v=${id}`;
      }
    }
    // Feed resolution #2, only AFTER priming: the background attributes the
    // tracks fetched during the prime window to THIS video. The always-
    // available fallback for paginated posts (not in the embedded JSON). efg
    // duration only breaks ties among the freshly-fetched set — never overrides
    // it (efg duration_s lies).
    if (!id && primedAt) {
      const r = await chrome.runtime
        .sendMessage({ type: "FBW_MATCH_TRACKS", durationHint, primedAt })
        .catch(() => null);
      if (r && r.videoId) {
        id = r.videoId;
        idConfident = true;
        meta.videoId = id;
        meta.sourceUrl = `https://www.facebook.com/watch/?v=${id}`;
      }
    }
    // NO junk fallback into the id: a markup candidate once collided with a
    // real neighbouring video's id and the background trusted it exactly —
    // wrong audio under this post's metadata. Unresolved stays null; the
    // background's duration path (or an error) decides.
    // Hint the background only when the id is NOT from a permalink — a real
    // permalink id must never cross to a same-length neighbour. A hinted call
    // is duration-ONLY in the background. Candidates NEVER ride along on feed
    // surfaces: feed post markup routinely embeds NEIGHBOURING videos' ids
    // (live repro: a not-yet-loaded video sent candidates and inherited the
    // neighbour's transcript under its own metadata).
    // onFeed can't be derived from the node alone: a DETACHED video (FB just
    // remounted it) has no [role="feed"] ancestor and would misclassify as
    // non-feed — the caller that KNOWS (overlay rails only exist on feed)
    // overrides. feedSurface also travels in the message so the background can
    // refuse candidates from feed jobs outright (defense in depth).
    const hinted = !fromPermalink && durationHint;
    const onFeed = onFeedOverride ?? !!feedUnitAnchor(video);
    const hint = hinted ? { durationHint, ...(primedAt ? { primedAt } : {}) } : {};
    const cands = hinted || onFeed ? {} : { candidates };
    const flags = { idConfident, feedSurface: !!onFeed };
    const lang = kind === "transcribe" ? { language: normTxLang(language || txLangCache) } : {};
    // Embedded-JSON lookup gets CONFIDENT ids only. Junk markup candidates
    // (story/actor/comment ids) routinely sit as ancestors of a DIFFERENT
    // video's media object in the hashtag page's combined JSON scripts — that
    // crossed one post's metadata with another video's audio. No confident id →
    // no embedded URL → the capture pipeline (prime + duration match) decides.
    const embedded = fbEmbeddedMediaFor(
      new Set(idConfident && id ? [id] : []),
    );
    if (kind === "transcribe") {
      // Prefer the embedded audio-only stream (small, in the DOM → no capture
      // wait, and a deterministic record id so the eager card below matches the
      // final one). Omit candidates + hint in that case so the background can't
      // switch the id to a captured track's. Never the progressive video
      // (slow to decode).
      if (embedded.audio)
        return { type: "FBW_TRANSCRIBE", ...meta, videoId: id, mediaUrl: embedded.audio, ...flags, ...lang };
      return { type: "FBW_TRANSCRIBE", ...meta, videoId: id, ...cands, ...hint, ...flags, ...lang };
    }
    if (embedded.progressive)
      return { type: "FBW_DOWNLOAD", videoId: id, mediaUrl: embedded.progressive, mediaName: `fb-${id || Date.now()}.mp4`, ...flags };
    return { type: "FBW_DOWNLOAD", videoId: id, ...cands, ...hint, ...flags };
  }
  // Show the transcript in the Library the instant it's requested: write a
  // "running" record (with the thumbnail/author/caption we already scraped) so
  // the card appears immediately; the background updates the same id when done.
  // Handed to the background rather than written here: the transcript store is a
  // single map with four writers, and a get → mutate → set from the page raced
  // the job runner's own writes (a finished transcript could be overwritten by a
  // running card). The background applies it inside its serialized queue, and
  // merges rather than replaces — this scrape may have missed a field the stored
  // record already has (counts especially), and a plain overwrite would write
  // that miss in as null.
  function writeRunningRecord(msg) {
    if (!msg || !msg.videoId) return;
    chrome.runtime
      .sendMessage({
        type: "FBW_TRANSCRIPT_PUT",
        videoId: msg.videoId,
        record: {
          videoId: msg.videoId,
          status: "running",
          platform: msg.platform,
          thumb: msg.thumb,
          counts: msg.counts,
          author: msg.author,
          caption: msg.caption,
          sourceUrl: msg.sourceUrl,
          videoKind: msg.videoKind,
          durationS: msg.durationS,
          language: msg.language,
        },
      })
      .catch(() => {});
  }
  // The live video a rail button refers to: the bound node if still attached,
  // else the video GEOMETRICALLY under the rail (FB remounts feed post
  // subtrees at will, including mid-job between prime and rebuild).
  //
  // A FLOATING rail (the feed overlay) is drawn inside its video's box, so "is it
  // still over that video?" is a real test — and a necessary one. Those rails are
  // position:fixed and only follow their post from a scroll handler; in a hidden tab
  // that handler cannot run, so a rail keeps its SCREEN position while the feed
  // scrolls underneath. Live repro: a rail bound to a 35s post sat over a 7.9s post
  // and transcribed the 35s one under the 7.9s one's card. When the binding and the
  // screen disagree, the screen wins — and if the rail is over no video at all, the
  // job fails loudly instead of quietly picking the wrong post.
  function liveVideoFor(btn, current) {
    const railRect = btn.getBoundingClientRect();
    const floating = !!btn.closest("#fbw-overlay");
    if (
      current &&
      !boundMediaIsStale({
        floating,
        connected: current.isConnected,
        railRect,
        boundRect: current.getBoundingClientRect(),
      })
    )
      return current;
    const videos = [...document.querySelectorAll("video")];
    const at = mediaUnderRail(railRect, videos.map((v) => v.getBoundingClientRect()));
    if (at >= 0) return videos[at];
    return floating ? null : current;
  }
  async function btnVideoJob(kind, boundVideo, btn, language) {
    if (btn.classList.contains("busy")) return;
    markBusy(kind, btn);
    // Overlay rails bind a GETTER (the tracked record's live video); in-DOM
    // rails bind the node itself.
    let video = liveVideoFor(
      btn,
      typeof boundVideo === "function" ? boundVideo() : targetVideoFor(boundVideo),
    );
    if (!video || !video.isConnected) {
      resolvePending(kind, false);
      return;
    }
    // Overlay rails exist ONLY on feed surfaces — a fact about the BUTTON, so
    // it stays true even when the video node detaches mid-flow.
    const onFeed = !!btn.closest("#fbw-overlay") || !!feedUnitAnchor(video);
    // Settle before scraping: a click landing in the reel-swap window would pair
    // the new reel's id with the old card's author/caption/counts.
    video = (await settleCapture(() => liveVideoFor(btn, video))) || video;
    let msg = await videoJobMessage(kind, video, undefined, onFeed, language);
    // No direct media URL and no trusted id → the tracks were never fetched (or
    // can't be told apart yet): play the video so its fbcdn tracks hit the wire,
    // then rebuild the message with what got captured. primedAt lets the
    // background break a same-duration tie with "fetched during this window".
    // Re-resolve the video after priming — FB may have remounted it meanwhile.
    if (!msg.mediaUrl && (kind === "download" || !msg.idConfident)) {
      const primedAt = Date.now();
      await primeVideo(video);
      video = liveVideoFor(btn, video);
      msg = await videoJobMessage(kind, video, primedAt, onFeed, language);
    }
    // Still nothing to key the job on (no id, no direct URL, no duration) —
    // fail HERE. Sending it would make the background guess by recency, which
    // is exactly the cross-video class of bug this pipeline just closed.
    if (!msg.videoId && !msg.mediaUrl && !msg.durationHint) {
      resolvePending(kind, false);
      return;
    }
    if (kind === "transcribe" && msg.idConfident) writeRunningRecord(msg); // instant card in the Library
    chrome.runtime.sendMessage(msg).catch(() => {});
    if (kind === "transcribe") backfillCounts(msg, () => liveVideoFor(btn, video));
  }
  function btnImageJob(boundImg, btn) {
    if (btn.classList.contains("busy")) return;
    const img = typeof boundImg === "function" ? boundImg() : boundImg;
    const url = img && (img.currentSrc || img.src);
    if (!url) return;
    markBusy("download", btn);
    const unit = findPostUnit(img) || img.closest('[role="article"]') || img;
    const author = grabAuthor(unit);
    const name = `fb-${sanitFb(author?.name) || "photo"}-${Date.now()}.jpg`;
    // Bare name + platform: this script is import-free (FB CSP), so the background
    // builds the social-mate/imagens/ path with lib/downloadPath.js.
    chrome.runtime.sendMessage({ type: "FBW_DL_MEDIA", platform: "facebook", kind: "image", url, filename: name }).catch(() => {});
  }

  const KIND_ICON = { transcribe: "tx", download: "dl", comment: "cm" };
  function mkBtn(kind, title, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "fbw-actbtn";
    const icon = KIND_ICON[kind] || "dl";
    b.dataset.kind = icon;
    b.title = title;
    b.dataset.tip = title; // instant CSS tooltip on hover
    b.innerHTML = btnIcon(icon);
    // Swallow the whole pointer sequence, not just click: FB's reel/video player
    // toggles play on pointerdown/mouseup, so a bare click handler still paused
    // the video. stopPropagation on each keeps the tap on our button only.
    const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
    for (const ev of ["pointerdown", "mousedown", "pointerup", "mouseup"])
      b.addEventListener(ev, swallow);
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onClick(b); });
    if (icon === "tx") enableTxBadge(b); // only Transcribe carries the BR/EN badge
    return b;
  }
  // Single-post permalink surfaces where scraping THIS post's comments makes
  // sense (a reel/video/post) — not the multi-post feed/hashtag grid.
  function commentSurface() {
    const p = location.pathname, s = location.search;
    return /\/reel\/\d|\/videos\/\d|\/watch\b|[?&]v=\d|\/posts\/|permalink\.php|story\.php|story_fbid/.test(p + s);
  }
  // The comment-scrape button lives in the same rail, below Transcribe. The
  // scrape engine is in comments-scrape.js (same isolated world) — the button
  // just fires a window event; a progress listener (below) reflects state back.
  function mkCommentBtn() {
    const b = mkBtn("comment", "Coletar comentários", () => {
      window.dispatchEvent(new CustomEvent("__fbwScrapeComments"));
    });
    b.dataset.cm = "1";
    return b;
  }
  window.addEventListener("__fbwScrapeProgress", (e) => {
    const { state, tip } = e.detail || {};
    for (const b of document.querySelectorAll('.fbw-actbtn[data-cm="1"]')) {
      b.classList.remove("busy", "ok", "err");
      if (state === "busy") { b.classList.add("busy"); b.innerHTML = btnIcon("cm"); }
      else if (state === "ok") { b.classList.add("ok"); b.innerHTML = btnIcon("ok"); }
      else if (state === "err") { b.classList.add("err"); b.innerHTML = btnIcon("cm"); }
      else b.innerHTML = btnIcon("cm");
      const t = tip || "Coletar comentários";
      b.dataset.tip = t;
      b.title = t;
    }
  });
  function buildVideoRail(video, onReel) {
    const wrap = document.createElement("div");
    // Reels are portrait + full-bleed: the top-left corner holds FB's mute
    // control, so the rail sits on the right side there; feed videos keep top-left.
    wrap.className = onReel ? "fbw-acts reel" : "fbw-acts";
    wrap.appendChild(mkBtn("download", "Baixar vídeo", (b) => btnVideoJob("download", video, b)));
    wrap.appendChild(mkBtn("transcribe", "Transcrever vídeo", (b) => openTxLangMenu(b, (lang) => btnVideoJob("transcribe", video, b, lang))));
    if (commentSurface()) wrap.appendChild(mkCommentBtn());
    return wrap;
  }
  function buildImageRail(img) {
    const wrap = document.createElement("div");
    wrap.className = "fbw-acts";
    wrap.appendChild(mkBtn("download", "Baixar foto", (b) => btnImageJob(img, b)));
    return wrap;
  }

  // ============================================================
  // Overlay rail layer — feed surfaces (hashtag results, etc.)
  // FB's virtualized feed remounts WHOLE post subtrees at will (every second
  // while a video plays), so any rail parented inside the feed dies with its
  // anchor: visible flicker, busy spinners resetting mid-job. The overlay lives
  // on <html> — outside FB's React root and outside our body MutationObserver —
  // and rails are POSITIONED over their media each sync tick instead of being
  // parented near it. Rail identity survives remounts via a duration/src key,
  // so the button element (and its busy/ok/err state) is never re-created.
  // ============================================================
  let overlayRoot = null;
  const overlayRails = new Map(); // key -> { rail, media }
  function ensureOverlayRoot() {
    if (overlayRoot && overlayRoot.isConnected) return overlayRoot;
    ensureBtnStyle();
    overlayRoot = document.getElementById("fbw-overlay") || document.createElement("div");
    overlayRoot.id = "fbw-overlay";
    document.documentElement.appendChild(overlayRoot);
    return overlayRoot;
  }
  function placeRail(rec) {
    const el = rec.media;
    if (!el || !el.isConnected) {
      // Remounted between syncs — hold the last position; the next sync re-binds.
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.width < 100 || r.bottom < 0 || r.top > window.innerHeight) {
      rec.rail.style.display = "none";
      return;
    }
    rec.rail.style.display = "";
    rec.rail.style.position = "fixed";
    rec.rail.style.top = Math.round(r.top + 10) + "px";
    rec.rail.style.left = Math.round(r.left + 10) + "px";
  }
  function overlayFeedMode() {
    return (
      surfaceAllowsMediaButtons() &&
      !/\/reel\//.test(location.pathname) &&
      !!document.querySelector('[role="feed"]')
    );
  }
  function syncOverlayRails() {
    if (!overlayFeedMode()) {
      if (overlayRails.size) {
        for (const rec of overlayRails.values()) rec.rail.remove();
        overlayRails.clear();
      }
      return;
    }
    ensureOverlayRoot();
    const vh = window.innerHeight;
    const seen = new Set();
    const durCount = {};
    for (const v of document.querySelectorAll('[role="feed"] video')) {
      const r = v.getBoundingClientRect();
      if (r.width < BTN.minMedia || r.height < 140) continue;
      if (r.bottom < -vh || r.top > vh * 2) continue;
      // Key by duration (deciseconds) + same-duration occurrence order — both
      // survive FB's node remounts, unlike the node itself.
      const d = Math.round((v.duration || 0) * 10) || 0;
      const n = (durCount[d] = (durCount[d] || 0) + 1);
      const key = `v:${d}:${n}`;
      seen.add(key);
      let rec = overlayRails.get(key);
      if (!rec) {
        rec = { rail: null, media: v };
        rec.rail = buildVideoRail(() => rec.media, false);
        overlayRoot.appendChild(rec.rail);
        overlayRails.set(key, rec);
      }
      rec.media = v;
      placeRail(rec);
    }
    for (const img of document.querySelectorAll(
      '[role="feed"] img[src*="fbcdn"], [role="feed"] img[src*="scontent"]',
    )) {
      const r = img.getBoundingClientRect();
      if (r.width < BTN.minImg || r.height < BTN.minImg) continue;
      if (r.bottom < -vh || r.top > vh * 2) continue;
      const unit = feedUnitAnchor(img);
      if (!unit || unit.querySelector("video")) continue; // videos own their rail
      const key = "i:" + (img.currentSrc || img.src || "").slice(-48);
      if (seen.has(key)) continue;
      seen.add(key);
      let rec = overlayRails.get(key);
      if (!rec) {
        rec = { rail: null, media: img };
        rec.rail = buildImageRail(() => rec.media);
        overlayRoot.appendChild(rec.rail);
        overlayRails.set(key, rec);
      }
      rec.media = img;
      placeRail(rec);
    }
    for (const [k, rec] of overlayRails)
      if (!seen.has(k)) {
        rec.rail.remove();
        overlayRails.delete(k);
      }
  }
  // Fixed-position rails don't scroll with the page — reposition immediately
  // (rAF-batched; a handful of getBoundingClientRect calls) instead of waiting
  // for the debounced decorate pass.
  let repositionQueued = false;
  // Two-phase to avoid layout thrash. placeRail() reads getBoundingClientRect and
  // then writes styles; running it in a loop meant read→write→read→write, so EVERY
  // rail forced its own synchronous layout (N rails = N full-document layouts per
  // scroll frame, and N is 10-30 on a feed). Now: read all rects first, then apply
  // all styles — one layout per frame regardless of rail count.
  function repositionOverlayRails() {
    repositionQueued = false;
    const vh = window.innerHeight;
    const frames = [];
    for (const rec of overlayRails.values()) {
      const el = rec.media;
      // Remounted between syncs — hold the last position; the next sync re-binds.
      if (!el || !el.isConnected) continue;
      frames.push([rec, el.getBoundingClientRect()]); // READ phase only
    }
    for (const [rec, r] of frames) {
      // WRITE phase only
      if (r.width < 100 || r.bottom < 0 || r.top > vh) {
        rec.rail.style.display = "none";
        continue;
      }
      const s = rec.rail.style;
      s.display = "";
      s.position = "fixed";
      s.top = Math.round(r.top + 10) + "px";
      s.left = Math.round(r.left + 10) + "px";
    }
  }
  // requestAnimationFrame DOES NOT RUN IN A HIDDEN TAB. The queue flag used to be
  // cleared only by the rAF callback, so one scroll while the tab was in the
  // background latched it at `true` FOREVER: every later scroll returned early, the
  // fixed-position rails stopped following their posts, and each one drifted over a
  // neighbouring post — which is how a Transcribe button next to post B started
  // jobs for post A. A timeout races the frame so the flag always clears, and
  // becoming visible again repositions immediately rather than waiting for the
  // debounced decorate pass.
  function queueReposition() {
    if (fbwDisabled || !overlayRails.size || repositionQueued) return;
    repositionQueued = true;
    let ran = false;
    const run = () => {
      if (ran) return;
      ran = true;
      repositionOverlayRails();
    };
    requestAnimationFrame(run);
    setTimeout(run, 200);
  }
  window.addEventListener("scroll", queueReposition, { passive: true, capture: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") queueReposition();
  });

  // Feed surfaces: FB re-renders the player subtree every second while a video
  // plays, so a rail hung on the video's own parent is destroyed + re-added each
  // tick (visible flicker). The post unit ([role="feed"] direct child) is stable
  // across those re-renders — hang the rail there, offset to the media's corner.
  // Bonus: the rail then lives OUTSIDE the tile's click target, so FB's
  // delegated click handler no longer opens the reel theater on button clicks.
  function feedUnitAnchor(mediaEl) {
    const feed = mediaEl.closest?.('[role="feed"]');
    if (!feed) return null;
    let n = mediaEl;
    while (n && n.parentElement !== feed) n = n.parentElement;
    return n || null;
  }

  // Where the per-video rail is allowed: the reel player, video-permalink
  // pages, and hashtag feeds (research surface — grab posts/photos in place).
  // NOT the home/profile feed — there you just open the reel to grab it,
  // and decorating every scrolling feed video was noise (and churn).
  function surfaceAllowsMediaButtons() {
    const p = location.pathname;
    return (
      /\/reel\//.test(p) ||
      /\/videos\//.test(p) ||
      /\/watch\b/.test(p) ||
      /\/hashtag\//.test(p) ||
      /[?&]v=\d/.test(location.search)
    );
  }

  let btnObserver = null;
  function decorateMedia() {
    if (document.visibilityState !== "visible") return;
    if (!surfaceAllowsMediaButtons()) {
      // left the reel/video surface → strip any rails we left behind
      document.querySelectorAll(".fbw-acts").forEach((el) => el.remove());
      return;
    }
    const vh = window.innerHeight;
    const targets = [];
    const onReel = /\/reel\//.test(location.pathname);
    // Videos (feed + reel + video-post). Near-viewport only, so decoration stays
    // bounded on long feeds. On a reel page FB mounts several <video> nodes
    // (current + preloads) — decorate only the single largest visible one so the
    // reel gets exactly one rail (its handlers resolve the active video anyway).
    let reelBest = null, reelBestArea = 0;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      if (r.width < BTN.minMedia || r.height < 140) continue;
      if (r.bottom < -vh || r.top > vh * 2) continue;
      if (onReel) {
        const visH = Math.min(r.bottom, vh) - Math.max(r.top, 0);
        const area = Math.max(0, visH) * r.width;
        if (area > reelBestArea) { reelBestArea = area; reelBest = v; }
        continue;
      }
      if (feedUnitAnchor(v)) continue; // feed media → overlay rails (remount-proof)
      const anchor = v.parentElement;
      if (anchor && !anchor.querySelector(":scope > .fbw-acts")) targets.push([anchor, "video", v]);
    }
    let staleReelRails = [];
    if (onReel && reelBest) {
      // Rails left on a previous reel's node (FB swaps nodes on navigate) — mark
      // for removal, but do it below AFTER the observer is disconnected so the
      // removals don't queue another observer callback.
      staleReelRails = Array.from(document.querySelectorAll(".fbw-acts")).filter(
        (el) => !el.parentElement || !el.parentElement.contains(reelBest),
      );
      const anchor = reelBest.parentElement;
      if (anchor && !anchor.querySelector(":scope > .fbw-acts")) targets.push([anchor, "video", reelBest]);
    }
    // Standalone photo posts: a large fbcdn image with NO video in its post unit.
    for (const img of document.querySelectorAll('img[src*="fbcdn"], img[src*="scontent"]')) {
      const r = img.getBoundingClientRect();
      if (r.width < BTN.minImg || r.height < BTN.minImg) continue;
      if (r.bottom < -vh || r.top > vh * 2) continue;
      if (feedUnitAnchor(img)) continue; // feed media → overlay rails (remount-proof)
      const unit = findPostUnit(img) || img.closest('[role="article"]');
      if (!unit || unit.querySelector("video")) continue; // videos own their rail
      const anchor = img.parentElement;
      if (anchor && !anchor.querySelector(":scope > .fbw-acts")) targets.push([anchor, "image", img]);
    }
    if (!targets.length && !staleReelRails.length) return;
    ensureBtnStyle();
    if (btnObserver) btnObserver.disconnect();
    staleReelRails.forEach((el) => el.remove());
    for (const [anchor, kind, el] of targets) {
      // Re-check after the disconnect — a concurrent pass may have decorated it.
      if (anchor.querySelector(":scope > .fbw-acts")) continue;
      if (getComputedStyle(anchor).position === "static") anchor.style.position = "relative";
      anchor.appendChild(kind === "video" ? buildVideoRail(el, onReel) : buildImageRail(el));
    }
    if (btnObserver) observeForBtns();
  }
  // ---- profile Reels tab: one floating "Download reel thumbnails" button ----
  // Restores the old panel feature on-page, where it's contextually relevant.
  // Only shows on a profile's Reels tab (not the /reel/<id> player, not the feed).
  let thumbBtn = null;
  function onReelsTab() {
    if (/\/reel\//.test(location.pathname)) return false;
    if (!/reels_tab|\/reels(\/|$)/.test(location.pathname + location.search)) return false;
    return document.querySelectorAll('a[href*="/reel/"] img').length >= 4;
  }
  function ensureThumbBtn() {
    if (!onReelsTab()) {
      if (thumbBtn) { thumbBtn.remove(); thumbBtn = null; }
      return;
    }
    if (thumbBtn) return;
    ensureBtnStyle();
    thumbBtn = document.createElement("button");
    thumbBtn.type = "button";
    thumbBtn.className = "fbw-thumbbtn";
    thumbBtn.innerHTML = `${btnIcon("dl", 15)}<span>Baixar miniaturas dos reels</span>`;
    thumbBtn.addEventListener("click", async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (thumbBtn.dataset.busy) return;
      thumbBtn.dataset.busy = "1";
      const span = thumbBtn.querySelector("span");
      const seen = new Map();
      const harvest = () => {
        for (const a of document.querySelectorAll('a[href*="/reel/"]')) {
          const m = (a.getAttribute("href") || "").match(/\/reel\/(\d+)/);
          const img = a.querySelector("img");
          if (m && img && img.src) seen.set(m[1], img.src);
        }
      };
      // lazy grid → scroll to the bottom until it stops growing
      harvest();
      let stable = 0;
      for (let i = 0; i < 40 && stable < 3; i++) {
        const before = seen.size;
        window.scrollTo({ top: document.body.scrollHeight });
        span.textContent = `Coletando… ${seen.size}`;
        await new Promise((r) => setTimeout(r, 1200));
        harvest();
        stable = seen.size === before ? stable + 1 : 0;
      }
      window.scrollTo({ top: 0 });
      const author = sanitFb((document.querySelector("h1")?.textContent || "page").trim()) || "page";
      let done = 0;
      for (const [id, url] of seen) {
        chrome.runtime.sendMessage({
          type: "FBW_DL_MEDIA", platform: "facebook", kind: "image", folder: "thumb", url,
          // Was a hardcoded "socialMate-thumbs/" folder (note the stray capital M).
          // The per-author sub-folder is kept — a whole page's covers in one place is
          // the point of this button — the -thumb suffix marks it now, and
          // downloadPath sanitises the author segment.
          filename: `${author}/reel_${id}.jpg`,
        }).catch(() => {});
        span.textContent = `Baixando ${++done}/${seen.size}`;
      }
      span.textContent = `✓ ${seen.size} miniaturas`;
      setTimeout(() => { if (thumbBtn) { thumbBtn.querySelector("span").textContent = "Baixar miniaturas dos reels"; delete thumbBtn.dataset.busy; } }, 3000);
    });
    document.body.appendChild(thumbBtn);
  }

  // An extension reload re-injects this script but leaves the previous
  // context's rails in the DOM with dead listeners — strip them so the fresh
  // pass doesn't stack a second rail next to a zombie one.
  document
    .querySelectorAll(".fbw-acts, .fbw-thumbbtn, #fbw-btn-style, #fbw-overlay")
    .forEach((el) => el.remove());

  let btnTimer = null;
  function scheduleDecorate() {
    if (fbwDisabled) return;
    clearTimeout(btnTimer);
    btnTimer = setTimeout(() => {
      if (fbwDisabled) return;
      if (typeof requestIdleCallback === "function")
        requestIdleCallback(() => { decorateMedia(); syncOverlayRails(); ensureThumbBtn(); }, { timeout: 700 });
      else { decorateMedia(); syncOverlayRails(); ensureThumbBtn(); }
    }, 350);
  }
  btnObserver = new MutationObserver(scheduleDecorate);
  const observeForBtns = () =>
    btnObserver.observe(document.body, { childList: true, subtree: true });
  observeForBtns();
  window.addEventListener("scroll", scheduleDecorate, { passive: true, capture: true });
  document.addEventListener("visibilitychange", scheduleDecorate);
  scheduleDecorate();
}
