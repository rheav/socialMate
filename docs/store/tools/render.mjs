// Chrome Web Store images from the raw captures (tools/capture.mjs): 1280×800
// screenshots per language, the 440×280 promo tile and the 1400×560 marquee.
//
//   node docs/store/tools/render.mjs
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, wait } from "./cdp.mjs";

const ROOT = new URL("../../../", import.meta.url).pathname;
const RAW = join(ROOT, "docs/store/raw");
const OUT = join(ROOT, "docs/store/screenshots");
const png = (file) => `data:image/png;base64,${readFileSync(file).toString("base64")}`;
const logo = png(join(ROOT, "public/icons-public/icon-128.png"));
const raw = (f) => png(join(RAW, f));

// [title, subtitle, kind, capture, object-position for "wide"]
const COPY = {
  "pt-BR": [
    ["Acompanhe contas no seu painel", "Seguidores, posts por dia e views de perfis do Instagram e do Facebook, medidos uma vez por dia.", "wide", "dash-profiles.png", "left top"],
    ["Veja o que mais funciona", "Top posts por views, interação e comentários, e os melhores horários para postar.", "wide", "dash-top.png", "left top"],
    ["A evolução de cada perfil", "Gráfico de seguidores, métricas atuais e as views dos reels, dia a dia.", "sheet", "dash-sheet.png"],
    ["Transcreva vídeos com IA local", "Português, inglês, espanhol ou automático. O áudio não sai do seu computador.", "panel", "panel-archive.png"],
    ["Tudo no seu navegador", "Sem conta e sem servidor. Salve perfis, meça na hora e abra o painel.", "panel", "panel-spy.png"],
  ],
  en: [
    ["Track accounts on your own dashboard", "Followers, posts per day and views of Instagram and Facebook profiles, measured once a day.", "wide", "dash-profiles.png", "left top"],
    ["See what works best", "Top posts by views, engagement and comments, and the best hours to post.", "wide", "dash-top.png", "left top"],
    ["Every profile's growth", "Follower chart, current metrics and reel views, day by day.", "sheet", "dash-sheet.png"],
    ["Transcribe videos with on-device AI", "Portuguese, English, Spanish or automatic. The audio never leaves your computer.", "panel", "panel-archive.png"],
    ["Everything stays in your browser", "No account, no server. Save profiles, measure now and open the dashboard.", "panel", "panel-spy.png"],
  ],
};
const TAGLINE = {
  "pt-BR": "Pesquise conteúdo e acompanhe contas no Instagram, Facebook, TikTok e Pinterest. Tudo local.",
  en: "Research content and track accounts on Instagram, Facebook, TikTok and Pinterest. All local.",
};

const css = `
  *{box-sizing:border-box;margin:0} body{width:1280px;height:800px;overflow:hidden;font-family:-apple-system,"SF Pro Display","Helvetica Neue",sans-serif;
  background:linear-gradient(135deg,#232833 0%,#2e3a50 48%,#4c6f9c 100%);color:#eceff4;position:relative}
  .dots{position:absolute;inset:0;background-image:radial-gradient(rgba(136,192,208,.22) 1px,transparent 1px);background-size:22px 22px;opacity:.55}
  .glow{position:absolute;right:-180px;top:-160px;width:720px;height:720px;border-radius:50%;background:radial-gradient(circle,rgba(136,192,208,.28),transparent 65%)}
  .cap{position:absolute;left:64px;top:0;bottom:0;width:430px;display:flex;flex-direction:column;justify-content:center;gap:18px}
  .brand{display:flex;align-items:center;gap:12px;font-weight:700;font-size:22px}.brand img{width:38px;height:38px;border-radius:9px}
  h1{font-weight:800;font-size:46px;line-height:1.06;letter-spacing:-.02em} h1 em{font-style:normal;color:#88c0d0}
  p{font-size:21px;line-height:1.42;color:#d8dee9}
  .shot{position:absolute;border-radius:14px;overflow:hidden;box-shadow:0 30px 70px rgba(5,10,25,.55),0 0 0 1px rgba(216,222,233,.18)}
  .wide{right:-60px;top:110px;width:760px;height:475px}.wide img{width:100%;height:100%;object-fit:cover}
  .panel{right:150px;top:56px;width:400px;height:688px}.panel img{width:100%;height:auto}
  /* The profile sheet: the right 576 px of a 1440×900 capture, shown as a tall card. */
  .sheet{right:110px;top:50px;width:500px;height:700px}.sheet img{position:absolute;width:1250px;left:-750px;top:0}
`;

const b = await launch();
try {
  const page = await b.open("about:blank");
  const shoot = async (html, w, h, file, type = "jpeg") => {
    const tmp = join(RAW, "_render.html");
    writeFileSync(tmp, html);
    await b.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }, page.sessionId);
    await b.send("Page.navigate", { url: `file://${tmp}` }, page.sessionId);
    await wait(500);
    writeFileSync(file, await page.shot(type === "jpeg" ? { format: "jpeg", quality: 90 } : {}));
    rmSync(tmp);
  };
  for (const [lang, items] of Object.entries(COPY)) {
    mkdirSync(join(OUT, lang), { recursive: true });
    for (const [i, [title, sub, kind, file, pos]] of items.entries()) {
      const shot = kind === "wide"
        ? `<div class="shot wide"><img src="${raw(file)}" style="object-position:${pos}"></div>`
        : `<div class="shot ${kind}"><img src="${raw(file)}"></div>`;
      await shoot(`<html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="dots"></div><div class="glow"></div>
        <div class="cap"><div class="brand"><img src="${logo}">socialRadar</div><h1>${title}</h1><p>${sub}</p></div>${shot}</body></html>`,
        1280, 800, join(OUT, lang, `${i + 1}.jpg`));
    }
  }
  const promo = (w, h, big, lang) => `<html><head><meta charset="utf-8"><style>${css} body{width:${w}px;height:${h}px}
    .c{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 ${big ? 90 : 30}px;gap:${big ? 22 : 10}px}
    .b{display:flex;align-items:center;gap:${big ? 18 : 10}px;font-weight:800;font-size:${big ? 56 : 30}px}.b img{width:${big ? 76 : 42}px;height:${big ? 76 : 42}px;border-radius:${big ? 16 : 9}px}
    .t{font-size:${big ? 30 : 16}px;line-height:1.3;font-weight:600;max-width:${big ? 640 : 380}px;color:#d8dee9}</style></head>
    <body><div class="dots"></div><div class="glow"></div><div class="c"><div class="b"><img src="${logo}">socialRadar</div><div class="t">${TAGLINE[lang]}</div></div>
    ${big ? `<div class="shot" style="right:60px;top:60px;width:560px;height:440px"><img style="width:100%;height:100%;object-fit:cover;object-position:left top" src="${raw("dash-profiles.png")}"></div>` : ""}</body></html>`;
  for (const lang of Object.keys(COPY)) {
    const suffix = lang === "pt-BR" ? "" : `-${lang}`;
    await shoot(promo(440, 280, false, lang), 440, 280, join(OUT, `promo-tile-440x280${suffix}.png`), "png");
    await shoot(promo(1400, 560, true, lang), 1400, 560, join(OUT, `marquee-1400x560${suffix}.png`), "png");
  }
  console.log("store images in", OUT);
} finally {
  await b.close();
}
