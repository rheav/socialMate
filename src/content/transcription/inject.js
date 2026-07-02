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
    // beats the avatar/black poster fallbacks.
    try {
      if (videoEl.readyState >= 2 && videoEl.videoWidth) {
        const cv = document.createElement("canvas");
        cv.width = 120;
        cv.height =
          Math.round(120 * (videoEl.videoHeight / videoEl.videoWidth)) || 180;
        cv.getContext("2d").drawImage(videoEl, 0, 0, cv.width, cv.height);
        return cv.toDataURL("image/jpeg", 0.6);
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

  // Climb to the largest SINGLE-post ancestor: stop at the virtualized feed
  // scroller, or once the ancestor holds more than one video (= multiple posts).
  // This reaches the full post block (header + caption + action bar) without
  // spilling into neighbours.
  function findPostUnit(videoEl) {
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
  // Name-driven (not href-whitelisted): the author link varies wildly by surface
  // (/profile.php, vanity /name, page tab /watch/<pageId>/, …). We just take the
  // first link that ISN'T a hashtag / specific video / external, whose aria-label
  // or text reads like a name (aria stays clean even when FB scrambles the text).
  function grabAuthor(container) {
    if (!container) return null;
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
      const raw =
        aria ||
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
  function grabVideoId(container, videoEl) {
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
    // The theater MAIN video has no nearby permalink — its id is the page's ?v= target.
    // (Feed videos below it carry their own permalink, matched above.)
    try {
      return new URL(location.href).searchParams.get("v");
    } catch {
      return null;
    }
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
  function grabMeta(videoEl) {
    const container = findPostUnit(videoEl);
    return {
      videoId: grabVideoId(container, videoEl),
      platform: PLATFORM,
      thumb: grabThumb(videoEl),
      counts: grabCounts(container),
      author: grabAuthor(container),
      caption: grabCaption(container),
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

  // ---- publish the in-view video to the side panel (only when this tab is visible) ----
  let lastKey = null;
  function publishCurrent() {
    if (document.visibilityState !== "visible") return;
    const v = pickActiveVideo();
    if (!v) {
      if (lastKey !== null) {
        lastKey = null;
        chrome.runtime
          .sendMessage({ type: "FBW_CURRENT", current: null })
          .catch(() => {});
      }
      return;
    }
    const meta = grabMeta(v);
    const key = (meta.videoId || "") + "|" + (meta.caption || "").slice(0, 40);
    if (key === lastKey) return;
    lastKey = key;
    chrome.runtime
      .sendMessage({ type: "FBW_CURRENT", current: meta })
      .catch(() => {});
  }
  let raf = 0;
  const schedule = () => {
    if (!raf)
      raf = requestAnimationFrame(() => {
        raf = 0;
        publishCurrent();
      });
  };
  window.addEventListener("scroll", schedule, { passive: true, capture: true });
  window.addEventListener("resize", schedule, { passive: true });
  document.addEventListener("visibilitychange", publishCurrent);
  setInterval(publishCurrent, 1000);
  publishCurrent();

  // ---- run a job on request from the panel (relayed by the background) ----
  async function run(kind) {
    const v = pickActiveVideo();
    if (!v) return;
    await forcePlayOnly(v);
    const meta = grabMeta(v);
    const candidates = grabVideoIdCandidates(findPostUnit(v), v);
    if (kind === "transcribe")
      chrome.runtime
        .sendMessage({ type: "FBW_TRANSCRIBE", ...meta, candidates })
        .catch(() => {});
    else
      chrome.runtime
        .sendMessage({
          type: "FBW_DOWNLOAD",
          videoId: meta.videoId,
          candidates,
        })
        .catch(() => {});
  }
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "FBW_RUN_TRANSCRIBE") run("transcribe");
    if (msg?.type === "FBW_RUN_DOWNLOAD") run("download");
    if (msg?.type === "FBW_PING") {
      lastKey = null;
      publishCurrent();
      sendResponse?.({ ok: true });
    }
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
    if (opts.transcribe)
      chrome.runtime
        .sendMessage({ type: "FBW_TRANSCRIBE", ...meta, candidates })
        .catch(() => {});
    if (opts.download)
      chrome.runtime
        .sendMessage({ type: "FBW_DOWNLOAD", videoId: id, candidates })
        .catch(() => {});
  }
  window.addEventListener("__fbw_auto_capture", (e) =>
    autoCapture(e.detail || {}),
  );
}
