import type { SpyCard, SpyStory, StoriesPeriod } from "../../api";

// Helpers of the Stories section: labels, grouping and the "new since the last
// visit" mark, which lives in this browser only (localStorage), on purpose.

export const SEEN_KEY = "sm.stories.seenAt";

export function readSeenAt(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
}

export function writeSeenAt(at: number): void {
  try {
    localStorage.setItem(SEEN_KEY, String(at));
  } catch {
    /* private window or blocked storage: the mark is a convenience */
  }
}

/** The periods of the bar; "Favoritos" (`starred`) is a chip of its own and ignores the period. */
export const PERIOD_LABELS: Record<Exclude<StoriesPeriod, "starred">, string> = { live: "No ar", yesterday: "Ontem", "7d": "7 dias" };

export function hourLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

export function durationLabel(ms: number | null): string | null {
  if (!ms) return null;
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s}s`;
}

/** "há 3 h", "há 40 min", "agora". */
export function agoLabel(ms: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - ms) / 60_000));
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `há ${h} h` : `há ${Math.round(h / 24)} dias`;
}

const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

/** "Hoje · domingo 19/10", "Ontem · sábado 18/10", "sexta 17/10". */
export function dayLabel(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const dayKey = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  const base = `${WEEKDAYS[d.getDay()]} ${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
  if (dayKey(d) === dayKey(today)) return `Hoje · ${base}`;
  if (dayKey(d) === dayKey(yesterday)) return `Ontem · ${base}`;
  return base;
}

export function groupByDay(stories: SpyStory[], now = Date.now()): { label: string; items: SpyStory[] }[] {
  const groups: { label: string; items: SpyStory[] }[] = [];
  for (const s of stories) {
    const label = dayLabel(s.takenAt, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(s);
    else groups.push({ label, items: [s] });
  }
  return groups;
}

export function accountName(p: Pick<SpyCard, "name" | "key">): string {
  return p.name || `@${p.key}`;
}

export function initialOf(p: Pick<SpyCard, "name" | "key">): string {
  return (p.name || p.key).charAt(0).toUpperCase();
}

export const instagramStoriesUrl = (key: string, storyId?: string) =>
  `https://www.instagram.com/stories/${key}/${storyId ? `${storyId}/` : ""}`;
