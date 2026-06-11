/*
 * fbMassDownloader - UI loader (ISOLATED world)
 *
 * - Publishes the extension base URL for the MAIN-world engine (ffmpeg/core URLs).
 * - Builds our own Shadow-DOM panel (no styles leak in/out of Facebook).
 * - Relays messages between the panel and engine/bridge.js via window.postMessage.
 *
 * Isolated and MAIN worlds share the same window for postMessage, so this needs
 * no chrome.* messaging round-trip.
 */
(function () {
  "use strict";

  // 1. Hand the extension base URL to the MAIN-world engine immediately.
  try {
    document.documentElement.setAttribute(
      "data-fbmd-base",
      chrome.runtime.getURL("")
    );
  } catch (e) {
    /* ignore */
  }

  const FROM_ENGINE = "FBMD-ENGINE";
  const TO_ENGINE = "FBMD-UI";

  const state = {
    videos: [],
    selected: new Set(),
    mode: "highest",
    downloading: false,
    progress: new Map(), // id -> { stage, pct, status }
  };

  function toEngine(type, data) {
    window.postMessage(Object.assign({ source: TO_ENGINE, type }, data), "*");
  }

  /* ------------------------------- styles ------------------------------- */
  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    .launcher {
      position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
      width: 56px; height: 56px; border-radius: 16px; border: none; cursor: pointer;
      background: linear-gradient(160deg, #42A5F5, #1877F2 45%, #0866FF);
      box-shadow: 0 6px 20px rgba(8,102,255,.45); color: #fff;
      display: flex; align-items: center; justify-content: center; transition: transform .15s ease;
    }
    .launcher:hover { transform: translateY(-2px); }
    .launcher svg { width: 28px; height: 28px; }
    .badge {
      position: absolute; top: -6px; right: -6px; min-width: 20px; height: 20px; padding: 0 5px;
      border-radius: 10px; background: #ff3b30; color: #fff; font-size: 11px; font-weight: 700;
      display: flex; align-items: center; justify-content: center;
    }
    .panel {
      position: fixed; right: 20px; bottom: 88px; z-index: 2147483647;
      width: 380px; max-height: 70vh; background: #fff; border-radius: 16px; overflow: hidden;
      box-shadow: 0 16px 48px rgba(0,0,0,.28); display: none; flex-direction: column;
    }
    .panel.open { display: flex; }
    .head {
      background: linear-gradient(160deg, #1877F2, #0866FF); color: #fff; padding: 14px 16px;
      display: flex; align-items: center; gap: 10px;
    }
    .head .title { font-size: 15px; font-weight: 700; flex: 1; }
    .head .x { cursor: pointer; opacity: .85; font-size: 20px; line-height: 1; background: none; border: none; color: #fff; }
    .toolbar { display: flex; gap: 8px; align-items: center; padding: 10px 14px; border-bottom: 1px solid #eef0f3; flex-wrap: wrap; }
    .toolbar label { font-size: 12px; color: #444; display: flex; align-items: center; gap: 6px; cursor: pointer; }
    select { font-size: 12px; padding: 5px 8px; border: 1px solid #d6dae0; border-radius: 8px; background: #fff; }
    .btn {
      margin-left: auto; background: #1877F2; color: #fff; border: none; border-radius: 8px;
      padding: 7px 14px; font-size: 13px; font-weight: 600; cursor: pointer;
    }
    .btn:disabled { background: #9ec1f5; cursor: not-allowed; }
    .list { overflow-y: auto; padding: 6px 8px; }
    .empty { color: #888; font-size: 13px; text-align: center; padding: 28px 16px; line-height: 1.5; }
    .item { display: flex; align-items: center; gap: 10px; padding: 9px 8px; border-radius: 10px; }
    .item:hover { background: #f5f7fa; }
    .item input { width: 16px; height: 16px; }
    .item .meta { flex: 1; min-width: 0; }
    .item .name { font-size: 13px; color: #1c1e21; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .item .sub { font-size: 11px; color: #8a8d91; margin-top: 2px; }
    .qbadge { font-size: 10px; font-weight: 700; color: #0866FF; background: #e7f3ff; border-radius: 6px; padding: 2px 6px; }
    .bar { height: 4px; background: #eef0f3; border-radius: 3px; margin-top: 6px; overflow: hidden; display: none; }
    .bar.show { display: block; }
    .bar > i { display: block; height: 100%; width: 0; background: #1877F2; transition: width .2s ease; }
    .item.done .name::after { content: " ✓"; color: #2e7d32; }
    .item.error .sub { color: #d32f2f; }
    .foot { padding: 8px 14px; border-top: 1px solid #eef0f3; font-size: 11px; color: #8a8d91; min-height: 30px; }
  `;

  const DL_ICON = `<svg viewBox="0 0 24 24" fill="none"><path d="M12 3v11m0 0l4-4m-4 4l-4-4" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 17v1a3 3 0 003 3h8a3 3 0 003-3v-1" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>`;

  /* ---------------------------- build the DOM --------------------------- */
  let root, els;
  function build() {
    if (root) return;
    const host = document.createElement("div");
    host.id = "fbmd-root";
    (document.body || document.documentElement).appendChild(host);
    root = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = STYLE;
    root.appendChild(style);

    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <button class="launcher" title="fbMassDownloader">
        ${DL_ICON}
        <span class="badge" style="display:none">0</span>
      </button>
      <div class="panel">
        <div class="head">
          <div class="title">fbMassDownloader</div>
          <button class="x" title="Close">×</button>
        </div>
        <div class="toolbar">
          <label><input type="checkbox" class="all"> Select all</label>
          <select class="mode">
            <option value="highest">Highest quality (video + audio)</option>
            <option value="video">Video only</option>
            <option value="audio">Audio only</option>
          </select>
          <button class="btn dl">Download</button>
        </div>
        <div class="list"></div>
        <div class="foot">Scroll Facebook to detect videos.</div>
      </div>
    `;
    root.appendChild(wrap);

    els = {
      launcher: root.querySelector(".launcher"),
      badge: root.querySelector(".badge"),
      panel: root.querySelector(".panel"),
      close: root.querySelector(".x"),
      all: root.querySelector(".all"),
      mode: root.querySelector(".mode"),
      dl: root.querySelector(".dl"),
      list: root.querySelector(".list"),
      foot: root.querySelector(".foot"),
    };

    els.launcher.addEventListener("click", () => {
      els.panel.classList.toggle("open");
      if (els.panel.classList.contains("open")) toEngine("getVideos");
    });
    els.close.addEventListener("click", () => els.panel.classList.remove("open"));
    els.mode.addEventListener("change", () => (state.mode = els.mode.value));
    els.all.addEventListener("change", () => {
      state.selected = els.all.checked
        ? new Set(state.videos.map((v) => v.id))
        : new Set();
      renderList();
    });
    els.dl.addEventListener("click", startDownload);

    renderList();
  }

  /* ------------------------------ rendering ----------------------------- */
  function setFoot(text) {
    if (els) els.foot.textContent = text;
  }

  function renderBadge() {
    if (!els) return;
    const n = state.videos.length;
    els.badge.textContent = String(n);
    els.badge.style.display = n ? "flex" : "none";
  }

  function renderList() {
    if (!els) return;
    renderBadge();
    if (!state.videos.length) {
      els.list.innerHTML = `<div class="empty">No videos detected yet.<br>Play or scroll past a video/reel on Facebook and it will appear here.</div>`;
      return;
    }
    els.list.innerHTML = "";
    for (const v of state.videos) {
      const p = state.progress.get(v.id);
      const row = document.createElement("div");
      row.className = "item" + (p && p.status ? " " + p.status : "");
      row.innerHTML = `
        <input type="checkbox" ${state.selected.has(v.id) ? "checked" : ""}>
        <div class="meta">
          <div class="name">${escapeHtml(v.label)}</div>
          <div class="sub">${p ? escapeHtml(p.stage || "") : v.hasAudio ? "video + audio" : "video only"}</div>
          <div class="bar ${p ? "show" : ""}"><i style="width:${p ? Math.round(p.pct * 100) : 0}%"></i></div>
        </div>
        ${v.height ? `<span class="qbadge">${v.height}p</span>` : ""}
      `;
      const cb = row.querySelector("input");
      cb.addEventListener("change", () => {
        if (cb.checked) state.selected.add(v.id);
        else state.selected.delete(v.id);
      });
      els.list.appendChild(row);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function startDownload() {
    const ids = [...state.selected];
    if (!ids.length) {
      setFoot("Select at least one video first.");
      return;
    }
    for (const id of ids) state.progress.set(id, { stage: "Queued", pct: 0 });
    toEngine("download", { ids, mode: state.mode });
    renderList();
  }

  /* --------------------------- engine messages -------------------------- */
  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || d.source !== FROM_ENGINE) return;
    switch (d.type) {
      case "ready":
        toEngine("getVideos");
        break;
      case "videos":
        state.videos = d.payload || [];
        // prune selections that no longer exist
        const ids = new Set(state.videos.map((v) => v.id));
        state.selected = new Set([...state.selected].filter((x) => ids.has(x)));
        renderList();
        break;
      case "progress":
        state.progress.set(d.id, { stage: d.stage, pct: d.pct, status: "" });
        renderList();
        break;
      case "done":
        state.progress.set(d.id, { stage: "Saved " + d.filename, pct: 1, status: "done" });
        state.selected.delete(d.id);
        setFoot(`Saved ${d.index}/${d.total}: ${d.filename}`);
        renderList();
        break;
      case "error":
        state.progress.set(d.id, { stage: "Error: " + d.message, pct: 0, status: "error" });
        renderList();
        break;
      case "batch":
        state.downloading = d.state === "start";
        if (els) {
          els.dl.disabled = state.downloading;
          els.dl.textContent = state.downloading ? "Downloading..." : "Download";
        }
        if (d.state === "end") setFoot("Batch complete.");
        break;
      case "log":
        console.debug("[fbMassDownloader]", d.message);
        break;
    }
  });

  /* ------------------------------- startup ------------------------------ */
  function init() {
    build();
    toEngine("getVideos");
  }
  if (document.body) init();
  else document.addEventListener("DOMContentLoaded", init);
})();
