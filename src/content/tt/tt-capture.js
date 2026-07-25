// TikTok capture — runs in the PAGE's MAIN world at document_start.
//
// Unlike Instagram (parses feed JSON on the main thread → JSON.parse hook),
// TikTok reads its API responses with `fetch().json()` — native parsing that a
// JSON.parse monkey-patch never sees (verified live: 0/167 caught). So we tee
// the RESPONSE BODIES of TikTok's own fetch/XHR calls instead. This is passive:
// we only read what the page already requested — no forged/signed requests, so
// no msToken/X-Bogus/X-Gnarly and no account-flagging risk.
//
// We relay compact records to our isolated bridge via window.postMessage (the two
// worlds share the DOM, not JS).

(function () {
  if (window.__fbwTtMainInit) return;
  window.__fbwTtMainInit = true;

  // Endpoints worth teeing. Video lists (profile / feed / hashtag / search) all
  // return an `itemList[]` of the same shape; comments return `comments[]`.
  const VIDEO_RE = /\/api\/(?:post|recommend|related|challenge|search|user)\/(?:item_list|item)\b/;
  const MIX_RE = /\/api\/(?:mix|collection)\/item_list\b/; // playlist / collection videos
  const STORY_RE = /\/api\/story\/item_list\b/;
  const LISTMETA_RE = /\/api\/user\/(?:playlist|collection_list)\b/; // playlist/collection metadata
  const COMMENT_RE = /\/api\/comment\/list\b/;
  const interesting = (u) =>
    typeof u === "string" &&
    (VIDEO_RE.test(u) || MIX_RE.test(u) || STORY_RE.test(u) || LISTMETA_RE.test(u) || COMMENT_RE.test(u));

  const num = (v) => (v == null ? null : typeof v === "number" ? v : (Number.isFinite(+v) ? +v : null));

  // Highest-quality video URL from bitrateInfo gears: max resolution, then max
  // bitrate. (bitrateInfo[0] is TikTok's default ~720; a 1080 gear usually sits
  // deeper.) Returns { url, width, height, codec } or null.
  function bestBitrate(v) {
    const gears = Array.isArray(v.bitrateInfo) ? v.bitrateInfo : [];
    let best = null;
    for (const g of gears) {
      const pa = g.PlayAddr || {};
      const url = (pa.UrlList && pa.UrlList[0]) || null;
      if (!url) continue;
      const area = (num(pa.Width) || 0) * (num(pa.Height) || 0);
      const score = area * 1e6 + (num(g.Bitrate) || 0);
      if (!best || score > best.score) best = { url, width: num(pa.Width), height: num(pa.Height), codec: g.CodecType, bitrate: num(g.Bitrate), score };
    }
    return best;
  }
  // Best caption track — a direct webvtt URL to download instead of running
  // Whisper. Prefer an English track, else the first. { url, lang, format }.
  function bestSubtitle(v) {
    const subs = Array.isArray(v.subtitleInfos) ? v.subtitleInfos : [];
    if (!subs.length) return null;
    const pick = subs.find((s) => /eng/i.test(s.LanguageCodeName || "")) || subs[0];
    const url = pick.Url || (pick.UrlList && pick.UrlList[0]) || null;
    if (!url) return null;
    return { url, lang: pick.LanguageCodeName || null, format: (pick.Format || "webvtt").toLowerCase(), source: pick.Source || null };
  }

  function liteItem(it) {
    const v = it.video || {};
    const a = it.author || {};
    const s = it.statsV2 || it.stats || {};
    const m = it.music || {};
    const hd = bestBitrate(v);
    const sub = bestSubtitle(v);
    return {
      __kind: "video",
      id: String(it.id || v.id || ""),
      username: a.uniqueId || null,
      nickname: a.nickname || null,
      author_id: a.id ? String(a.id) : null,
      play_count: num(s.playCount),
      digg_count: num(s.diggCount),
      comment_count: num(s.commentCount),
      share_count: num(s.shareCount),
      collect_count: num(s.collectCount),
      repost_count: num(s.repostCount),
      video: v.playAddr || null,
      // Highest-quality URL for downloads (falls back to downloadAddr/playAddr).
      hd_url: (hd && hd.url) || v.downloadAddr || v.playAddr || null,
      hd_res: hd ? `${hd.width}x${hd.height}` : null,
      download_url: v.downloadAddr || v.playAddr || null,
      subtitle: sub, // { url, lang, format } — caption-first transcription
      cover: v.cover || v.originCover || null,
      dynamic_cover: v.dynamicCover || null,
      duration: num(v.duration),
      width: num(v.width),
      height: num(v.height),
      desc: (it.desc || "").slice(0, 500) || null,
      create_time: num(it.createTime),
      music: m.title ? { title: m.title, author: m.authorName || null, id: m.id ? String(m.id) : null } : null,
      hashtags: Array.isArray(it.challenges) ? it.challenges.map((c) => c && c.title).filter(Boolean) : [],
      pinned: !!it.isPinnedItem,
    };
  }

  function liteComment(c) {
    const u = c.user || {};
    return {
      __kind: "comment",
      cid: String(c.cid || c.id || ""),
      aweme_id: String(c.aweme_id || ""),
      text: (c.text || "").slice(0, 2000),
      digg_count: num(c.digg_count),
      reply_count: num(c.reply_comment_total != null ? c.reply_comment_total : c.reply_comment_count),
      username: u.unique_id || null,
      nickname: u.nickname || null,
      create_time: num(c.create_time),
      // Replies carry a reply_id (parent). Top-level comments have reply_id "0"/absent.
      is_reply: !!(c.reply_id && c.reply_id !== "0"),
      parent: c.reply_id && c.reply_id !== "0" ? String(c.reply_id) : null,
    };
  }

  const sentVid = new Map(); // id -> signature (skip resends of unchanged records)
  const allVid = new Map(); // id -> record, for replay
  const sentCom = new Set(); // cid, dedup
  const allCom = new Map(); // cid -> record, for replay

  function send(records) {
    if (records.length) window.postMessage({ __fbwTt: true, records }, location.origin);
  }

  const qparam = (url, name) => { try { return new URL(url, location.origin).searchParams.get(name); } catch { return null; } };

  function ingest(url, obj) {
    try {
      const out = [];
      const isStory = STORY_RE.test(url);
      const listId = MIX_RE.test(url) ? (qparam(url, "mixId") || qparam(url, "collectionId")) : null;
      const items = obj && (obj.itemList || obj.items);
      if (Array.isArray(items)) {
        for (const it of items) {
          if (!it || (!it.stats && !it.statsV2 && !it.video)) continue;
          const r = liteItem(it);
          if (!r.id) continue;
          if (isStory) { r.__kind = "tt_story"; r.reel_owner = r.username || null; }
          if (listId) r.list_id = String(listId); // playlist/collection membership
          allVid.set(r.id, r);
          const sig = `${r.__kind}|${r.play_count}|${r.digg_count}|${r.comment_count}|${r.share_count}|${r.collect_count}`;
          if (sentVid.get(r.id) !== sig) { sentVid.set(r.id, sig); out.push(r); }
        }
      }
      // Playlist / collection metadata (the buckets themselves).
      const lists = obj && (obj.playList || obj.playlist || obj.collectionList || obj.collection);
      if (Array.isArray(lists)) {
        for (const L of lists) {
          if (!L) continue;
          const id = String(L.mixId || L.id || L.collectionId || "");
          if (!id) continue;
          out.push({
            __kind: "tt_list",
            list_id: id,
            kind: L.mixId || L.mixName ? "playlist" : "collection",
            name: L.name || L.mixName || L.collectionName || L.title || "Untitled",
            video_count: num(L.videoCount != null ? L.videoCount : (L.total != null ? L.total : L.itemCount)),
            cover: L.cover || L.coverUrl || (L.coverMedia && L.coverMedia.cover) || null,
            owner: (L.creator && L.creator.uniqueId) || null,
          });
        }
      }
      const comments = obj && obj.comments;
      if (Array.isArray(comments)) {
        for (const c of comments) {
          if (!c) continue;
          const r = liteComment(c);
          if (!r.cid) continue;
          allCom.set(r.cid, r);
          if (!sentCom.has(r.cid)) { sentCom.add(r.cid); out.push(r); }
          // Nested reply previews some responses embed under `reply_comment`.
          if (Array.isArray(c.reply_comment)) {
            for (const rc of c.reply_comment) {
              if (!rc) continue;
              const rr = liteComment(rc);
              if (rr.cid && !sentCom.has(rr.cid)) { sentCom.add(rr.cid); allCom.set(rr.cid, rr); out.push(rr); }
            }
          }
        }
      }
      // Cap replay buffers for long SPA sessions (oldest evicts first).
      while (allVid.size > 1200) allVid.delete(allVid.keys().next().value);
      while (sentVid.size > 1200) sentVid.delete(sentVid.keys().next().value);
      while (allCom.size > 2000) allCom.delete(allCom.keys().next().value);
      send(out);
    } catch (_) {}
  }

  // ---- fetch tee ----
  const oFetch = window.fetch;
  if (typeof oFetch === "function") {
    window.fetch = function (...args) {
      const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url);
      const p = oFetch.apply(this, args);
      if (interesting(url)) {
        p.then((res) => { res.clone().text().then((t) => { try { ingest(url, JSON.parse(t)); } catch {} }).catch(() => {}); }).catch(() => {});
      }
      return p;
    };
  }

  // ---- XHR tee (belt-and-suspenders; TikTok uses fetch today) ----
  const oOpen = XMLHttpRequest.prototype.open;
  const oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) { this.__fbwUrl = url; return oOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    if (interesting(this.__fbwUrl)) {
      this.addEventListener("load", () => {
        try { ingest(this.__fbwUrl, JSON.parse(this.responseText)); } catch {}
      });
    }
    return oSend.apply(this, arguments);
  };

  // The isolated bridge attaches at document_idle — after we start capturing. It
  // asks us to replay everything buffered (videos + comments).
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data && e.data.__fbwTtReq)
      send([...allVid.values(), ...allCom.values()]);
  });
})();
