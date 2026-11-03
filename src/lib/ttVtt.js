// TikTok's auto captions (WebVTT, `subtitleInfos[].Url`) → the transcript the Hub's
// analysis reads: the text and timed chunks, as the extension's Whisper job returns
// them. Pure.

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
const toSeconds = (t) => {
  const m = TIME.exec(t);
  if (!m) return null;
  return (Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000;
};

/** → { text, chunks: [{ timestamp: [start, end], text }] }; empty text when the file holds no cue. */
export function parseWebVtt(vtt) {
  const chunks = [];
  if (typeof vtt !== "string") return { text: "", chunks };
  for (const block of vtt.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n").filter(Boolean);
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const [a, b] = lines[at].split("-->");
    const start = toSeconds(a);
    const end = toSeconds(b);
    const text = lines.slice(at + 1).join(" ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (start == null || !text) continue;
    chunks.push({ timestamp: [start, end ?? start], text });
  }
  return { text: chunks.map((c) => c.text).join(" ").trim(), chunks };
}
