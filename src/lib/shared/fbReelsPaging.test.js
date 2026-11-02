import { describe, expect, it } from "vitest";
import { reelsPageBody, reelsPageResult, reelsStart } from "./fbReelsPaging.js";

// Shapes measured on a live reels tab and its pagination query (2026-10-03).
const node = (id, created, views = "1.2K") => ({ profile_reel_node: { node: {
  __typename: "Story", creation_time: created, actors: [{ id: "615" }],
  attachments: [{ media: { __typename: "Video", id, created_time: created, length_in_second: 30, play_count_reduced: views } }],
} } });
const collection = (edges, hasNext, cursor = "NEXT") => ({
  id: "COLLECTION", aggregated_fb_shorts: { edges, page_info: { end_cursor: cursor, has_next_page: hasNext } },
});

describe("Facebook reels paging", () => {
  it("starts from the server-rendered first page", () => {
    const ssr = [{ unrelated: true }, { require: [[{ __bbox: { result: { data: { node: { all_collections: { nodes: [{ style_renderer: {
      collection: collection([node("2209826979599001", 1791000000), node("2209826979599002", 1790990000, "9.1K")], true, "C1"),
    } }] } } } } } }]] }];
    expect(reelsStart(ssr)).toEqual({
      collectionId: "COLLECTION", cursor: "C1", hasNext: true,
      rows: [
        { id: "2209826979599001", createdAt: 1791000000, duration: null, views: 1200, likes: null, comments: null, shares: null, caption: null, aiLabel: null, audio: null, audioOriginal: null, thumbUrl: null },
        { id: "2209826979599002", createdAt: 1790990000, duration: null, views: 9100, likes: null, comments: null, shares: null, caption: null, aiLabel: null, audio: null, audioOriginal: null, thumbUrl: null },
      ],
    });
    expect(reelsStart([{ nothing: 1 }])).toEqual({ collectionId: null, cursor: null, hasNext: false, rows: [] });
  });

  it("joins each first-page reel's numbers, AI mark and audio from the page's other blocks, and nothing else", () => {
    // Measured 2026-11-02: likes, comments, shares and the AI mark come in blocks of their own.
    const list = { require: [[{ __bbox: { result: { data: { node: { all_collections: { nodes: [{ style_renderer: {
      collection: collection([node("2209826979599001", 1791000000, "1.3M")], false),
    } }] } } } } } }]] };
    list.require[0][0].__bbox.result.data.node.all_collections.nodes[0].style_renderer.collection.aggregated_fb_shorts.edges[0]
      .profile_reel_node.node.attachments[0].media.is_original_audio_on_facebook = true;
    const detail = (id, label) => ({ require: [[{ __bbox: { result: { data: {
      __typename: "Story", creation_time: 1791000000, actors: [{ id: "615" }], message: { text: "Comment 777" },
      ai_generated_detected_info: { gen_ai_transparency_type: label },
      attachments: [{ media: { __typename: "Video", id } }],
    } } } }]] });
    const stats = (id) => ({ url: `https://www.facebook.com/reel/${id}/`, feedback: { total_comment_count: 4269, share_count_reduced: "2.4K" },
      fb_reel_react_button: { story: { feedback: { likers: { count: 37469 } } } } });
    const out = reelsStart([list, detail("2209826979599001", "PAIGM_CLASSIFIER"), { x: stats("2209826979599001") },
      detail("9999999999999", "NONE")]); // a reel outside the profile's list stays out
    expect(out.rows).toEqual([{ id: "2209826979599001", createdAt: 1791000000, duration: null, views: 1_300_000,
      likes: 37469, comments: 4269, shares: 2400, caption: "Comment 777", aiLabel: "PAIGM_CLASSIFIER", audio: null, audioOriginal: true,
      thumbUrl: null }]);
  });

  it("builds the same request Facebook makes, with the provided variables", () => {
    const body = new URLSearchParams(reelsPageBody({
      userId: "100", dtsg: "D", lsd: "L", docId: "288", name: "ProfileCometAppCollectionReelsRendererPaginationQuery",
      provided: { __relay_internal__pv__X: true }, cursor: "C1", collectionId: "COLLECTION",
    }));
    expect(Object.fromEntries(body)).toMatchObject({
      av: "100", __user: "100", __a: "1", fb_dtsg: "D", lsd: "L", doc_id: "288",
      fb_api_caller_class: "RelayModern", fb_api_req_friendly_name: "ProfileCometAppCollectionReelsRendererPaginationQuery",
      server_timestamps: "true",
    });
    expect(JSON.parse(body.get("variables"))).toEqual({
      count: 10, cursor: "C1", renderLocation: null, scale: 2, useDefaultActor: false, id: "COLLECTION", __relay_internal__pv__X: true,
    });
  });

  it("reads a streamed page, its paging state and GraphQL errors", () => {
    const text = [
      JSON.stringify({ data: { node: collection([node("2209826979599003", 1790980000)], false, null) } }),
      JSON.stringify({ label: "deferred", path: ["node", "aggregated_fb_shorts", "edges", 0], data: {} }),
    ].join("\n");
    expect(reelsPageResult(text)).toEqual({
      rows: [{ id: "2209826979599003", createdAt: 1790980000, duration: null, views: 1200, likes: null, comments: null, shares: null,
        caption: null, aiLabel: null, audio: null, audioOriginal: null, thumbUrl: null }],
      hasNext: false, cursor: null, error: null,
    });
    expect(reelsPageResult(JSON.stringify({ errors: [{ message: "A server error missing_required_variable_value occured." }] })))
      .toMatchObject({ rows: [], error: "graphql" });
    expect(reelsPageResult("for (;;);{\"error\":1357001}")).toMatchObject({ error: "login_required" });
  });
});
