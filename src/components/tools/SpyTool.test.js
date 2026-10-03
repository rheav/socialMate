// @vitest-environment happy-dom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import SpyTool from "./SpyTool.jsx";

vi.mock("@/lib/useSpy", () => ({ useSpy: () => ({
  profiles: [
    { id: "instagram:nasa", platform: "instagram", key: "nasa" },
    { id: "facebook:nasa", platform: "facebook", key: "nasa" },
  ], state: {}, configured: true, ready: true,
}) }));
// The test configuration uses classic JSX; production's React plugin uses the
// automatic runtime. Both render the actual component with the same React API.
beforeAll(() => vi.stubGlobal("React", React));
afterAll(() => vi.unstubAllGlobals());

describe("Spy individual measurement controls", () => {
  it("offers passive profile navigation for Instagram and measurement for Facebook", () => {
    document.body.innerHTML = renderToStaticMarkup(React.createElement(SpyTool));
    const [instagram, facebook] = document.querySelectorAll("li");
    expect(instagram.querySelector('button[title="Medir este perfil agora"]')).toBeNull();
    const link = instagram.querySelector("a");
    expect(link.getAttribute("href")).toBe("https://www.instagram.com/nasa/");
    expect(link.getAttribute("aria-label")).toMatch(/abrir.*medir/i);
    expect(facebook.querySelector('button[title="Medir este perfil agora"]')).not.toBeNull();
  });
});
