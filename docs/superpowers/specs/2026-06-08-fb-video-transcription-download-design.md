# FB Video Transcription + Download — Design Spec

**Date:** 2026-06-08
**Project:** fb-warmer (socialWarmer) MV3 extension
**Status:** Draft for review

## 1. Goal

Add two capabilities to the fb-warmer extension, scoped to **Facebook hashtag/search feed** videos (`facebook.com/hashtag/<tag>`):

1. **Transcribe** a feed video locally (Whisper, no server) and easily extract the transcript.
2. **Download** the feed video (muxed audio+video file).

Trigger from **both**: a per-video button injected on the page, and results collected in the existing side panel (copy / export / download).

## 2. Key constraint (validated 2026-06-08)

Facebook parses **both** the feed GraphQL response **and** the video DASH segments **off the main thread** (a dedicated Web Worker; segments arrive via `srcObject` MediaSource, `src` empty, `readyState 4` with all main-thread `fetch`/`XHR`/`PerformanceObserver` probes at zero). Therefore a content script / userscript **cannot** observe the feed data or the video/audio media URLs.

**Unlock:** fb-warmer is a real MV3 extension. Its background service worker can use **`chrome.webRequest`** (observational, allowed in MV3 with host permissions), which sees **all** tab requests including worker-issued ones. This is how we capture the `*.fbcdn.net/*.mp4` track URLs. (A userscript cannot — confirming why the earlier userscript route was abandoned for FB.)

FB Watch/feed videos are **DASH split**: a video-only `.mp4` track (e.g. VP9) and a separate audio-only `.mp4` track (AAC), both signed (`oh`/`oe` expiry, no cookie needed), fetched in byte ranges. Stripping `bytestart`/`byteend` yields the full file (validated via curl: video 264 KB, audio 63 KB; `ffmpeg -c copy` mux → playable 7.7 s vp9+aac). The `efg` query param base64-decodes to `{video_id, vencode_tag, ...}` — `vencode_tag` containing `audio` marks the audio track.

## 3. Architecture

```
chrome.webRequest (background)
   onBeforeRequest: url matches *.fbcdn.net/*.mp4
   → parse efg → {video_id, isAudio}
   → registry[video_id] = { videoUrl, audioUrl, lastSeen }   (byte range stripped)

[user scrolls feed → videos autoplay → segments requested → registry fills]

content script (per feed <video>):
   inject "Transcribe" + "Download" buttons
   on click → focus/force-play this video → message background:
       { type: 'FBW_TRANSCRIBE' | 'FBW_DOWNLOAD', hint: <active video_id or "latest"> }

background:
   resolve active video_id (temporal/focus: newest distinct track since click)
   ensure offscreen document → route job

offscreen document (offscreen.html + offscreen.js):
   Transcribe: fetch(audioUrl) → decodeAudioData → 16k mono PCM → Whisper (Transformers.js, bundled whisper-base q8) → { text, chunks }
   Download:   fetch(videoUrl)+fetch(audioUrl) → ffmpeg.wasm -c copy mux → bytes

results:
   → IndexedDB cache (key: video_id)
   → side panel "Transcripts" view (transcript: copy, export .txt/.srt; download button)
   → on-page popover (transcript + copy)
```

## 4. Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `src/background.js` (extend) | webRequest capture → track registry; offscreen lifecycle (create/idle-close, mutex); message routing content↔offscreen↔panel | `chrome.webRequest`, `chrome.offscreen` |
| `src/lib/fbcdn.js` (new) | parse `efg`→`{video_id,isAudio}`; strip byte range; pick best video track | — |
| `src/offscreen/offscreen.html` + `offscreen.js` (new) | Whisper engine (Transformers.js, local model) + ffmpeg.wasm mux; fetch+decode audio; progress events | `@huggingface/transformers`, `@ffmpeg/ffmpeg` |
| `src/content/transcription/inject.js` (new) | find feed `<video>` els; inject buttons; force-play for attribution; progress UI + result popover | DOM |
| `src/lib/transcriptionDB.js` (new, port) | IndexedDB cache of `{video_id, text, chunks, status, tracks}` | IndexedDB |
| Side panel `Transcripts` view (new component) | list captured videos; transcript copy/export (.txt/.srt); download | React/shadcn |
| `public/models/Xenova/whisper-base` | bundled q8 ONNX model (~76 MB) | — |
| `public/assets/*` | onnx-runtime wasm | — |
| `public/ffmpeg/*` | ffmpeg-core wasm | — |

**Reuse from sibling `unfunnelizer-extension`** (near-verbatim): `background/offscreen.js` Whisper engine + decode opts (chunk_length_s 30, stride 5, return_timestamps, repetition_penalty 1.1, trigram anti-hallucination filter), chunked-audio bridge pattern, `transcriptionDB.js`, model bundling + manifest entries. **Reuse ffmpeg** from sibling `fb-mass-downloader`/`bulk-download-videos-fb` already in this repo.

## 5. Data flow detail

- **Capture:** `onBeforeRequest` filter `*://*.fbcdn.net/*`; keep only `.mp4` with `bytestart` (DASH segment). Decode `efg`; group by `video_id`; first audio-tagged URL → `audioUrl`, highest-bitrate non-audio → `videoUrl`; store stripped (no byte range) URL + `lastSeen` timestamp.
- **Attribution (no DOM video_id):** on button click, content script scrolls the tile into view + ensures it is the playing element; background picks the `video_id` whose `lastSeen` advanced in the ~3 s window after the click (the focused video re-requests). Fallback: most-recently-seen `video_id`. If none captured → UI prompts "let the video play once, then retry."
- **Transcribe:** offscreen `fetch(audioUrl)` → `AudioContext.decodeAudioData` → `OfflineAudioContext` resample 16 kHz mono → `Float32Array` → Whisper → `{text, chunks}`.
- **Download:** offscreen fetch both tracks → ffmpeg.wasm `-i video -i audio -c copy out.mkv` → return bytes → `chrome.downloads` / blob save.
- **Export:** `.txt` (joined text) + `.srt` (from `chunks[].timestamp`).

## 6. Error handling

Port unfunnelizer's `getUserFriendlyError` mapping. Guards: video ≤ ~300 MB, audio ≤ ~60 min. Specific cases: track-not-captured ("play the video first"); expired signed URL (`oe` past) → re-trigger play to re-capture; no audio track found → disable transcribe with reason; offscreen/model load failure → retry once.

## 7. Build-time risks (validate FIRST, before feature work)

1. **webRequest sees worker requests** — write a smoke test: load the hashtag feed with the extension, scroll, assert background captured ≥1 fbcdn `.mp4` URL with a parseable `video_id`. (Expected to pass per MV3 docs; if it fails, the whole approach changes — so it is gate #1.)
2. **In-browser CORS fetch of fbcdn track** — offscreen `fetch(audioUrl).arrayBuffer()` may be CORS-blocked. Test early. Fallback: fetch in the **page/content context** (origin facebook.com) and transfer the blob to offscreen (unfunnelizer does fetch+decode in MAIN world for this reason).
3. **VP9 → .mp4** — muxing VP9+AAC targets `.mkv`/`.webm`. If `.mp4` is required, select FB's H.264 rendition when present, else accept `.mkv`.

## 8. Testing

- **Gate smoke tests** (risks 1 & 2) before building UI.
- **Unit:** `fbcdn.js` — efg decode → video_id/isAudio; byte-range strip; track selection. SRT generation from chunks.
- **Engine:** Whisper on a known short clip → expected text; ffmpeg mux → probe streams.
- **Manual/E2E:** on live `facebook.com/hashtag/auralytrend` — scroll, transcribe a video, verify transcript + copy/export; download a video, verify plays with audio.

## 9. Out of scope (YAGNI)

Server transcription, IG/TikTok (FB only for now), bulk/batch transcription, reels/Watch-page scope (hashtag feed only), translation, speaker diarization.

## 10. Open decisions (confirm in review)

- Model: **whisper-base q8** (~76 MB, multilingual) vs whisper-tiny (~40 MB, faster, less accurate). Default: base.
- Bundle size: 76 MB model ships in the unpacked extension (fine for local/dev; Web Store has a 100–200 MB unpacked cap — within limits but heavy). Acceptable?
- Download container: `.mkv` default (VP9) vs always re-mux/encode to `.mp4`. Default: `.mkv`, no re-encode.
