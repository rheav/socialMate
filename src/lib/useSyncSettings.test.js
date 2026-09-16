import { describe, it, expect } from "vitest";
import { originPattern } from "./useSyncSettings.js";

describe("originPattern", () => {
  it("reduces a hub URL to the match pattern a permission request needs", () => {
    expect(originPattern("https://socialmate.rheav.dev")).toBe("https://socialmate.rheav.dev/*");
    expect(originPattern("https://socialmate.rheav.dev/api/sync")).toBe("https://socialmate.rheav.dev/*");
    expect(originPattern("http://localhost:3111")).toBe("http://localhost:3111/*");
  });

  it("is null for something that is not a URL, so nothing is requested", () => {
    expect(originPattern("socialmate.rheav.dev")).toBeNull();
    expect(originPattern("")).toBeNull();
  });
});
