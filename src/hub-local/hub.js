// The service worker's one local hub (PUBLIC build): sql.js loaded from the
// wasm shipped with the extension, the database and story media in IndexedDB.
// Created on first use; a failed start is retried by the next call.

import initSqlJs from "sql.js";
import sqlWasmUrl from "sql.js/dist/sql-wasm-browser.wasm?url";
import { createLocalHub } from "./router.ts";
import { idbStorage } from "./storage.js";

let hub = null;
let collectStories = null;

/** background.js wires "Coletar stories" to the stories pass (the hub's relay command). */
export function setCollectStories(fn) {
  collectStories = fn;
}

export function localHub() {
  // Vite answers the asset as a root path (/assets/…); resolved against the extension's origin.
  hub ??= initSqlJs({ locateFile: () => new URL(sqlWasmUrl, chrome.runtime.getURL("/")).href })
    .then((SQL) => createLocalHub({
      SQL,
      storage: idbStorage(),
      collectStories: (msg, reply) => (collectStories ? collectStories(msg, reply) : reply.result(false, { error: "extension_offline" })),
    }))
    .catch((err) => {
      hub = null;
      throw err;
    });
  return hub;
}
