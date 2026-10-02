import { buildSavedEntry } from "./savedEntry.js";
import { fbCaptionFor, fbMediaUrl } from "./fbVideoMedia.js";
import { normTxLang } from "./txLang.js";
import { fullResThumb } from "./fbReelThumb.js";

export function fbReelEntry(rec) {
  if (!rec?.id) return null;
  return { ...buildSavedEntry({ id: rec.id, platform: 'facebook', mediaType: 'video',
    thumb: rec.thumb, caption: rec.caption, authorName: rec.authorName, authorUrl: rec.authorUrl,
    counts: { view: rec.views, like: rec.likes, comment: rec.comments, share: rec.shares } }),
    videoKind: 'reel', takenAt: rec.taken_at ?? null, durationS: rec.duration ?? null, followers: rec.followers ?? null };
}

export function fbReelJob(rec, action, language = 'en') {
  if (!/^\d{6,}$/.test(rec?.id || '')) throw new Error('Reel indisponível. Recarregue a página.');
  const name = (rec.authorName || 'facebook').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0,60) || 'facebook';
  const base = `${name}-fb-${rec.id}`;
  if (action === 'download' || action === 'thumb') {
    const url = fbMediaUrl(action === 'thumb' ? fullResThumb(rec.thumb) : rec.progressive);
    if (!url) throw new Error('Mídia ainda indisponível. Abra o reel e tente novamente.');
    return { type: 'FBW_DL_MEDIA', platform: 'facebook', kind: action === 'thumb' ? 'image' : 'video',
      ...(action === 'thumb' ? { folder: 'thumb' } : {}), url, filename: `${base}${action === 'thumb' ? '-thumb.jpg' : '.mp4'}` };
  }
  const mediaUrl = fbMediaUrl(rec.audio) || fbMediaUrl(rec.progressive);
  if (!mediaUrl) throw new Error('Áudio ainda indisponível. Abra o reel e tente novamente.');
  if (action === 'voice') return { type: 'FBW_EXTRACT_VOICE', videoId: rec.id, mediaUrl, jobId: crypto.randomUUID(), filename: `${base}-voz.mp3` };
  if (action !== 'transcribe') throw new Error('Ação desconhecida');
  const lang = normTxLang(language);
  const caption = fbCaptionFor(rec, lang);
  return { ...fbReelEntry(rec), type: 'FBW_TRANSCRIBE', mediaUrl, idConfident: true, language: lang,
    ...(caption ? { captionUrl: caption.url, captionLang: caption.lang, captionFormat: 'srt' } : {}) };
}
