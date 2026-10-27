// Raw captures for the Chrome Web Store listing, from the PUBLIC build, on synthetic
// data: fictional accounts, generated pictures, no third-party content.
//
//   node docs/store/tools/capture.mjs [extension dir]     (Node 22+: global WebSocket)
//
// Point it at the exported tree's dist/ (npm run export:public): that build is what
// ships, and the export replaces the private examples the source still carries.
//
// Writes docs/store/raw/*.png; tools/render.mjs turns them into the store images.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, wait } from "./cdp.mjs";

const ROOT = new URL("../../../", import.meta.url).pathname;
const RAW = join(ROOT, "docs/store/raw");
mkdirSync(RAW, { recursive: true });

const IG = [
  ["atelie.lunar.demo", "Ateliê Lunar", 1240000, 190],
  ["cafe.astro.demo", "Café com Astrologia", 486000, 40],
  ["taro.do.dia.demo", "Tarô do Dia", 312000, 280],
  ["ritual.cosmico.demo", "Ritual Cósmico", 96400, 330],
  ["mapa.signos.demo", "Mapa & Signos", 61800, 210],
];
const FB = [["estudio.venus.demo", "Estúdio Vênus", 154000, 20]];

const b = await launch({ extension: process.argv[2] || join(ROOT, "dist-public") });
try {
  const panel = await b.open(`chrome-extension://${b.extId}/index.html`, { width: 400, height: 780, scale: 2 });
  // Helpers in the page: generated JPEGs (a gradient, a soft disc, optional initials).
  await panel.ev(`(() => {
    window.__img = async (w, h, hue, label) => {
      const c = new OffscreenCanvas(w, h), g = c.getContext("2d");
      const grd = g.createLinearGradient(0, 0, w, h);
      grd.addColorStop(0, "hsl(" + hue + ",58%,52%)"); grd.addColorStop(1, "hsl(" + ((hue + 60) % 360) + ",55%,24%)");
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
      g.globalAlpha = .22; g.fillStyle = "#fff"; g.beginPath(); g.arc(w * .68, h * .32, Math.min(w, h) * .3, 0, 7); g.fill();
      g.globalAlpha = .12; g.beginPath(); g.arc(w * .2, h * .8, Math.min(w, h) * .45, 0, 7); g.fill(); g.globalAlpha = 1;
      if (label) { g.fillStyle = "#fff"; g.font = "700 " + Math.round(w * .36) + "px -apple-system, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(label, w / 2, h / 2 + 2); }
      const blob = await c.convertToBlob({ type: "image/jpeg", quality: .8 });
      return await new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); });
    };
    window.__hub = (method, path, body) => chrome.runtime.sendMessage({ type: "FBW_HUB_LOCAL", method, path, body: body ?? null });
    return true;
  })()`);
  const seed = await panel.ev(`(async () => {
    const IG = ${JSON.stringify(IG)}, FB = ${JSON.stringify(FB)};
    const now = Date.now(), DAY = 864e5, dayOf = (ms) => new Date(ms).toLocaleDateString("sv-SE");
    let seq = 3170000000000000000n;
    const profiles = [], snapshots = [], posts = [], thumbs = [];
    for (const [key, name, base, hue] of IG) await __hub("POST", "/api/spy/profiles", { url: "https://www.instagram.com/" + key + "/" });
    for (const [key, name, base, hue] of FB) await __hub("POST", "/api/spy/profiles", { url: "https://www.facebook.com/" + key });
    const all = [...IG.map((p) => ["instagram", ...p]), ...FB.map((p) => ["facebook", ...p])];
    for (const [platform, key, name, base, hue] of all) {
      const id = platform + ":" + key;
      profiles.push({ id, at: now, name, avatar: await __img(120, 120, hue, name[0]), verified: base > 1e6, bio: "Conta fictícia para demonstração." });
      for (let d = 30; d >= 0; d--) {
        const growth = (30 - d) * base * (0.0011 + (hue % 7) * 0.0002) + Math.sin(d * 1.3) * base * 0.0006;
        snapshots.push({ profileId: id, day: dayOf(now - d * DAY), measuredAt: now - d * DAY + 3600e3, source: "daily", followers: Math.round(base + growth), following: 300 + hue, posts: 900 + (30 - d) * 2 });
      }
      if (platform === "facebook") {
        const reels = [];
        for (let i = 0; i < 16; i++) {
          const rid = String(1300000000000000n + BigInt(hue * 100 + i));
          reels.push({ profileId: id, id: rid, createdAt: Math.floor((now - (i * 20 + 4) * 3600e3) / 1000), duration: 20 + i * 3, views: Math.round(base * (0.15 + Math.abs(Math.sin(i * 2.1)) * 1.4)) });
          if (i < 8) thumbs.push({ profileId: id, id: rid, thumb: await __img(144, 256, (hue + i * 31) % 360) });
        }
        await __hub("POST", "/local/sync/spy", { reels, reelsStatus: [{ profileId: id, status: "done" }], readings: [{ profileId: id, at: now - 120e3, kind: "reels", source: "daily", ok: true, reelsAdded: reels.length, pages: 2 }] });
      }
      if (platform !== "instagram") continue;
      for (let i = 0; i < 34; i++) {
        const ageH = i < 14 ? i * 12 + 3 : 7 * 24 + (i - 14) * 60;
        const createdAt = Math.floor((now - ageH * 3600e3) / 1000);
        const wave = Math.abs(Math.sin(i * 1.7 + hue)) ;
        const views = Math.round(base * (0.08 + wave * 0.9) * (i % 5 === 0 ? 2.4 : 1));
        const pid = String(seq++);
        posts.push({ profileId: id, id: pid, code: "Demo" + pid.slice(-6), createdAt, mediaType: "video", views,
          likes: Math.round(views * (0.03 + wave * 0.03)), comments: Math.round(views * (0.001 + wave * 0.002)), durationS: 12 + ((i * 7 + hue) % 48), observedAt: now - 60e3 });
        if (i < 14) thumbs.push({ profileId: id, id: pid, thumb: await __img(144, 256, (hue + i * 23) % 360) });
      }
    }
    const a = await __hub("POST", "/local/sync/spy", { profiles, snapshots, posts });
    const t = await __hub("POST", "/local/sync/spy", { thumbs });
    await chrome.runtime.sendMessage({ type: "FBW_SPY_REFRESH_LIST" });
    return JSON.stringify({ a: a.json?.results, t: t.json?.results?.thumbs });
  })()`);
  console.log("seed", seed);

  // Archive: three finished transcripts (Spanish, Portuguese, English).
  await panel.ev(`(async () => {
    const mk = async (videoId, platform, author, hue, language, text, views) => ({
      videoId, platform, status: "done", source: "whisper", language, text,
      chunks: text.split(". ").map((s, i) => ({ timestamp: [i * 4, i * 4 + 4], text: s })),
      thumb: await __img(180, 320, hue), author: { name: author, url: "/" + author + "/" },
      counts: { like: Math.round(views / 25), comment: Math.round(views / 600), views, share: null },
      caption: "Vídeo de demonstração", durationS: 38, takenAt: Math.floor(Date.now() / 1000) - 86400 * 2,
      sourceUrl: "https://www.instagram.com/reel/Demo" + videoId + "/", videoKind: "reel", updatedAt: Date.now() - Number(videoId.slice(-1)) * 6e4,
    });
    const items = [
      await mk("DemoEs1", "instagram", "taro.do.dia.demo", 280, "es", "Hoy la luna llena trae un cierre de ciclo. Es el momento ideal para soltar lo que ya no te sirve. Escribe tres intenciones y guárdalas hasta el próximo cuarto creciente.", 418000),
      await mk("DemoPt2", "instagram", "atelie.lunar.demo", 190, "br", "Três cartas para a sua semana. A primeira fala do que você precisa deixar ir. A segunda mostra onde está a sua força agora. A terceira é o conselho para os próximos dias.", 1270000),
      await mk("DemoEn3", "tiktok", "cafe.astro.demo", 40, "en", "Mercury is moving into a new sign this week. Slow down before signing anything important. Use the extra time to review your plans and talk things through.", 236000),
    ];
    await chrome.storage.local.set({ fbw_transcripts: Object.fromEntries(items.map((r) => [r.videoId, r])), fbw_transcript_language: "auto" });
    return true;
  })()`);

  const click = (label) => panel.ev(`(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === ${JSON.stringify(label)} || x.title === ${JSON.stringify(label)}); b?.click(); return !!b; })()`);
  await panel.ev("location.reload(); true");
  await wait(2500);
  await click("Spy");
  await wait(2500);
  writeFileSync(join(RAW, "panel-spy.png"), await panel.shot());
  await click("Arquivo");
  await wait(2500);
  await panel.ev(`(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim().startsWith("Transcrição")); b?.click(); return !!b; })()`);
  await wait(800);
  writeFileSync(join(RAW, "panel-archive.png"), await panel.shot());
  await panel.close();

  for (const [name, hash, after] of [["dash-top", "#spy", null], ["dash-profiles", "#spy/perfis", null], ["dash-sheet", "#spy/perfis", "sheet"]]) {
    const d = await b.open(`chrome-extension://${b.extId}/dashboard.html${hash}`, { width: 1440, height: 900, scale: 1 });
    // Biggest accounts first, so the first card (and the sheet opened from it) is a full one.
    await d.ev(`localStorage.setItem("socialmate_spy_sort", "followers"); location.reload(); true`);
    await wait(2500);
    if (after === "sheet") {
      await d.ev(`document.querySelector(".card-grid article")?.click(); true`);
      await wait(2200);
    }
    writeFileSync(join(RAW, name + ".png"), await d.shot());
    await d.close();
  }
  console.log("raw captures in", RAW);
} finally {
  await b.close();
}
