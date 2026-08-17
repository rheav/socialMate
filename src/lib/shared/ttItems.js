// TikTok payload → lite record. Canonical source, INLINED into the TikTok capture
// scripts — see ./README.md before editing (no imports allowed in this file).
//
// WHY THIS EXISTS. Two copies of this mapping had already grown apart:
// tt-capture.js's `liteItem` (for fetch/XHR payloads) and tt-relay.js's `mapItem`
// (for the SSR hydration blob on a /video/ page). Both read the SAME webapp item
// struct; only their entry points differ.
//
// It also fixes a live blind spot found on 2026-08-16 (see
// docs/research/tiktok-data-map.md): the TikTok SEARCH surface produced ZERO
// records, for two independent reasons —
//
//   * /api/search/general/full/ (the default "Melhores" tab) answers with
//     `data[] → {type, item}`, and /api/search/item/full/ (the "Vídeos" tab)
//     answers with `item_list` — while the reader only ever looked at `itemList`
//     and `items`;
//   * neither URL matched the endpoint regex in the first place.
//
// And it stops throwing away `authorStats`, which every list payload carries.
// That is the follower count — the denominator behind "did well FOR an account
// this size" — and on Instagram it costs a separate enrichment round-trip.

const ttNum = (v) => (v == null ? null : typeof v === "number" ? v : Number.isFinite(+v) ? +v : null);

/**
 * Every list-shaped root TikTok answers with, flattened to raw items.
 *   itemList   /api/post|recommend|related|challenge/item_list/  (camelCase)
 *   item_list  /api/search/item/full/                            (snake_case)
 *   data[]     /api/search/general/full/  → {type, item, common}; type 1 = video,
 *              other types are user/live cards and carry no `item`
 */
export function ttItemsIn(obj) {
  if (!obj || typeof obj !== "object") return [];
  const direct = obj.itemList || obj.item_list || obj.items;
  if (Array.isArray(direct)) return direct.filter(Boolean);
  if (Array.isArray(obj.data))
    return obj.data.map((d) => (d && typeof d === "object" ? d.item || null : null)).filter(Boolean);
  return [];
}

/**
 * Creator records: /api/search/user/full/ → `user_list[].user_info`, and
 * /api/user/detail/ → `userInfo.{user,stats}` (a different shape entirely, so it
 * is normalized here rather than at each call site).
 */
export function ttUsersIn(obj) {
  if (!obj || typeof obj !== "object") return [];
  const out = [];
  if (Array.isArray(obj.user_list))
    for (const e of obj.user_list) if (e && e.user_info) out.push(e.user_info);
  const ui = obj.userInfo;
  if (ui && ui.user) out.push({ ...ui.user, __stats: ui.stats || ui.statsV2 || null });
  return out;
}

/**
 * Highest-quality rendition: max resolution first, then max bitrate.
 * bitrateInfo[0] is TikTok's default gear, not its best — a 1080 gear usually
 * sits deeper in the ladder. Returns { url, width, height, codec, bitrate } or null.
 */
export function ttBestBitrate(video) {
  const gears = Array.isArray(video && video.bitrateInfo) ? video.bitrateInfo : [];
  let best = null;
  for (const g of gears) {
    const pa = (g && g.PlayAddr) || {};
    const url = (pa.UrlList && pa.UrlList[0]) || null;
    if (!url) continue;
    const area = (ttNum(pa.Width) || 0) * (ttNum(pa.Height) || 0);
    const score = area * 1e6 + (ttNum(g.Bitrate) || 0);
    if (!best || score > best.score)
      best = { url, width: ttNum(pa.Width), height: ttNum(pa.Height), codec: g.CodecType || null, bitrate: ttNum(g.Bitrate), score };
  }
  return best;
}

/**
 * The caption track to transcribe from — a direct WebVTT URL, which skips Whisper
 * entirely. Prefer an English track, else the first.
 *
 * Two places carry the same URLs: `video.subtitleInfos` (LanguageCodeName/Url) and
 * `video.claInfo.captionInfos` (languageCode/url). Measured on the search grid,
 * both were present or both absent together — but claInfo is read as a fallback
 * because it is the one the video-detail SSR blob is documented to always carry.
 */
export function ttBestSubtitle(video) {
  const v = video || {};
  const subs = Array.isArray(v.subtitleInfos) ? v.subtitleInfos : [];
  const pick = subs.find((s) => /eng/i.test((s && s.LanguageCodeName) || "")) || subs[0];
  if (pick) {
    const url = pick.Url || (Array.isArray(pick.UrlList) && pick.UrlList[0]) || null;
    if (url)
      return {
        url,
        lang: pick.LanguageCodeName || null,
        format: String(pick.Format || "webvtt").toLowerCase(),
        source: pick.Source || null,
      };
  }
  const caps = Array.isArray(v.claInfo && v.claInfo.captionInfos) ? v.claInfo.captionInfos : [];
  const cap = caps.find((c) => /eng/i.test((c && c.language) || "")) || caps[0];
  if (cap) {
    const url = cap.url || (Array.isArray(cap.urlList) && cap.urlList[0]) || null;
    if (url)
      return {
        url,
        lang: cap.language || null,
        format: String(cap.captionFormat || "webvtt").toLowerCase(),
        source: String(cap.isAutoGen) === "True" ? "ASR" : null,
      };
  }
  return null;
}

/** Hashtags, from `challenges` when present and from `textExtra` otherwise. */
export function ttHashtags(it) {
  const out = [];
  const seen = new Set();
  const push = (t) => {
    const name = String(t || "").trim();
    if (!name || seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    out.push(name);
  };
  if (Array.isArray(it.challenges)) for (const c of it.challenges) push(c && c.title);
  if (Array.isArray(it.textExtra)) for (const t of it.textExtra) push(t && t.hashtagName);
  return out;
}

/**
 * One webapp item struct → the record the panel and the page overlay both read.
 * Every field degrades to null rather than to a wrong value.
 */
export function ttLiteItem(it) {
  if (!it || typeof it !== "object") return null;
  const v = it.video || {};
  const a = it.author || {};
  const s = it.statsV2 || it.stats || {};
  const as = it.authorStatsV2 || it.authorStats || {};
  const m = it.music || {};
  const hd = ttBestBitrate(v);
  const sub = ttBestSubtitle(v);
  const id = String(it.id || v.id || "");
  if (!id) return null;
  return {
    __kind: "video",
    id,
    username: a.uniqueId || null,
    nickname: a.nickname || null,
    author_id: a.id ? String(a.id) : null,
    author_sec_uid: a.secUid || null,
    author_avatar: a.avatarThumb || a.avatarMedium || null,
    author_verified: a.verified === true ? true : a.verified === false ? false : null,
    author_bio: a.signature || null,
    author_private: a.privateAccount === true ? true : a.privateAccount === false ? false : null,
    // Creator size, inline on every list payload. Instagram needs a separate
    // enrichment fetch for the same number; TikTok hands it over for free, which
    // is what makes views/follower cheap here.
    user_follower_count: ttNum(as.followerCount),
    user_following_count: ttNum(as.followingCount),
    user_heart_count: ttNum(as.heartCount != null ? as.heartCount : as.heart),
    user_video_count: ttNum(as.videoCount),
    play_count: ttNum(s.playCount),
    digg_count: ttNum(s.diggCount),
    comment_count: ttNum(s.commentCount),
    share_count: ttNum(s.shareCount),
    collect_count: ttNum(s.collectCount),
    repost_count: ttNum(s.repostCount),
    video: v.playAddr || null,
    // Highest-quality URL for downloads. downloadAddr is missing on roughly half
    // the search results (measured), so the gear ladder leads and playAddr is the
    // floor — it is present on every item seen.
    hd_url: (hd && hd.url) || v.downloadAddr || v.playAddr || null,
    hd_res: hd && hd.width && hd.height ? `${hd.width}x${hd.height}` : null,
    download_url: v.downloadAddr || v.playAddr || null,
    subtitle: sub,
    cover: v.cover || v.originCover || null,
    dynamic_cover: v.dynamicCover || null,
    duration: ttNum(v.duration),
    width: ttNum(v.width),
    height: ttNum(v.height),
    desc: (it.desc || "").slice(0, 500) || null,
    create_time: ttNum(it.createTime),
    music: m.title
      ? {
          title: m.title,
          author: m.authorName || null,
          id: m.id ? String(m.id) : null,
          url: m.playUrl || null,
          original: m.original === true || m.original === "True" || null,
          duration: ttNum(m.duration),
        }
      : null,
    hashtags: ttHashtags(it),
    // Only the video page carries these; a grid record simply has them as null.
    location: it.locationCreated || null,
    topics: Array.isArray(it.diversificationLabels) ? it.diversificationLabels.filter(Boolean) : [],
    suggested_words: Array.isArray(it.suggestedWords) ? it.suggestedWords.filter(Boolean) : [],
    is_ad: it.isAd === true || null,
    is_aigc: it.IsAigc === true || !!it.AIGCDescription || null,
    pinned: !!it.isPinnedItem,
  };
}

/** One creator record, from either creator shape ttUsersIn produces. */
export function ttLiteUser(u) {
  if (!u || typeof u !== "object") return null;
  const st = u.__stats || {};
  const id = String(u.uid || u.id || "");
  const username = u.unique_id || u.uniqueId || null;
  if (!id && !username) return null;
  return {
    __kind: "tt_user",
    author_id: id || null,
    username,
    nickname: u.nickname || null,
    bio: u.signature || null,
    sec_uid: u.sec_uid || u.secUid || null,
    verified: u.verified === true || !!u.custom_verify || null,
    follower_count: ttNum(st.followerCount != null ? st.followerCount : u.follower_count),
    following_count: ttNum(st.followingCount != null ? st.followingCount : u.following_count),
    heart_count: ttNum(st.heartCount != null ? st.heartCount : (st.heart != null ? st.heart : u.total_favorited)),
    video_count: ttNum(st.videoCount != null ? st.videoCount : u.aweme_count),
  };
}

/**
 * Which TikTok surface a record belongs to. Decided WHERE AND WHEN the record is
 * captured, never at relay time — Instagram learned that the hard way: a replay
 * resends everything the capture ever saw, so stamping the live surface relabels
 * another profile's videos as the one you happen to be looking at now.
 */
export function ttSurfaceKey(path, search) {
  const p = path != null ? path : (typeof location !== "undefined" ? location.pathname : "/");
  const q = search != null ? search : (typeof location !== "undefined" ? location.search : "");
  let m;
  if ((m = p.match(/^\/@([^/]+)/))) return "profile:" + decodeURIComponent(m[1]).toLowerCase();
  if ((m = p.match(/^\/tag\/([^/]+)/))) return "tag:" + decodeURIComponent(m[1]).toLowerCase();
  if (p.startsWith("/search")) {
    const k = new URLSearchParams(q || "").get("q");
    return "search:" + (k ? k.toLowerCase() : "");
  }
  if (p.startsWith("/foryou") || p === "/") return "feed";
  if (p.startsWith("/explore")) return "explore";
  return "feed";
}
