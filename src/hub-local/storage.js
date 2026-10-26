// The local hub's LocalStorage (router.ts) over IndexedDB, and an in-memory one
// for the tests.

import { del, delMany, get, keys, set } from "idb-keyval";
import { SQLITE_KEY, mediaStore, sqliteStore } from "./media.js";

export function idbStorage() {
  return {
    load: () => get(SQLITE_KEY, sqliteStore()),
    save: (bytes) => set(SQLITE_KEY, bytes, sqliteStore()),
    putMedia: (key, blob) => set(key, blob, mediaStore()),
    getMedia: (key) => get(key, mediaStore()),
    deleteMedia: (list) => (list.length === 1 ? del(list[0], mediaStore()) : delMany(list, mediaStore())),
    mediaKeys: async () => (await keys(mediaStore())).map(String),
  };
}

export function memoryStorage() {
  let file = null;
  const blobs = new Map();
  return {
    load: async () => file,
    save: async (bytes) => { file = bytes; },
    putMedia: async (key, blob) => { blobs.set(key, blob); },
    getMedia: async (key) => blobs.get(key) ?? null,
    deleteMedia: async (list) => { for (const key of list) blobs.delete(key); },
    mediaKeys: async () => [...blobs.keys()],
  };
}
