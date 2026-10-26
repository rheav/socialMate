// Writes the open-source tree: the public build's source, without the hub, the
// Instagram Scraper export or the warm engine, then proves it by running its tests
// and its build there.
//
//   node scripts/export-public.mjs [outDir]     (default: ../socialmate-public)
//
// Same rules as the public dist: src/build/stripRegions.js drops every @private
// region, PRIVATE_FILES go entirely, and the result must contain none of LEAKS.
// The out dir is replaced (only its .git is kept), so it can be a git checkout.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { stripRegions } from "../src/build/stripRegions.js";

const REPO = resolve(new URL("..", import.meta.url).pathname);
const OUT = resolve(process.argv[2] || join(REPO, "../socialmate-public"));

// Repo paths that go out (prefix match), then the ones that stay home.
const INCLUDE = [
  "index.html", "jsconfig.json", "manifest.config.js", "package.json", "package-lock.json",
  "vite.config.js", "vitest.config.js",
  "src/", "public/icon.svg", "public/icons/",
  "scripts/gen-inline.mjs", "scripts/gen-icons.mjs", "scripts/fetch-assets.mjs",
];
const PRIVATE_FILES = [
  // warm engine
  "src/content.js", "src/components/tools/WarmTool.jsx", "src/components/ui/OptionsDropdown.jsx",
  "src/components/ui/card.jsx", "src/components/ui/separator.jsx", "src/offscreen/relevance.worker.js",
  "src/lib/sessionMath.js", "src/lib/sessionMath.test.js",
  // hub
  "src/lib/syncClient.js", "src/lib/syncClient.test.js", "src/lib/useSyncSettings.js", "src/lib/useSyncSettings.test.js",
  "src/lib/hubStatus.js", "src/lib/hubStatus.test.js", "src/components/ui/HubStatusDot.jsx",
  "src/background/analysisRelay.js", "src/background/analysisRelay.test.js",
  "src/lib/analysisMedia.js", "src/lib/analysisMedia.test.js",
  // Instagram Scraper export
  "src/background/igExport.js", "src/background/igExport.test.js",
  "src/lib/igOutbox.js", "src/lib/igOutbox.test.js", "src/lib/igPresence.js", "src/lib/igPresence.test.js",
  "src/lib/igDestinations.js", "src/lib/igExportFormat.js", "src/lib/igExportFormat.test.js", "src/lib/useIgDestinations.js",
];
// The repo's own leak check and this script are about the private repo.
const PRIVATE_PREFIXES = ["scripts/verify-public.mjs", "scripts/export-public.mjs"];

// Real accounts in test fixtures and examples become placeholders of the same
// length (a few tests slice by position).
const SCRUB = [
  ["/Users/rheavictor", "/home/somebody0"],
  ["Users/rheavictor", "home/somebody0"],
  ["iniciar o aquecimento", "iniciar a coleta"],
  ["ivymoontarot7", "creator_beta7"],
  ["veloria691", "creator001"],
  ["solomonaldric", "creatorsample"],
  ["claire_mayaus", "creator_alpha"],
  ["melanie.may.528", "creator.one.528"],
  ["100092403319843", "100000000000042"],
  ["rheav7", "user07"],
];

// Strings that must not appear anywhere in the exported tree.
const LEAKS = [
  /rheav/i, /X-Sync-Token/, /\/api\/sync/, /ingest\/socialmate/, /extension-relay/, /localhost:3001/,
  /FBW_START\b/, /FBW_RELEVANCE/, /fbw_session/, /Aquecer/, /aquecedor/i, /aquecimento/i,
  ...SCRUB.map(([real]) => new RegExp(real.replace(/[.]/g, "\\."))),
];

const TEXT = /\.(m?js|jsx|ts|tsx|json|html|css|md)$/;
const CONFIGS = ["vite.config.js", "vitest.config.js", "manifest.config.js"];

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" }).split("\0").filter(Boolean);
const files = tracked.filter(
  (f) =>
    INCLUDE.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p)) &&
    !PRIVATE_FILES.includes(f) &&
    !PRIVATE_PREFIXES.some((p) => f.startsWith(p)),
);
for (const f of PRIVATE_FILES) if (!tracked.includes(f)) console.warn(`export: PRIVATE_FILES lists a missing file: ${f}`);

// Fresh tree, keeping a .git the out dir may already have.
mkdirSync(OUT, { recursive: true });
for (const e of readdirSync(OUT)) if (e !== ".git") rmSync(join(OUT, e), { recursive: true, force: true });

for (const f of files) {
  const dest = join(OUT, f);
  mkdirSync(dirname(dest), { recursive: true });
  if (!TEXT.test(f)) {
    cpSync(join(REPO, f), dest);
    continue;
  }
  let text = stripRegions(readFileSync(join(REPO, f), "utf8"), "private", f, { blank: false });
  for (const [real, fake] of SCRUB) text = text.replaceAll(real, fake);
  if (CONFIGS.includes(f)) text = text.replaceAll('process.env.PUBLIC === "1"', "true").replaceAll('"dist-public', '"dist');
  writeFileSync(dest, text);
}

// The public repo's own README, LICENSE and .gitignore.
cpSync(join(REPO, "public-repo"), OUT, { recursive: true });

const pkg = JSON.parse(readFileSync(join(OUT, "package.json"), "utf8"));
delete pkg.scripts["build:public"];
delete pkg.scripts["verify:public"];
pkg.scripts.setup = "node scripts/fetch-assets.mjs";
pkg.description = "Pesquisa de Facebook / Instagram / TikTok / Pinterest num painel lateral do Chrome — tudo local, sem servidor.";
pkg.license = "GPL-3.0-or-later";
writeFileSync(join(OUT, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

// ---- proof --------------------------------------------------------------
const leaks = [];
(function scan(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) scan(p);
    else if (TEXT.test(e.name) || e.name === "LICENSE") {
      const text = readFileSync(p, "utf8");
      for (const re of LEAKS) if (re.test(text)) leaks.push(`${relative(OUT, p)}: ${re}`);
      if (/@(end-)?(private|public)\b/.test(text) && /\.(m?js|jsx|ts|tsx)$/.test(e.name) && !/stripRegions/.test(e.name))
        leaks.push(`${relative(OUT, p)}: region marker left`);
    }
  }
})(OUT);
if (leaks.length) {
  console.error(`export: ${leaks.length} leak(s)\n  ${leaks.join("\n  ")}`);
  process.exit(1);
}

if (process.argv.includes("--no-check")) process.exit(0);
// Borrow the private repo's installed packages and binaries to test and build.
symlinkSync(join(REPO, "node_modules"), join(OUT, "node_modules"));
for (const d of ["public/models/Xenova/whisper-base", "public/models/mdx", "public/ffmpeg", "public/assets"]) {
  if (existsSync(join(REPO, d))) cpSync(join(REPO, d), join(OUT, d), { recursive: true });
}
const run = (cmd, args) => execFileSync(cmd, args, { cwd: OUT, stdio: "inherit", env: { ...process.env, PUBLIC: "" } });
try {
  run("npx", ["vitest", "run"]);
  run("npx", ["vite", "build", "--logLevel", "warn"]);
} finally {
  rmSync(join(OUT, "node_modules"), { force: true });
}
console.log(`export: ${files.length} files → ${OUT} · tests and build passed`);
