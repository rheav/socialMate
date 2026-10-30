// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";

const settle = () => new Promise((r) => setTimeout(r, 450));

function addTile(id) {
  const tile = document.createElement("div");
  tile.dataset.testId = "pin";
  tile.innerHTML = `<a href="/pin/${id}/"><img></a>`;
  tile.getBoundingClientRect = () => ({ width: 200, height: 300 });
  document.body.append(tile);
  return tile;
}

beforeEach(async () => {
  vi.stubGlobal("chrome", {
    runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({}) },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
  });
  await import("./pin-api.js");
});

it("keeps decorating, styled, after Pinterest's boot replaces the whole document", async () => {
  await settle();
  document.open();
  document.write("<!doctype html><html><head></head><body></body></html>");
  document.close();
  const tile = addTile("111");
  await settle();
  expect(tile.querySelector(":scope > .sw-pin-acts")).not.toBeNull();
  expect(document.getElementById("sw-pin-style")).not.toBeNull();
});

it("retries a tile that gains its size without any DOM mutation", async () => {
  const tile = addTile("222");
  tile.getBoundingClientRect = () => ({ width: 0, height: 0 });
  await settle();
  expect(tile.querySelector(":scope > .sw-pin-acts")).toBeNull();
  tile.getBoundingClientRect = () => ({ width: 200, height: 300 });
  await settle();
  expect(tile.querySelector(":scope > .sw-pin-acts")).not.toBeNull();
});
