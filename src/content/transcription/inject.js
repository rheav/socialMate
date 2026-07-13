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

  // which social network this capture came from (IG/TikTok added later)
  const PLATFORM = /instagram\.com$/.test(location.hostname)
    ? "instagram"
    : /tiktok\.com$/.test(location.hostname)
      ? "tiktok"
      : "facebook";

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
    // beats the avatar/black poster fallbacks. Kept small: the card renders it at
    // ~140px, and the thumbnail was ~78% of each stored transcript record, so a
    // 90px / q0.45 JPEG roughly halves the record size with no visible loss.
    try {
      if (videoEl.readyState >= 2 && videoEl.videoWidth) {
        const W = 90;
        const cv = document.createElement("canvas");
        cv.width = W;
        cv.height =
          Math.round(W * (videoEl.videoHeight / videoEl.videoWidth)) || 135;
        cv.getContext("2d").drawImage(videoEl, 0, 0, cv.width, cv.height);
        return cv.toDataURL("image/jpeg", 0.45);
      }
    } catch {}
    if (videoEl.poster) return videoEl.poster;
    const host = videoEl.closest('[role="article"]') || videoEl.closest("div");
    const img = host && host.querySelector('img[src*="fbcdn"]');
    return img ? img.src : null;
  }
  const LBL = {
    like: /^(like|curtir|gostei|me gusta|j'aime|mi piace|gefällt mir)$/i,
    comment:
      /^(comment|comentar|comentário|comentarios|commenter|kommentieren)$/i,
    share: /^(share|compartilhar|compartir|partager|teilen|condividi)$/i,
  };
  const COUNT_RE = /^\d[\d.,]*\s?(mil|k|m|mi|rb|jt|tis)?$/i;

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
    let el = videoEl,
      best = null;
    for (let i = 0; i < 22 && el; i++) {
      const txt = (el.innerText || "").trim();
      if (/(?:Facebook ){4}/.test(txt)) break;
      if ((el.querySelectorAll?.("video") || []).length > 1) break;
      if (txt.length > 30) best = el;
      el = el.parentElement;
    }
    return best;
  }

  // Two count layouts:
  //  • feed/permalink: bare numbers in the action row, order [reactions, comments, shares]
  //  • watch theater: a word summary "2 · 1 comment · 103 views" (separate subtree)
  // Parse the word summary from the text AFTER the Share button (avoids the video
  // timecode "0:08" + caption "comment …" colliding with the regexes), and fall
  // back to the action-row bare numbers. Also captures `views` (theater only).
  function grabCounts(container) {
    if (!container) return null;
    // (a) bare numbers from the action row
    const bare = [];
    const likeBtn = [
      ...container.querySelectorAll('[aria-label][role="button"]'),
    ].find((b) => LBL.like.test(b.getAttribute("aria-label") || ""));
    if (likeBtn) {
      let row = likeBtn;
      for (let i = 0; i < 7 && row.parentElement; i++) {
        row = row.parentElement;
        if (
          [...row.querySelectorAll("[aria-label]")].some((b) =>
            /leave a comment|comentar|escrever|kommentar|commenter/i.test(
              b.getAttribute("aria-label") || "",
            ),
          )
        )
          break;
      }
      row.querySelectorAll("span,div").forEach((n) => {
        if (n.children.length) return;
        const t = (n.textContent || "").trim();
        if (t.length <= 8 && COUNT_RE.test(t)) bare.push(t);
      });
    }
    // (b) word summary after the Share button
    const text = (container.innerText || "").replace(/\s+/g, " ");
    const af = /\bShare\b/i.test(text) ? text.split(/\bShare\b/i).pop() : "";
    const num = "([\\d.,]+\\s?(?:mil|k|m|mi|rb|jt)?)";
    const w = (re) => {
      const m = af.match(new RegExp(re, "i"));
      return m ? m[1].trim() : null;
    };
    const reactW = (af.trim().match(/^(\d[\d.,]*\s?(?:mil|k|m|mi)?)/i) ||
      [])[1];
    const counts = {
      like: bare[0] || (reactW ? reactW.trim() : null),
      comment: w(num + "\\s+comments?\\b") || bare[1] || null,
      share: w(num + "\\s+shares?\\b") || bare[2] || null,
      views: w(num + "\\s*(?:views?|visualiz\\w*)\\b"),
    };
    return counts.like || counts.comment || counts.share || counts.views
      ? counts
      : null;
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
    let el = container || videoEl;
    for (let k = 0; k < 5 && el; k++) {
      const links =
        el.querySelectorAll?.(
          'a[href*="v="], a[href*="/videos/"], a[href*="/reel/"]',
        ) || [];
      for (const a of links) {
        const m = (a.getAttribute("href") || "").match(
          /[?&]v=(\d+)|\/videos\/(\d+)|\/reel\/(\d+)/,
        );
        if (m) return m[1] || m[2] || m[3];
      }
      el = el.parentElement;
    }
    // Fallback: the page URL id (theater MAIN video, or any surface missed above).
    return fromUrl;
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
    // A feed post (warmer auto-capture): reconstruct from the video id if we have one.
    const id = grabVideoId(container, videoEl);
    if (id) return `https://www.facebook.com/watch/?v=${id}`;
    return location.href.split("?")[0];
  }
  function grabMeta(videoEl) {
    const container = findPostUnit(videoEl);
    return {
      videoId: grabVideoId(container, videoEl),
      platform: PLATFORM,
      thumb: grabThumb(videoEl),
      counts: grabCounts(container),
      author: grabAuthor(container),
      caption: grabCaption(container),
      sourceUrl: currentSourceUrl(container, videoEl),
    };
  }

  async function forcePlayOnly(videoEl) {
    document.querySelectorAll("video").forEach((v) => {
      if (v !== videoEl)
        try {
          v.pause();
        } catch {}
    });
    try {
      videoEl.play();
    } catch {}
    videoEl.scrollIntoView({ block: "center" });
    await new Promise((r) => setTimeout(r, 1600));
  }

  // Capture/download/transcription now runs entirely from the on-page buttons
  // (below) and the warmer's auto-capture — the old side-panel "Current video"
  // card was removed, so there is no consumer for a per-frame fbw_current publish.
  // We therefore do NOT scrape/encode the in-view video on an interval or on
  // scroll (grabThumb is a canvas readback — expensive to run every second). The
  // background still relays FBW_RUN_* if anything asks; kept as a cheap no-cost path.

  // ---- run a job on request (relayed by the background); acts on the in-view video ----
  async function run(kind) {
    const v = pickActiveVideo();
    if (!v) return;
    await forcePlayOnly(v);
    chrome.runtime.sendMessage(videoJobMessage(kind, v)).catch(() => {});
  }
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "FBW_RUN_TRANSCRIBE") run("transcribe");
    if (msg?.type === "FBW_RUN_DOWNLOAD") run("download");
    // Background job results → flip the matching on-page button to ✓/✗.
    if (msg?.type === "FBW_TRANSCRIBE_RESULT") resolvePending?.("transcribe", !!msg.success);
    if (msg?.type === "FBW_DOWNLOAD_RESULT") resolvePending?.("download", !!msg.success);
    // Liveness probe (background sets the panel's reload hint from the reply).
    if (msg?.type === "FBW_PING") sendResponse?.({ ok: true });
  });

  // ---- auto-capture (driven by the warmer engine in the same tab) ----
  // content.js (the warmer) dispatches a "__fbw_auto_capture" window event when an
  // in-view video post clears the user's thresholds. We grab that video's metadata
  // and kick off transcribe/download jobs and/or stash it in the Saved (favorites)
  // tab. The warmer already played the video, so its fbcdn tracks are captured.
  async function saveFavorite(meta) {
    try {
      const r = await chrome.storage.local.get("fbw_saved");
      const map = r.fbw_saved || {};
      const prev = map[meta.videoId] || {};
      // merge: keep any existing transcript text/chunks, refresh the metadata
      map[meta.videoId] = {
        ...prev,
        ...meta,
        videoId: meta.videoId,
        autoSaved: true,
        updatedAt: Date.now(),
      };
      await chrome.storage.local.set({ fbw_saved: map });
    } catch {}
  }
  async function autoCapture(opts) {
    const v = pickActiveVideo();
    if (!v) return;
    try {
      v.play();
    } catch {}
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
    if (opts.transcribe)
      chrome.runtime.sendMessage(videoJobMessage("transcribe", v)).catch(() => {});
    if (opts.download)
      chrome.runtime.sendMessage(videoJobMessage("download", v)).catch(() => {});
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
      .fbw-actbtn{pointer-events:auto;display:grid;place-items:center;width:${BTN.size}px;height:${BTN.size}px;
        border-radius:9px;cursor:pointer;color:#fff;background:rgba(0,0,0,.6);
        -webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);border:1px solid rgba(160,190,255,.25);
        box-shadow:0 1px 6px rgba(0,0,0,.35);transition:background .15s,color .15s,transform .1s}
      .fbw-actbtn:hover{background:rgba(24,119,242,.92);transform:translateY(-1px)}
      .fbw-actbtn:active{transform:translateY(0)}
      .fbw-actbtn.busy{color:#93c5fd;cursor:default}
      .fbw-actbtn.busy svg{animation:fbw-spin 1s linear infinite}
      .fbw-actbtn.ok{color:#34d399;border-color:rgba(52,211,153,.6)}
      .fbw-actbtn.err{color:#f87171;border-color:rgba(248,113,113,.6)}
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
  function ensurePlaying(video) {
    if (video && video.paused) {
      try { video.play(); } catch {}
    }
  }
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
    if (state === "busy") { btn.classList.add("busy"); btn.innerHTML = btnIcon(btn.dataset.kind === "tx" ? "tx" : "dl"); }
    else if (state === "ok") { btn.classList.add("ok"); btn.innerHTML = btnIcon("ok"); }
    else if (state === "err") { btn.classList.add("err"); btn.innerHTML = btnIcon("err"); }
    else btn.innerHTML = btnIcon(btn.dataset.kind === "tx" ? "tx" : "dl");
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
    const idleTitle = btn.dataset.kind === "tx" ? "Transcribe video" : "Download video";
    btn.title = ok ? idleTitle : "Couldn't grab the media — let the video play once, then retry";
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
    for (let i = 0; i < 14; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (!video.paused && video.currentTime > t0 + 0.15) break;
    }
  }
  // Build the job message for a video: prefer the page's embedded progressive_url
  // (works even for cached videos), fall back to the captured-track pipeline
  // (videoId + candidates) when no embedded URL is present.
  function videoJobMessage(kind, video) {
    const unit = findPostUnit(video) || video;
    const meta = grabMeta(video);
    const candidates = grabVideoIdCandidates(unit, video);
    const id = meta.videoId || candidates[0] || null;
    const embedded = fbEmbeddedMediaFor(new Set([id, ...candidates].filter(Boolean)));
    if (kind === "transcribe") {
      // Prefer the embedded audio-only stream (small, in the DOM → no capture
      // wait, and a deterministic record id so the eager card below matches the
      // final one). Omit candidates in that case so the background can't switch
      // the id to a captured track's. Only fall back to candidates (capture) when
      // no embedded audio exists. Never the progressive video (slow to decode).
      if (embedded.audio)
        return { type: "FBW_TRANSCRIBE", ...meta, videoId: id, mediaUrl: embedded.audio };
      return { type: "FBW_TRANSCRIBE", ...meta, videoId: id, candidates };
    }
    if (embedded.progressive)
      return { type: "FBW_DOWNLOAD", videoId: id, mediaUrl: embedded.progressive, mediaName: `fb-${id || Date.now()}.mp4` };
    return { type: "FBW_DOWNLOAD", videoId: id, candidates };
  }
  // Show the transcript in the Library the instant it's requested: write a
  // "running" record (with the thumbnail/author/caption we already scraped) so
  // the card appears immediately; the background updates the same id when done.
  function writeRunningRecord(msg) {
    if (!msg || !msg.videoId) return;
    chrome.storage.local.get("fbw_transcripts").then((r) => {
      const all = r.fbw_transcripts || {};
      const prev = all[msg.videoId];
      if (prev && prev.status === "done") return; // don't clobber a finished one
      all[msg.videoId] = {
        ...(prev || {}),
        videoId: msg.videoId,
        status: "running",
        platform: msg.platform,
        thumb: msg.thumb,
        counts: msg.counts,
        author: msg.author,
        caption: msg.caption,
        sourceUrl: msg.sourceUrl,
        updatedAt: Date.now(),
      };
      chrome.storage.local.set({ fbw_transcripts: all });
    }).catch(() => {});
  }
  async function btnVideoJob(kind, boundVideo, btn) {
    if (btn.classList.contains("busy")) return;
    markBusy(kind, btn);
    const video = targetVideoFor(boundVideo);
    let msg = videoJobMessage(kind, video);
    if (kind === "transcribe") {
      writeRunningRecord(msg); // instant card in the Library
    } else if (!msg.mediaUrl) {
      // Download with no embedded progressive URL → needs a captured track;
      // prime the video first, then rebuild the message with what got captured.
      await primeVideo(video);
      msg = videoJobMessage(kind, video);
    }
    chrome.runtime.sendMessage(msg).catch(() => {});
  }
  function btnImageJob(img, btn) {
    if (btn.classList.contains("busy")) return;
    const url = img.currentSrc || img.src;
    if (!url) return;
    markBusy("download", btn);
    const unit = findPostUnit(img) || img.closest('[role="article"]') || img;
    const author = grabAuthor(unit);
    const name = `fb-${sanitFb(author?.name) || "photo"}-${Date.now()}.jpg`;
    chrome.runtime.sendMessage({ type: "FBW_DL_MEDIA", kind: "image", url, filename: name }).catch(() => {});
  }

  function mkBtn(kind, title, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "fbw-actbtn";
    b.dataset.kind = kind === "transcribe" ? "tx" : "dl";
    b.title = title;
    b.innerHTML = btnIcon(kind === "transcribe" ? "tx" : "dl");
    // Swallow the whole pointer sequence, not just click: FB's reel/video player
    // toggles play on pointerdown/mouseup, so a bare click handler still paused
    // the video. stopPropagation on each keeps the tap on our button only.
    const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
    for (const ev of ["pointerdown", "mousedown", "pointerup", "mouseup"])
      b.addEventListener(ev, swallow);
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onClick(b); });
    return b;
  }
  function buildVideoRail(video, onReel) {
    const wrap = document.createElement("div");
    // Reels are portrait + full-bleed: the top-left corner holds FB's mute
    // control, so the rail sits on the right side there; feed videos keep top-left.
    wrap.className = onReel ? "fbw-acts reel" : "fbw-acts";
    wrap.appendChild(mkBtn("download", "Download video", (b) => btnVideoJob("download", video, b)));
    wrap.appendChild(mkBtn("transcribe", "Transcribe video", (b) => btnVideoJob("transcribe", video, b)));
    return wrap;
  }
  function buildImageRail(img) {
    const wrap = document.createElement("div");
    wrap.className = "fbw-acts";
    wrap.appendChild(mkBtn("download", "Download photo", (b) => btnImageJob(img, b)));
    return wrap;
  }

  // Give an element a positioned parent to hang the absolute rail on, and return it.
  function anchorFor(mediaEl) {
    const p = mediaEl.parentElement;
    if (!p) return null;
    if (getComputedStyle(p).position === "static") p.style.position = "relative";
    return p;
  }

  // Where the per-video rail is allowed: the reel player and video-permalink
  // pages. NOT the home/profile feed — there you just open the reel to grab it,
  // and decorating every scrolling feed video was noise (and churn).
  function surfaceAllowsMediaButtons() {
    const p = location.pathname;
    return (
      /\/reel\//.test(p) ||
      /\/videos\//.test(p) ||
      /\/watch\b/.test(p) ||
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
      const anchor = anchorFor(v);
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
      const anchor = anchorFor(reelBest);
      if (anchor && !anchor.querySelector(":scope > .fbw-acts")) targets.push([anchor, "video", reelBest]);
    }
    // Standalone photo posts: a large fbcdn image with NO video in its post unit.
    for (const img of document.querySelectorAll('img[src*="fbcdn"], img[src*="scontent"]')) {
      const r = img.getBoundingClientRect();
      if (r.width < BTN.minImg || r.height < BTN.minImg) continue;
      if (r.bottom < -vh || r.top > vh * 2) continue;
      const unit = findPostUnit(img) || img.closest('[role="article"]');
      if (!unit || unit.querySelector("video")) continue; // videos own their rail
      const anchor = anchorFor(img);
      if (anchor && !anchor.querySelector(":scope > .fbw-acts")) targets.push([anchor, "image", img]);
    }
    if (!targets.length && !staleReelRails.length) return;
    ensureBtnStyle();
    if (btnObserver) btnObserver.disconnect();
    staleReelRails.forEach((el) => el.remove());
    for (const [anchor, kind, el] of targets) {
      // Re-check after the disconnect — a concurrent pass may have decorated it.
      if (anchor.querySelector(":scope > .fbw-acts")) continue;
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
    thumbBtn.innerHTML = `${btnIcon("dl", 15)}<span>Download reel thumbnails</span>`;
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
        span.textContent = `Collecting… ${seen.size}`;
        await new Promise((r) => setTimeout(r, 1200));
        harvest();
        stable = seen.size === before ? stable + 1 : 0;
      }
      window.scrollTo({ top: 0 });
      const author = sanitFb((document.querySelector("h1")?.textContent || "page").trim()) || "page";
      let done = 0;
      for (const [id, url] of seen) {
        chrome.runtime.sendMessage({
          type: "FBW_DL_MEDIA", kind: "image", url,
          filename: `socialMate-thumbs/${author}/reel_${id}.jpg`,
        }).catch(() => {});
        span.textContent = `Downloading ${++done}/${seen.size}`;
      }
      span.textContent = `✓ ${seen.size} thumbnails`;
      setTimeout(() => { if (thumbBtn) { thumbBtn.querySelector("span").textContent = "Download reel thumbnails"; delete thumbBtn.dataset.busy; } }, 3000);
    });
    document.body.appendChild(thumbBtn);
  }

  let btnTimer = null;
  function scheduleDecorate() {
    clearTimeout(btnTimer);
    btnTimer = setTimeout(() => {
      if (typeof requestIdleCallback === "function")
        requestIdleCallback(() => { decorateMedia(); ensureThumbBtn(); }, { timeout: 700 });
      else { decorateMedia(); ensureThumbBtn(); }
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
