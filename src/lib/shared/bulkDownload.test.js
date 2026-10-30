import { expect, it } from "vitest";
import { bulkDownload } from "./bulkDownload.js";

it("keeps going past a failed item and stops when asked", async () => {
  const saved = [];
  const save = async (r) => { if (r.id === "b") throw new Error("403"); saved.push(r.id); };
  expect(await bulkDownload([{ id: "a" }, { id: "b" }, { id: "c" }], save, () => false, () => {})).toEqual({ done: 2, failed: 1, error: "403" });
  expect(saved).toEqual(["a", "c"]);
  const steps = [];
  expect(await bulkDownload([{ id: "x" }, { id: "y" }], async () => {}, () => steps.length > 0, (n) => steps.push(n))).toEqual({ done: 1, failed: 0, error: null });
  expect(steps).toEqual([1]);
});
