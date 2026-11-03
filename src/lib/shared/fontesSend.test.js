// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { fontesClick, fontesLabel, fontesSend, fontesVerdict } from "./fontesSend.js";
import { railLabel } from "./railTheme.js";

describe("fontesSend", () => {
  it("sends one message per photo and counts new and repeated", async () => {
    const sent = [];
    const send = async (m) => (sent.push(m.url), { ok: true, duplicate: m.url === "b" });
    expect(await fontesSend(["a", "b", "c"], "instagram", "https://p", send)).toEqual({ added: 2, dup: 1, error: null });
    expect(sent).toEqual(["a", "b", "c"]);
  });

  it("stops at the first refusal", async () => {
    const send = vi.fn(async () => ({ ok: false, error: "app" }));
    expect(await fontesSend(["a", "b"], "tiktok", "https://p", send)).toEqual({ added: 0, dup: 0, error: "app" });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("what the button says", () => {
  it.each([
    [{ added: 1, dup: 0, error: null }, "Nas Fontes", "ok"],
    [{ added: 0, dup: 1, error: null }, "Já estava nas Fontes", "dim"],
    [{ added: 3, dup: 0, error: null }, "3 nas Fontes", "ok"],
    [{ added: 2, dup: 1, error: null }, "2 nas Fontes, 1 já estava", "ok"],
    [{ added: 1, dup: 2, error: null }, "1 nas Fontes, 2 já estavam", "ok"],
    [{ added: 0, dup: 4, error: null }, "As 4 já estavam nas Fontes", "dim"],
    [{ added: 0, dup: 0, error: "app" }, "Abra o UGC Factory", "warn"],
    [{ added: 1, dup: 0, error: "fetch" }, "Não baixou a foto", "err"],
    [{ added: 0, dup: 0, error: "server" }, "Falhou", "err"],
  ])("%o → %s", (r, text, tone) => expect(fontesVerdict(r)).toEqual({ text, tone }));

  it("names what it is about to send", () => {
    expect([fontesLabel(1, true), fontesLabel(1, false), fontesLabel(5, false)]).toEqual([
      "Mandar a capa às Fontes", "Mandar a foto às Fontes", "Mandar as 5 fotos às Fontes",
    ]);
  });

  it("tells a page whose extension was reloaded to reload", async () => {
    vi.stubGlobal("chrome", { runtime: { sendMessage: () => { throw new Error("Extension context invalidated."); } } });
    const b = document.createElement("button");
    railLabel(b, "Mandar a foto às Fontes");
    fontesClick(b, ["https://x/a.jpg"], "instagram", "https://p");
    expect(b.classList.contains("busy")).toBe(true);
    await vi.waitFor(() => expect(b.querySelector(".sw-rb-lbl").textContent).toBe("Recarregue a página"));
    expect([b.classList.contains("busy"), b.dataset.flash]).toEqual([false, "err"]);
    vi.unstubAllGlobals();
  });
});
