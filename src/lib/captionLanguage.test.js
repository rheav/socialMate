import { describe, expect, it } from "vitest";
import {
  AUTO_FALLBACK_LANGUAGE,
  captionTextForDetection,
  detectCaptionLanguage,
  resolveTranscriptLanguage,
} from "./captionLanguage.js";

describe("caption language (Auto)", () => {
  // Real-shaped niche captions. franc over its whole language set called the
  // Portuguese one Italian and "He misses you so much" German.
  it("tells English from Portuguese on short captions", () => {
    expect(detectCaptionLanguage("Your person is thinking about you right now")).toBe("en");
    expect(detectCaptionLanguage("He misses you so much")).toBe("en");
    expect(detectCaptionLanguage("Watch till the end")).toBe("en");
    expect(detectCaptionLanguage("Não ignore esse sinal do universo")).toBe("br");
    expect(detectCaptionLanguage("o que ele sente por você")).toBe("br");
    expect(detectCaptionLanguage("Mensagem do seu anjo da guarda para hoje")).toBe("br");
  });

  it("ignores hashtags, mentions, links and emoji", () => {
    expect(captionTextForDetection("Leitura de hoje ✨🔮 #tarot #love @maria https://x.co/a 2024")).toBe("Leitura de hoje");
    expect(detectCaptionLanguage("Mensagem do seu anjo 🔮 #tarotreading #lovereading #fyp")).toBe("br");
  });

  it("admits when it cannot tell", () => {
    expect(detectCaptionLanguage("")).toBe(null);
    expect(detectCaptionLanguage(null)).toBe(null);
    expect(detectCaptionLanguage("#tarot #love #fyp")).toBe(null); // only hashtags
    expect(detectCaptionLanguage("Obrigado")).toBe(null); // too short
  });

  it("passes a fixed pick through and resolves auto from the caption", () => {
    expect(resolveTranscriptLanguage("br", "Your person is thinking about you")).toEqual({ language: "br", auto: false });
    expect(resolveTranscriptLanguage("en", "Mensagem do seu anjo da guarda")).toEqual({ language: "en", auto: false });
    expect(resolveTranscriptLanguage("auto", "Mensagem do seu anjo da guarda para hoje")).toEqual({ language: "br", auto: true });
    expect(resolveTranscriptLanguage("auto", "Your person is thinking about you")).toEqual({ language: "en", auto: true });
    expect(resolveTranscriptLanguage("auto", "#fyp")).toEqual({ language: AUTO_FALLBACK_LANGUAGE, auto: true });
    expect(resolveTranscriptLanguage("auto", undefined)).toEqual({ language: AUTO_FALLBACK_LANGUAGE, auto: true });
  });
});
