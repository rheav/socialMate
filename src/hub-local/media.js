// Where the local hub keeps its data in IndexedDB (PUBLIC build). Two databases,
// because idb-keyval opens one object store per database:
//   socialmate-local        / sqlite  — key "spy": the sql.js database file (Uint8Array)
//   socialmate-local-media  / stories — key "<storyId>/<media|poster>": a Blob
// Story bytes never go into SQLite or chrome.storage.
//
// This module has no sql.js in it, so extension pages (the dashboard) can import
// it to show a story: the dashboard refers to one as `local-story:<id>/<kind>`.

import { createStore, get } from "idb-keyval";

export const SQLITE_DB = "socialmate-local";
export const SQLITE_KEY = "spy";
export const MEDIA_DB = "socialmate-local-media";

let sqlite;
let media;
export const sqliteStore = () => (sqlite ??= createStore(SQLITE_DB, "sqlite"));
export const mediaStore = () => (media ??= createStore(MEDIA_DB, "stories"));

/** A story's media or poster as a Blob, or null. Read-only: writes go through the service worker. */
export async function readStoryMedia(id, kind) {
  if (kind !== "media" && kind !== "poster") return null;
  return (await get(`${id}/${kind}`, mediaStore())) ?? null;
}
