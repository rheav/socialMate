import { describe, it, expect } from "vitest";
import { fbActionName } from "./fbLabels.js";

describe("fbActionName", () => {
  it("drops the count FB appends to reel rail labels", () => {
    expect(fbActionName("Like, 6.8K reactions")).toBe("like");
    expect(fbActionName("Remove Like, 6.8K reactions")).toBe("remove like");
    expect(fbActionName("Comment, 431 comments")).toBe("comment");
  });
  it("leaves bare labels as they were", () => {
    expect(fbActionName("Next Card")).toBe("next card");
    expect(fbActionName(" Change Like reaction ")).toBe("change like reaction");
  });
  it("does not turn a reaction-count tooltip into an action", () => {
    expect(fbActionName("Curtir: 3,5 mil pessoas")).not.toBe("curtir");
    expect(fbActionName("Like: 12 people")).not.toBe("like");
  });
  it("treats a missing label as empty", () => {
    expect(fbActionName(null)).toBe("");
  });
});
