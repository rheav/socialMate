import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSCRIPT_LANGUAGE,
  TRANSCRIPT_LANGUAGE_KEY,
  normalizeTranscriptLanguage,
  readStoredTranscriptLanguage,
  whisperTranscriptLanguage,
  writeStoredTranscriptLanguage,
  transcriptLanguageLabel,
  transcriptLanguageShort,
  recordedTranscriptLanguageShort,
  captionTrackLanguage,
} from "./transcriptionLanguage.js";

describe("transcription language", () => {
  it("defaults transcription to Portuguese", () => {
    expect(DEFAULT_TRANSCRIPT_LANGUAGE).toBe("br");
    expect(TRANSCRIPT_LANGUAGE_KEY).toBe("fbw_transcript_language");
    expect(normalizeTranscriptLanguage()).toBe("br");
    expect(normalizeTranscriptLanguage(null)).toBe("br");
    expect(normalizeTranscriptLanguage("")).toBe("br");
    expect(normalizeTranscriptLanguage("es")).toBe("br");
  });

  it("accepts only Portuguese and English language codes", () => {
    expect(normalizeTranscriptLanguage("br")).toBe("br");
    expect(normalizeTranscriptLanguage("pt")).toBe("br");
    expect(normalizeTranscriptLanguage("en")).toBe("en");
    expect(normalizeTranscriptLanguage("BR")).toBe("br");
    expect(normalizeTranscriptLanguage("PT")).toBe("br");
    expect(normalizeTranscriptLanguage("EN")).toBe("en");
  });

  it("maps the product value br to Whisper's Portuguese token", () => {
    expect(whisperTranscriptLanguage("br")).toBe("pt");
    expect(whisperTranscriptLanguage("pt")).toBe("pt");
    expect(whisperTranscriptLanguage("en")).toBe("en");
    expect(whisperTranscriptLanguage("bad")).toBe("pt");
  });

  it("provides compact labels for page buttons and transcript records", () => {
    expect(transcriptLanguageLabel("br")).toBe("Português");
    expect(transcriptLanguageLabel("pt")).toBe("Português");
    expect(transcriptLanguageLabel("en")).toBe("English");
    expect(transcriptLanguageLabel("bad")).toBe("Português");
    expect(transcriptLanguageShort("br")).toBe("BR");
    expect(transcriptLanguageShort("pt")).toBe("BR");
    expect(transcriptLanguageShort("en")).toBe("EN");
    expect(transcriptLanguageShort("bad")).toBe("BR");
  });

  // A record only knows its language if the job that wrote it recorded one. Every
  // transcript made before 0.72 carries none — and those ran with the language
  // omitted, which Transformers.js decodes as ENGLISH. Falling back to the product
  // default there labelled English transcripts "BR" in the Library.
  it("reports no language for records that never stored one", () => {
    expect(recordedTranscriptLanguageShort("br")).toBe("BR");
    expect(recordedTranscriptLanguageShort("pt")).toBe("BR");
    expect(recordedTranscriptLanguageShort("en")).toBe("EN");
    expect(recordedTranscriptLanguageShort(undefined)).toBe(null);
    expect(recordedTranscriptLanguageShort(null)).toBe(null);
    expect(recordedTranscriptLanguageShort("")).toBe(null);
    expect(recordedTranscriptLanguageShort("es")).toBe(null);
  });

  // A caption-sourced transcript is TikTok's own subtitle track. Its language is
  // whatever TikTok wrote it in (subtitleInfos[].LanguageCodeName) — the user's
  // BR/EN pick never touched it, and stamping the pick on the record is the same
  // lie the Library badge used to tell.
  it("reads a caption track's own language, and admits when it doesn't know it", () => {
    expect(captionTrackLanguage("eng-US")).toBe("en");
    expect(captionTrackLanguage("eng")).toBe("en");
    expect(captionTrackLanguage("en")).toBe("en");
    expect(captionTrackLanguage("en-US")).toBe("en");
    expect(captionTrackLanguage("EN_GB")).toBe("en");
    expect(captionTrackLanguage("por-BR")).toBe("br");
    expect(captionTrackLanguage("por")).toBe("br");
    expect(captionTrackLanguage("pt-BR")).toBe("br");
    expect(captionTrackLanguage("pt")).toBe("br");
    // Languages the Library cannot label, and no track at all.
    expect(captionTrackLanguage("ind-ID")).toBe(null);
    expect(captionTrackLanguage("spa")).toBe(null);
    expect(captionTrackLanguage("")).toBe(null);
    expect(captionTrackLanguage(null)).toBe(null);
    expect(captionTrackLanguage(undefined)).toBe(null);
    // "english" must not be read as the ISO code of some other language.
    expect(captionTrackLanguage("english")).toBe("en");
    expect(captionTrackLanguage("português")).toBe("br");
  });

  it("reads and writes the normalized language through chrome-style storage", async () => {
    const data = {};
    const storage = {
      get: async (key) => ({ [key]: data[key] }),
      set: async (patch) => Object.assign(data, patch),
    };

    expect(await readStoredTranscriptLanguage(storage)).toBe("br");
    expect(await writeStoredTranscriptLanguage("en", storage)).toBe("en");
    expect(data.fbw_transcript_language).toBe("en");
    expect(await readStoredTranscriptLanguage(storage)).toBe("en");
    expect(await writeStoredTranscriptLanguage("es", storage)).toBe("br");
    expect(data.fbw_transcript_language).toBe("br");
    data.fbw_transcript_language = "pt";
    expect(await readStoredTranscriptLanguage(storage)).toBe("br");
  });
});
