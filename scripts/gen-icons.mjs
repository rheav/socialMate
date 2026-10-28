// Rasterize public/icon.svg → public/icons/icon-<size>.png using resvg.
import { Resvg } from "@resvg/resvg-js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// public/icon-public.svg → public/icons-public/: the public build's own mark (socialRadar).
for (const [file, dir] of [["icon.svg", "icons"], ["icon-public.svg", "icons-public"]]) {
  if (!existsSync(resolve(root, "public", file))) continue; // the public repo has only its own mark
  const svg = readFileSync(resolve(root, "public", file), "utf8");
  mkdirSync(resolve(root, "public", dir), { recursive: true });
  for (const size of [16, 32, 48, 128, 256]) {
    const r = new Resvg(svg, { fitTo: { mode: "width", value: size }, background: "rgba(0,0,0,0)" });
    const png = r.render().asPng();
    writeFileSync(resolve(root, `public/${dir}/icon-${size}.png`), png);
    console.log(`${dir}/icon-${size}.png  ${png.length} bytes`);
  }
}
