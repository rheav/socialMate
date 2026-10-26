// The two formatting helpers the Spy views share (from the hub's transcript.ts and PostCard.tsx).

export const PLATFORM_META: Record<string, { label: string; color: string }> = {
  facebook: { label: "Facebook", color: "#8ecae6" },
  instagram: { label: "Instagram", color: "#cbaad9" },
  tiktok: { label: "TikTok", color: "#b2dba4" },
  pinterest: { label: "Pinterest", color: "#e79aa4" },
};

export function fmtCount(value: number | string | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (!Number.isFinite(value)) return null;
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0).replace(".", ",")} mil`;
  return `${(value / 1_000_000).toFixed(1).replace(".", ",")} mi`;
}
