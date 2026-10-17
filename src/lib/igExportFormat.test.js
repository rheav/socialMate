import { describe, it, expect } from "vitest";
import { igPkFromCode } from "./shared/igCode.js";
import { commentEvents, postEvent, toIgExportEvents, transcriptEvent } from "./igExportFormat.js";

const AT = 1_760_700_000_000;

const reel = {
  code: "DAbCdEf1234",
  pk: "3456789012345678901",
  username: "criadora.teste",
  userid: "998877",
  caption: "a".repeat(500),
  caption_full: "a".repeat(900),
  like_count: 120,
  comment_count: 14,
  play_count: 5000,
  repost: 2,
  media_type: "video",
  product_type: "clips",
  taken_at: 1760600000,
  thumb: "https://scontent.cdninstagram.com/t.jpg",
  audio_title: "som original",
  coauthors: [{ id: "1", username: "parceira" }],
};

describe("postEvent", () => {
  it("maps a captured reel to the IG backend record, with the full caption", () => {
    const ev = postEvent(reel, AT);
    expect(ev.kind).toBe("post");
    expect(ev.observedAt).toBe(new Date(AT).toISOString());
    expect(ev.record).toMatchObject({
      mediaPk: "3456789012345678901",
      shortcode: "DAbCdEf1234",
      ownerUsername: "criadora.teste",
      ownerPk: "998877",
      productType: "clips",
      mediaType: 2,
      takenAt: 1760600000,
      likes: 120,
      comments: 14,
      views: 5000,
      reposts: 2,
      audioTitle: "som original",
      coauthors: ["parceira"],
    });
    expect(ev.record.caption).toHaveLength(900);
    expect(ev.record.captionTruncated).toBe(false);
  });

  it("marks a caption it only has as a 500-character preview as truncated", () => {
    const { caption_full, ...preview } = reel;
    const ev = postEvent(preview, AT);
    expect(ev.record.caption).toHaveLength(500);
    expect(ev.record.captionTruncated).toBe(true);
  });

  it("caps the caption at 20,000 characters and says so", () => {
    const ev = postEvent({ ...reel, caption_full: "b".repeat(25_000) }, AT);
    expect(ev.record.caption).toHaveLength(20_000);
    expect(ev.record.captionTruncated).toBe(true);
  });

  it("keeps missing metrics missing (null), never zero", () => {
    const ev = postEvent({ ...reel, play_count: null, like_count: undefined }, AT);
    expect(ev.record.views).toBeNull();
    expect(ev.record.likes).toBeNull();
  });

  it("derives the media pk from the shortcode and strips an owner suffix", () => {
    expect(postEvent({ ...reel, pk: "" }, AT).record.mediaPk).toBe(igPkFromCode("DAbCdEf1234"));
    expect(postEvent({ ...reel, pk: "3456789012345678901_998877" }, AT).record.mediaPk).toBe("3456789012345678901");
  });

  it("refuses a record with no author or no identity", () => {
    expect(postEvent({ ...reel, username: null }, AT)).toBeNull();
    expect(postEvent({ ...reel, code: null, pk: "" }, AT)).toBeNull();
    expect(postEvent({ ...reel, username: "../x" }, AT)).toBeNull();
  });

  it("gives the same id to the same content and a new id when it changes", () => {
    const a = postEvent(reel, AT).eventId;
    expect(postEvent(reel, AT + 60_000).eventId).toBe(a);
    expect(postEvent({ ...reel, like_count: 121 }, AT).eventId).not.toBe(a);
    expect(postEvent({ ...reel, caption_full: reel.caption_full + "!" }, AT).eventId).not.toBe(a);
  });
});

const comments = [
  { cid: "9001", post: "DAbCdEf1234", text: "Quero!", digg_count: 3, reply_count: 1, username: "fa1", verified: false, create_time: 1760600100, is_reply: false, parent: null },
  { cid: "9002", post: "DAbCdEf1234", text: "Enviado", digg_count: 0, reply_count: null, username: "criadora.teste", create_time: 1760600200, is_reply: true, parent: "9001" },
];

describe("commentEvents", () => {
  it("attaches comments and replies to the post by its media pk and owner", () => {
    const evs = commentEvents(comments, reel, AT);
    expect(evs.map((e) => e.record)).toEqual([
      expect.objectContaining({ commentPk: "9001", mediaPk: "3456789012345678901", ownerUsername: "criadora.teste", parentPk: null, text: "Quero!", likeCount: 3, childCount: 1, authorUsername: "fa1", createdAt: 1760600100 }),
      expect.objectContaining({ commentPk: "9002", parentPk: "9001", isOwnerReply: true }),
    ]);
  });

  it("drops comments of another post", () => {
    const other = { ...comments[0], cid: "9003", post: "ZZZZZZZ" };
    expect(commentEvents([other], reel, AT)).toEqual([]);
  });

  it("an edited like count is a new event", () => {
    const [a] = commentEvents([comments[0]], reel, AT);
    const [b] = commentEvents([{ ...comments[0], digg_count: 9 }], reel, AT);
    expect(a.eventId).not.toBe(b.eventId);
  });
});

describe("transcriptEvent", () => {
  const tx = {
    videoId: "DAbCdEf1234",
    platform: "instagram",
    status: "done",
    source: "whisper",
    language: "pt",
    text: "Comente quero",
    chunks: [{ timestamp: [0, 1.5], text: "Comente quero" }],
    author: { name: "Criadora", url: "/criadora.teste/" },
    updatedAt: AT,
  };

  it("exports only finished Instagram transcripts, owner from the author link", () => {
    const ev = transcriptEvent(tx);
    expect(ev.record).toMatchObject({
      mediaPk: igPkFromCode("DAbCdEf1234"),
      shortcode: "DAbCdEf1234",
      ownerUsername: "criadora.teste",
      status: "done",
      source: "socialmate-whisper",
      language: "pt",
      text: "Comente quero",
    });
    expect(transcriptEvent({ ...tx, status: "error" })).toBeNull();
    expect(transcriptEvent({ ...tx, platform: "facebook" })).toBeNull();
    expect(transcriptEvent({ ...tx, author: { name: "Criadora" } })).toBeNull();
  });

  it("caption-sourced text keeps its provenance", () => {
    expect(transcriptEvent({ ...tx, source: "caption" }).record.source).toBe("socialmate-caption");
  });
});

describe("toIgExportEvents", () => {
  it("joins posts and their comments, resolving each comment's post", () => {
    const evs = toIgExportEvents({ posts: [reel], comments }, { observedAt: AT, postsByCode: { [reel.code]: reel } });
    expect(evs.map((e) => e.kind)).toEqual(["post", "comment", "comment"]);
  });

  it("holds comments whose post is unknown instead of guessing an owner", () => {
    const { events, unresolved } = toIgExportEvents.withUnresolved({ posts: [], comments }, { observedAt: AT, postsByCode: {} });
    expect(events).toEqual([]);
    expect(unresolved.map((c) => c.cid)).toEqual(["9001", "9002"]);
  });
});
