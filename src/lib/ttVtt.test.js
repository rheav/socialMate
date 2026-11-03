import { describe, expect, it } from "vitest";
import { parseWebVtt } from "./ttVtt.js";

describe("parseWebVtt", () => {
  it("reads TikTok's captions into text and timed chunks", () => {
    const vtt = "WEBVTT\n\n1\n00:00:00.120 --> 00:00:02.480\nHere are a few of the most\n\n2\n00:00:02.480 --> 00:00:05.000\n<i>important</i> things I learned\n\n00:01:05.5 --> 00:01:07.250\nabout manifestation";
    expect(parseWebVtt(vtt)).toEqual({
      text: "Here are a few of the most important things I learned about manifestation",
      chunks: [
        { timestamp: [0.12, 2.48], text: "Here are a few of the most" },
        { timestamp: [2.48, 5], text: "important things I learned" },
        { timestamp: [65.5, 67.25], text: "about manifestation" },
      ],
    });
  });

  it("answers empty for a file without cues", () => {
    expect(parseWebVtt("WEBVTT\n\nNOTE nothing here")).toEqual({ text: "", chunks: [] });
    expect(parseWebVtt(null)).toEqual({ text: "", chunks: [] });
  });
});
