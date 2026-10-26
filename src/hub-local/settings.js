// The sync settings, as the Spy code reads them, in the PUBLIC build: there is
// no server to configure, so the local hub always counts as configured and
// ready. Same names as lib/syncClient.js; no sql.js here, so the panel can
// import it.

export const SYNC_KEY = "fbw_sync";

const LOCAL = Object.freeze({ enabled: true, url: "local", token: "local" });

export function syncSettings() {
  return LOCAL;
}

export function isSyncConfigured() {
  return true;
}

export function isSyncReady() {
  return true;
}
