import { describe, expect, it } from "vitest";
import { removalFailed } from "./transcriptStore.js";

describe("transcript removal result", () => {
  it("treats a removal that deleted nothing as a failure", () => {
    // The background answers {removed:n}; sendBg turns a dead/asleep worker into
    // {ok:false}. Both used to look identical to a success in the panel — the card
    // just stayed on screen with nothing said, which reads as a dead button.
    expect(removalFailed({ ok: true, removed: 1 })).toBe(false);
    expect(removalFailed({ ok: true, removed: -1 })).toBe(false); // -1 = "limpar tudo"
    expect(removalFailed({ ok: true, removed: 0 })).toBe(true);
    expect(removalFailed({ ok: false, error: "sem resposta do serviço" })).toBe(true);
    expect(removalFailed(undefined)).toBe(true);
    expect(removalFailed({ ok: true })).toBe(true);
  });
});
