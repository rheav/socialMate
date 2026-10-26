import { fmtCount } from "../format";
import type { SpyCard, SpyViewsBlock, SpyViewsPoint, SpyViewsReel, SpyViewsWindow } from "../api";

export function fmtDelta(delta: number | null | undefined): string | null {
  if (delta == null) return null;
  if (delta === 0) return "0";
  const absFormatted = Math.abs(delta).toLocaleString("pt-BR");
  if (delta > 0) return `+${absFormatted}`;
  return `−${absFormatted}`;
}

export function subtractDays(dayStr: string, days: number): string {
  const d = new Date(`${dayStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function fmtFollowers(
  followers: number | null | undefined,
  _approx = false
): string {
  if (followers == null) return "—";
  return fmtCount(followers) ?? "—";
}

export interface Staleness {
  label: string;
  text: string;
  isStale: boolean;
  stale: boolean;
  toString(): string;
}

export function staleness(
  lastMeasuredAt: number | null | undefined,
  now = Date.now()
): Staleness {
  if (lastMeasuredAt == null) {
    const text = "aguardando primeira medição";
    return {
      label: text,
      text,
      isStale: false,
      stale: false,
      toString() {
        return text;
      },
    };
  }

  const diffMs = Math.max(0, now - lastMeasuredAt);
  const minutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(diffMs / 3_600_000);
  const days = Math.floor(diffMs / 86_400_000);
  const isStale = diffMs >= 48 * 3_600_000;

  let text: string;
  if (minutes < 1) {
    text = "medido agora";
  } else if (hours < 1) {
    text = `medido há ${minutes} min`;
  } else if (days < 1) {
    text = `medido há ${hours} h`;
  } else {
    text = `medido há ${days} d`;
  }

  return {
    label: text,
    text,
    isStale,
    stale: isStale,
    toString() {
      return text;
    },
  };
}

export function sparkPath(
  points: (number | { day?: string; followers: number })[],
  width = 96,
  height = 28,
  padding = 2
): string {
  return sparkGeometry(points, width, height, padding)?.line ?? "";
}

/**
 * Sparkline geometry: the line (time-spaced when days are known), the same
 * line closed down to the baseline for an area fill, and the last point.
 */
export function sparkGeometry(
  points: (number | { day?: string; followers: number })[],
  width = 96,
  height = 28,
  padding = 2
): { line: string; area: string; end: { x: number; y: number } } | null {
  if (!points || points.length < 2) return null;

  const vals = points.map((p) => (typeof p === "number" ? p : p.followers));
  const min = Math.min(...vals);
  const max = Math.max(...vals);

  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  const n = vals.length;

  const dates = points.map((point) => typeof point === "number" || !point.day ? NaN : Date.parse(`${point.day}T00:00:00Z`));
  const timed = dates.every(Number.isFinite) && dates[n - 1] > dates[0];
  const xy = vals.map((value, i) => {
    const fraction = timed ? (dates[i] - dates[0]) / (dates[n - 1] - dates[0]) : i / (n - 1);
    return [padding + fraction * innerW, min === max ? height / 2 : padding + (1 - (value - min) / (max - min)) * innerH];
  });
  const line = xy.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const [firstX] = xy[0];
  const [lastX, lastY] = xy[n - 1];
  return {
    line,
    area: `${line} L ${lastX.toFixed(1)} ${height} L ${firstX.toFixed(1)} ${height} Z`,
    end: { x: Number(lastX.toFixed(1)), y: Number(lastY.toFixed(1)) },
  };
}

export function chartDomain(
  values: (number | null | undefined)[]
): [number, number] {
  const nums = values.filter(
    (v): v is number => typeof v === "number" && !Number.isNaN(v) && Number.isFinite(v)
  );

  if (nums.length === 0) return [0, 100];

  const min = Math.min(...nums);
  const max = Math.max(...nums);

  if (min === max) {
    if (min === 0) return [0, 10];
    const margin = Math.max(1, Math.round(min * 0.05));
    return [Math.max(0, min - margin), min + margin];
  }

  const range = max - min;
  const margin = Math.max(1, Math.round(range * 0.05));
  return [Math.max(0, min - margin), max + margin];
}

export function translateError(error: string | null | undefined): string | null {
  if (!error) return null;
  switch (error) {
    case "login_required":
      return "A extensão não está logada nessa rede.";
    case "rate_limited":
      return "A rede limitou as consultas. A extensão tenta de novo amanhã.";
    case "not_found":
      return "Perfil não encontrado. O endereço pode ter mudado.";
    case "parse_failed":
      return "A extensão não conseguiu ler esse perfil.";
    case "network":
      return "Falha de rede na última tentativa.";
    case "no_reels":
      return "A aba de reels não carregou.";
    case "no_grid":
      return "A página do perfil não carregou os posts.";
    case "no_page":
      return "O Instagram não respondeu à consulta.";
    case "unavailable":
      return "O vídeo não veio da página do post.";
    case "expired":
      return "O link do vídeo expirou antes do download.";
    case "missing":
      return "O vídeo não chegou ao Hub.";
    case "unknown":
      return "Erro inesperado.";
    default:
      return /^http_/.test(error) ? "A rede não respondeu à consulta." : error;
  }
}

/**
 * Measured days on a time axis. Unmeasured days are left out: the line bridges
 * them and the dots mark the days that were actually measured. Breaking the
 * line instead turned the frequent single missed day into isolated, invisible
 * points.
 */
export function temporalPoints<T extends { day: string; followers: number | null }>(snapshots: T[]): Array<T & { time: number }> {
  return snapshots
    .filter((snapshot) => snapshot.followers != null)
    .map((snapshot) => ({ ...snapshot, time: Date.parse(`${snapshot.day}T00:00:00Z`) }));
}

/** Axis tick label: a non-breaking space keeps "mi"/"mil" beside the number,
 *  where Recharts would otherwise wrap it into the next tick on narrow screens. */
export function fmtAxisCount(value: number): string {
  return (fmtCount(value) ?? String(value)).replace(" ", " ");
}

/** "instagram:old_name" → "@old_name" (numeric Facebook ids read as "perfil 123"). */
export function handleFromId(id: string): string {
  const key = id.slice(id.indexOf(":") + 1);
  return /^\d+$/.test(key) ? `perfil ${key}` : `@${key}`;
}

export type SpySort = "recent" | "measured" | "followers" | "growth" | "name";

export const SPY_SORT_LABELS: Record<SpySort, string> = {
  recent: "Salvos recentemente",
  measured: "Última medição",
  followers: "Mais seguidores",
  growth: "Crescimento em 7 dias",
  name: "Nome",
};

const fold = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

type Sortable = Pick<SpyCard, "id" | "key" | "name" | "notes" | "tags" | "savedAt" | "lastMeasuredAt" | "delta7"> & {
  latest: { followers: number | null } | null;
};

/** Tag filter, then text search (name, @handle, notes; accents and case ignored), then sort. */
export function filterSortProfiles<T extends Sortable>(
  profiles: T[],
  { query = "", sort = "recent", tag = null }: { query?: string; sort?: SpySort; tag?: string | null } = {},
): T[] {
  const words = fold(query.replace(/@/g, " ")).split(/\s+/).filter(Boolean);
  const matches = profiles.filter((p) => {
    if (tag && !p.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return false;
    if (!words.length) return true;
    const haystack = fold(`${p.name ?? ""} ${p.key} ${p.notes ?? ""}`);
    return words.every((word) => haystack.includes(word));
  });
  // Missing values sort last whatever the direction.
  const desc = (pick: (p: T) => number | null | undefined) => (a: T, b: T) => {
    const x = pick(a), y = pick(b);
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
    return y - x;
  };
  const compare: Record<SpySort, (a: T, b: T) => number> = {
    recent: desc((p) => p.savedAt),
    measured: desc((p) => p.lastMeasuredAt),
    followers: desc((p) => p.latest?.followers),
    growth: desc((p) => p.delta7),
    name: (a, b) => (a.name || a.key).localeCompare(b.name || b.key, "pt-BR", { sensitivity: "base" }),
  };
  return [...matches].sort(compare[sort] ?? compare.recent);
}

/**
 * What a card shows as "posts": Instagram's media_count, or on Facebook the
 * reels counted so far — "140+" until the first full reading is done.
 */
export function postsFigure(profile: Pick<SpyCard, "platform" | "latest" | "reels">): { value: string; label: string; counting: boolean } {
  const reels = profile.platform === "facebook" ? profile.reels : null;
  if (!reels) return { value: fmtCount(profile.latest?.posts) ?? "—", label: "posts", counting: false };
  const value = reels.count > 0 ? `${fmtCount(reels.count)}${reels.status === "done" ? "" : "+"}` : "—";
  return { value, label: "reels", counting: reels.status === "running" };
}

export interface DailyDay {
  key: string; // local YYYY-MM-DD
  start: Date;
  /** null: before the record starts, nothing known that day. */
  count: number | null;
  /** The day is still going (today) or the record starts within it. */
  partial: boolean;
}

const localKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Posts (or reels) per local day for the last `days` days, newest first. */
export function dailyCounts(
  daily: SpyCard["daily"],
  now = new Date(),
  days = 14,
): { label: "posts" | "reels"; days: DailyDay[]; today: number | null; yesterday: number | null } {
  const counts = new Map<string, number>();
  for (const t of daily?.times ?? []) {
    const key = localKey(new Date(t * 1000));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const since = daily?.since ?? null;
  const out: DailyDay[] = [];
  for (let i = 0; i < days; i++) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i + 1);
    const startS = start.getTime() / 1000;
    const endS = end.getTime() / 1000;
    const known = since != null && since < endS;
    out.push({
      key: localKey(start),
      start,
      count: known ? counts.get(localKey(start)) ?? 0 : null,
      partial: known && (i === 0 || since > startS),
    });
  }
  return { label: daily?.kind ?? "posts", days: out, today: out[0].count, yesterday: out[1]?.count ?? null };
}

// ---- views per period ----

const DAY_S = 86_400;

/** Card and sheet labels of the three windows (24 h, 3 and 7 days). */
export const VIEW_WINDOW_LABELS: Record<number, string> = { 1: "24h", 3: "3 dias", 7: "7 dias" };

/** The record is too short for the window, or some of its reels came without views. */
export function viewsPartial(w: SpyViewsWindow, block?: SpyViewsBlock | null): boolean {
  return !w.complete || w.missing > 0 || !!block?.provisional;
}

/** The reels of the window ending at `at` (ms), most viewed first. */
export function windowReels(reels: SpyViewsReel[], at: number, days: number): SpyViewsReel[] {
  const end = Math.floor(at / 1000);
  const start = end - days * DAY_S;
  return reels
    .filter((r) => r.createdAt > start && r.createdAt <= end)
    .sort((a, b) => (b.views ?? -1) - (a.views ?? -1) || b.createdAt - a.createdAt);
}

/** Views of the reels published each local day, for the last `days` days, newest first. */
export function viewsPerDay(
  reels: SpyViewsReel[],
  since: number | null,
  now = new Date(),
  days = 14,
): (DailyDay & { reels: number })[] {
  const byDay = new Map<string, { views: number; reels: number; missing: boolean }>();
  for (const r of reels) {
    const key = localKey(new Date(r.createdAt * 1000));
    const day = byDay.get(key) ?? { views: 0, reels: 0, missing: false };
    day.views += r.views ?? 0;
    day.reels += 1;
    if (r.views == null) day.missing = true;
    byDay.set(key, day);
  }
  const out: (DailyDay & { reels: number })[] = [];
  for (let i = 0; i < days; i++) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i + 1);
    const known = since != null && since < end.getTime() / 1000;
    const day = byDay.get(localKey(start));
    out.push({
      key: localKey(start),
      start,
      count: known ? day?.views ?? 0 : null,
      reels: day?.reels ?? 0,
      partial: known && (i === 0 || since > start.getTime() / 1000 || !!day?.missing),
    });
  }
  return out;
}

/** The last reading of each local day, oldest first: one point per day for the chart. */
export function viewsDailyPoints(history: SpyViewsPoint[]): (SpyViewsPoint & { day: string })[] {
  const byDay = new Map<string, SpyViewsPoint>();
  for (const point of [...history].sort((a, b) => a.at - b.at)) byDay.set(localKey(new Date(point.at)), point);
  return [...byDay.entries()].map(([day, point]) => ({ ...point, day }));
}

/** "há 40 min", "há 5 h", "há 3 d". */
export function ageLabel(createdAtS: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now / 1000 - createdAtS) / 60));
  if (minutes < 60) return `há ${minutes} min`;
  if (minutes < 48 * 60) return `há ${Math.floor(minutes / 60)} h`;
  return `há ${Math.floor(minutes / 1440)} d`;
}

/** "até a leitura de 08/10, 08:14". */
export function viewsReadLabel(at: number, provisional = false): string {
  const d = new Date(at);
  const when = `${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}, ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
  return provisional ? `prévia da grade do perfil de ${when}, antes da primeira leitura dos reels` : `até a leitura de ${when}`;
}
