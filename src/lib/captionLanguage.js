// The "Auto" transcription language: guess EN or PT from the post's caption before
// Whisper runs, since Transformers.js does not auto-detect Whisper's language.
//
// Only the background imports this, so franc's trigram tables (~100 KB) stay out
// of the panel bundle.
//
// Restricted to eng/por on purpose. Measured on short niche captions, franc over
// its full language set called "Não ignore esse sinal do universo" Italian and "He
// misses you so much" German; restricted to our two it got every one right. The
// only question left is how sure it is: a near-tie (Spanish scores ~0.90 against
// Portuguese) is reported as unknown, and the caller falls back.
import { francAll } from "franc-min";
import { normalizeTranscriptLanguage } from "./transcriptionLanguage.js";

// When Auto cannot tell (no caption, only hashtags, a near-tie).
export const AUTO_FALLBACK_LANGUAGE = "en";
const MIN_CHARS = 12;
const MAX_RUNNER_UP = 0.95; // runner-up score above this = too close to call

/** The words of a caption, without what says nothing about its language. */
export function captionTextForDetection(caption) {
  return String(caption || "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#@][\p{L}\p{N}_.]+/gu, " ") // hashtags are often English on PT posts
    .replace(/[^\p{L}\s'’-]/gu, " ") // emoji, digits, punctuation
    .replace(/\s+/g, " ")
    .trim();
}

/** "en" | "br" | null — null when the caption can't settle it. */
export function detectCaptionLanguage(caption) {
  const text = captionTextForDetection(caption);
  if (text.length < MIN_CHARS) return null;
  const ranked = francAll(text, { only: ["eng", "por"], minLength: MIN_CHARS });
  const [best, second] = ranked;
  if (!best || best[0] === "und") return null;
  if (second && second[1] > MAX_RUNNER_UP) return null;
  return best[0] === "por" ? "br" : best[0] === "eng" ? "en" : null;
}

/**
 * The language a job actually runs in. A fixed pick passes through; "auto" reads
 * the caption. `auto` on the result is filed on the record, so a badge can say the
 * language was guessed rather than chosen.
 */
export function resolveTranscriptLanguage(pick, caption) {
  const lang = normalizeTranscriptLanguage(pick);
  if (lang !== "auto") return { language: lang, auto: false };
  return { language: detectCaptionLanguage(caption) || AUTO_FALLBACK_LANGUAGE, auto: true };
}
