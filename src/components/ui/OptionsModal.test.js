// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { NumberRow } from "./OptionsModal.jsx";

beforeAll(() => { vi.stubGlobal("React", React); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterAll(() => vi.unstubAllGlobals());

it("keeps a number typed in Options when the modal closes without a blur (Escape, click outside)", async () => {
  const onSave = vi.fn(async () => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(NumberRow, { id: "n", label: "Leituras", value: 50, min: 1, max: 200, onSave })));
  const input = host.querySelector("input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "100");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => root.unmount());
  expect(onSave).toHaveBeenCalledWith(100);
});
