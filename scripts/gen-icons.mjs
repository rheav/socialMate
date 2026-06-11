// Rasterize public/icon.svg → public/icons/icon-<size>.png using resvg.
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(resolve(root, "public/icon.svg"), "utf8");
mkdirSync(resolve(root, "public/icons"), { recursive: true });

for (const size of [16, 32, 48, 128, 256]) {
  const r = new Resvg(svg, { fitTo: { mode: "width", value: size }, background: "rgba(0,0,0,0)" });
  const png = r.render().asPng();
  writeFileSync(resolve(root, `public/icons/icon-${size}.png`), png);
  console.log(`icon-${size}.png  ${png.length} bytes`);
}
