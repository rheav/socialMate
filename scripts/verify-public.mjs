// Checks that dist-public/ (PUBLIC=1 build) carries no hub, scraper or warm code.
// Exit 1 with the offending files when anything is left. Run after `npm run build:public`.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

// A build folder may be passed (the exported tree's dist/); dist-public/ otherwise.
const ROOT = process.argv[2] ? `${process.argv[2].replace(/\/$/, "")}/` : new URL("../dist-public/", import.meta.url).pathname;
const TEXT = /\.(js|mjs|html|json|css)$/;
const FORBIDDEN = [
  // hub
  /rheav/, /X-Sync-Token/, /\/api\/sync/, /ws\/socialmate/, /FBW_SYNC_/, /Trackear no Hub/,
  // Instagram Scraper backend
  /ingest\/socialmate/, /extension-relay/, /localhost:3001/,
  // warm engine
  /FBW_START/, /FBW_RELEVANCE/, /fbw_session/, /aquec/i, /Aquecer/,
];

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

if (!existsSync(ROOT)) {
  console.error("dist-public/ not found — run `npm run build:public` first.");
  process.exit(1);
}

const problems = [];
for (const file of walk(ROOT)) {
  if (!TEXT.test(file)) continue;
  const text = readFileSync(file, "utf8");
  const hits = FORBIDDEN.filter((re) => re.test(text)).map(String);
  if (hits.length) problems.push(`${relative(ROOT, file)}: ${hits.join(" ")}`);
}

const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const scripts = manifest.content_scripts.flatMap((c) => c.js);
if (scripts.some((s) => /(^|\/)content\.js/.test(s))) problems.push("manifest.json: warm content script (src/content.js) still registered");
if (JSON.stringify(manifest.host_permissions).match(/localhost|127\.0\.0\.1/)) problems.push("manifest.json: localhost host permission");
if (manifest.optional_host_permissions) problems.push("manifest.json: optional_host_permissions");
if (existsSync(join(ROOT, "models/Xenova/all-MiniLM-L6-v2"))) problems.push("models/Xenova/all-MiniLM-L6-v2: warm relevance model shipped");

if (problems.length) {
  console.error(`verify-public: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("verify-public: clean");
