// @vitest-environment happy-dom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import SpyTool from "./SpyTool.jsx";

const spy = vi.hoisted(() => ({ current: null }));
vi.mock("@/lib/useSpy", () => ({ useSpy: () => spy.current }));
const base = () => ({
  profiles: [
    { id: "instagram:nasa", platform: "instagram", key: "nasa" },
    { id: "facebook:nasa", platform: "facebook", key: "nasa" },
  ], state: {}, queue: {}, activity: [], hub: null, nextTickAt: null, configured: true, ready: true,
});
// The test configuration uses classic JSX; production's React plugin uses the
// automatic runtime. Both render the actual component with the same React API.
beforeAll(() => vi.stubGlobal("React", React));
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => { spy.current = base(); });
const render = () => { document.body.innerHTML = renderToStaticMarkup(React.createElement(SpyTool)); };
const section = (label) => document.querySelector(`section[aria-label="${label}"]`);

describe("Spy individual measurement controls", () => {
  it("offers passive profile navigation for Instagram and measurement for Facebook", () => {
    render();
    const [instagram, facebook] = section("Perfis salvos").querySelectorAll("li");
    expect(instagram.querySelector('button[title="Medir este perfil agora"]')).toBeNull();
    const link = instagram.querySelector("a");
    expect(link.getAttribute("href")).toBe("https://www.instagram.com/nasa/");
    expect(link.getAttribute("aria-label")).toMatch(/abrir.*medir/i);
    expect(facebook.querySelector('button[title="Medir este perfil agora"]')).not.toBeNull();
  });
});

describe("Spy measurement messages", () => {
  it("shows what runs now and locks Medir agora while a pass is running", () => {
    spy.current.state = { igBatch: { own: true, manualAt: 1, startedAt: 1, total: 2, pending: ["nasa"], nextAt: 0 },
      igDaily: { day: new Date().toISOString().slice(0, 10), count: 3 } };
    render();
    const box = section("Medição");
    expect(box.textContent).toContain("Lote manual · 1 de 2 perfis · próximo @nasa");
    const button = box.querySelector("button");
    expect(button.textContent).toBe("medindo…");
    expect(button.disabled).toBe(true);
    expect(box.textContent).toContain("Hub: sincronizado com o hub");
  });

  it("lists the activity log newest first", () => {
    spy.current.activity = [
      { at: Date.now() - 2000, platform: null, tone: "info", text: "Medir agora: pedido recebido" },
      { at: Date.now(), platform: "instagram", tone: "warn", text: "Lote encerrado · 0 de 1 lidos — a aba não respondeu" },
    ];
    render();
    const items = [...section("Histórico").querySelectorAll("li")].map((li) => li.textContent);
    expect(items[0]).toContain("Lote encerrado");
    expect(items[1]).toContain("pedido recebido");
  });
});
