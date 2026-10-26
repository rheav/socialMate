import type { MiniDatabase } from "../db.js";

// Local stand-in for the hub's server/analysis/reportTags.ts. The hub's report
// rule (which tagged profiles the AI reports read) lives in analysis_settings,
// which the local build does not have: there are no reports, so the rule is
// always "every profile" and renaming a tag has no rule to follow.

export function reportTagsOf(_database: MiniDatabase): string[] {
  return [];
}

export function renameReportTag(_database: MiniDatabase, _from: string, _to: string): void {}

/** Verbatim from the hub: the clause for a query whose profile alias is `p`. */
export function tagFilter(tags: string[]): { sql: string; params: string[] } {
  if (!tags.length) return { sql: "", params: [] };
  return {
    sql: ` AND EXISTS (SELECT 1 FROM json_each(p.tags) WHERE lower(value) IN (${tags.map(() => "lower(?)").join(", ")}))`,
    params: [...tags],
  };
}
