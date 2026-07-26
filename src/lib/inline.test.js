// The drift guard.
//
// Content scripts cannot import (an import turns them into a dynamic-import
// loader whose module fetch the page CSP can kill), so the pure helpers they
// share with the panel are copied into them at build time by
// scripts/gen-inline.mjs. This test is what makes that copy trustworthy: it fails
// if any content script carries a stale copy, which is exactly the failure that
// went unnoticed before — comments-scrape.js's parseCount had 5 locale unit words
// against this lib's 13, so "1,2 rb" parsed to null on the page while the unit
// tests stayed green.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SHARED = resolve(ROOT, "src/lib/shared");
// Only the inlinable modules themselves — a *.test.js beside them is normal code
// and is never copied into a content script.
const sharedModules = () =>
  readdirSync(SHARED).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"));

describe("inlined shared helpers", () => {
  it("every content-script copy is up to date with src/lib/shared/", () => {
    // Throws (non-zero exit) with the offending file names if a region is stale.
    const out = execFileSync(
      process.execPath,
      ["scripts/gen-inline.mjs", "--check"],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(out).toContain("up to date");
  });

  it("no shared module imports anything but a sibling", () => {
    for (const f of sharedModules()) {
      const src = readFileSync(resolve(SHARED, f), "utf8");
      for (const line of src.split("\n")) {
        if (!/^\s*import\s/.test(line)) continue;
        // Only `import { … } from "./sibling.js";` is allowed — anything else
        // cannot survive being inlined into a content script.
        expect(line, `${f}: ${line.trim()}`).toMatch(
          /^import\s*\{[^}]*\}\s*from\s*"\.\/[\w.-]+\.js";?\s*$/,
        );
      }
    }
  });

  it("no shared module uses a default export (the generator only strips `export `)", () => {
    for (const f of sharedModules()) {
      const src = readFileSync(resolve(SHARED, f), "utf8");
      expect(src, f).not.toMatch(/^\s*export\s+default\b/m);
      expect(src, f).not.toMatch(/^\s*export\s*\{/m);
    }
  });

  it("the generated region is what the page actually runs", () => {
    // Spot-check the case that drifted: the full 13-entry unit map has to be
    // present in the page copy, not just in the lib.
    const page = readFileSync(
      resolve(ROOT, "src/content/fb/comments-scrape.js"),
      "utf8",
    );
    const lib = readFileSync(resolve(SHARED, "counts.js"), "utf8");
    for (const unit of ["rb", "tis", "tys", "tusen", "mio", "jt", "mln", "mrd"]) {
      expect(lib).toContain(`${unit}:`);
      expect(page, `page copy is missing the "${unit}" unit`).toContain(`${unit}:`);
    }
  });
});
