// Key and default come from the page helper so the panel and the content scripts
// cannot disagree on them (they used to be two hand-kept literals).
import { TX_LANG_DEFAULT, TX_LANG_KEY } from "./shared/txLang.js";

export const TRANSCRIPT_LANGUAGE_KEY = TX_LANG_KEY;
export const DEFAULT_TRANSCRIPT_LANGUAGE = TX_LANG_DEFAULT;

const LABELS = {
  br: "Português",
  en: "English",
  auto: "Automático",
};

const SHORT = {
  br: "BR",
  en: "EN",
  auto: "AUTO",
};

// A PICK: br, en or auto. What a job runs in is always br or en — "auto" is
// resolved from the caption first (lib/captionLanguage.js, background only).
export function normalizeTranscriptLanguage(value) {
  const lang = String(value || "").trim().toLowerCase();
  if (lang === "en") return "en";
  if (lang === "br" || lang === "pt") return "br";
  if (lang === "auto") return "auto";
  return DEFAULT_TRANSCRIPT_LANGUAGE;
}

// Whisper's token. Anything but Portuguese — including an "auto" that reached
// here unresolved — decodes as English, the default.
export function whisperTranscriptLanguage(value) {
  return normalizeTranscriptLanguage(value) === "br" ? "pt" : "en";
}

export function transcriptLanguageLabel(value) {
  return LABELS[normalizeTranscriptLanguage(value)];
}

export function transcriptLanguageShort(value) {
  return SHORT[normalizeTranscriptLanguage(value)];
}

// What a STORED record was transcribed in — null when it never recorded one.
//
// The functions above answer "which language should this job use?", so an absent
// value there rightly means the default. A record is the opposite question:
// every transcript made before 0.72 carries no language at all, and those ran with
// the language OMITTED, which Transformers.js decodes as English. Defaulting the
// Library badge to BR therefore stamped "BR" on English transcripts — the reason a
// correct EN run still looked like it had come out in Portuguese.
export function recordedTranscriptLanguageShort(value) {
  const lang = String(value || "").trim().toLowerCase();
  if (lang === "en") return SHORT.en;
  if (lang === "br" || lang === "pt") return SHORT.br;
  return null;
}

// The language of a CAPTION track we transcribed from, as our br/en value — or
// null when it is neither (or absent).
//
// A caption-sourced transcript is TikTok's own subtitle file, named by
// `subtitleInfos[].LanguageCodeName` ("eng-US", "por-BR", "ind-ID"). Whisper never
// ran, so the user's BR/EN pick says nothing about that text: stamping the pick on
// the record is the same lie the Library badge used to tell. null means "we cannot
// label this one", which the badge renders as no badge at all.
export function captionTrackLanguage(code) {
  const c = String(code || "").trim().toLowerCase();
  if (/^(en|eng|english)\b/.test(c) || /^(en|eng)[-_]/.test(c)) return "en";
  if (/^(pt|por|portug)/.test(c)) return "br";
  return null;
}

export async function readStoredTranscriptLanguage(storage = globalThis.chrome?.storage?.local) {
  try {
    const r = await storage?.get?.(TRANSCRIPT_LANGUAGE_KEY);
    return normalizeTranscriptLanguage(r?.[TRANSCRIPT_LANGUAGE_KEY]);
  } catch {
    return DEFAULT_TRANSCRIPT_LANGUAGE;
  }
}

export async function writeStoredTranscriptLanguage(value, storage = globalThis.chrome?.storage?.local) {
  const language = normalizeTranscriptLanguage(value);
  try {
    await storage?.set?.({ [TRANSCRIPT_LANGUAGE_KEY]: language });
  } catch {
    /* caller can still use the normalized value for this job */
  }
  return language;
}

// The default only fills an EMPTY key, and any install where someone ever tapped
// BR/EN already has one — so moving the default to English changed nothing for
// them. This applies the new default once, over whatever was stored, and records
// which default it applied so it never runs again; picking BR afterwards sticks.
export const TRANSCRIPT_LANGUAGE_DEFAULT_APPLIED_KEY = "fbw_transcript_language_default_applied";

export async function applyTranscriptLanguageDefaultOnce(storage = globalThis.chrome?.storage?.local) {
  try {
    const r = await storage?.get?.(TRANSCRIPT_LANGUAGE_DEFAULT_APPLIED_KEY);
    if (r?.[TRANSCRIPT_LANGUAGE_DEFAULT_APPLIED_KEY] === DEFAULT_TRANSCRIPT_LANGUAGE) return false;
    await storage?.set?.({
      [TRANSCRIPT_LANGUAGE_KEY]: DEFAULT_TRANSCRIPT_LANGUAGE,
      [TRANSCRIPT_LANGUAGE_DEFAULT_APPLIED_KEY]: DEFAULT_TRANSCRIPT_LANGUAGE,
    });
    return true;
  } catch {
    return false; // storage gone — the next install/update event tries again
  }
}
