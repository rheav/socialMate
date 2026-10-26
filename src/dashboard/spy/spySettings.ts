import { SPY_SORT_LABELS, type SpySort } from "./spyFormat";

export interface SpyCardFields {
  followers: boolean;
  delta7: boolean;
  delta30: boolean;
  deltaTotal: boolean;
  sparkline: boolean;
  posts: boolean;
  postsDaily: boolean;
  views: boolean;
  top3: boolean;
  following: boolean;
  tags: boolean;
  notes: boolean;
  bio: boolean;
  lastMeasured: boolean;
}

export const DEFAULT_SPY_CARD_FIELDS: SpyCardFields = {
  followers: true,
  delta7: true,
  delta30: false,
  deltaTotal: false,
  sparkline: true,
  posts: true, // Instagram posts; Facebook reels
  postsDaily: true,
  views: true,
  top3: true,
  following: false,
  tags: true,
  notes: true,
  bio: false,
  lastMeasured: true,
};

export interface FieldDef {
  key: keyof SpyCardFields;
  label: string;
  group: "Métricas" | "Informações" | "Status";
  description: string;
}

export const SPY_CARD_FIELD_DEFS: FieldDef[] = [
  { key: "followers", label: "Seguidores", group: "Métricas", description: "Contagem atual de seguidores" },
  { key: "delta7", label: "Crescimento 7 dias", group: "Métricas", description: "Variação de seguidores nos últimos 7 dias" },
  { key: "delta30", label: "Crescimento 30 dias", group: "Métricas", description: "Variação de seguidores nos últimos 30 dias" },
  { key: "deltaTotal", label: "Crescimento total", group: "Métricas", description: "Variação acumulada desde o primeiro registro" },
  { key: "sparkline", label: "Gráfico de tendência", group: "Métricas", description: "Mini gráfico dos últimos 30 dias" },
  { key: "posts", label: "Publicações", group: "Métricas", description: "Posts no Instagram; reels no Facebook" },
  { key: "postsDaily", label: "Posts por dia", group: "Métricas", description: "Posts (Instagram) ou reels (Facebook) de ontem e de hoje, com barras dos últimos 14 dias" },
  { key: "views", label: "Views 24h, 3 e 7 dias", group: "Métricas", description: "Soma das views dos reels publicados nas 24 h, 3 e 7 dias antes da última leitura" },
  { key: "top3", label: "Top 3 da semana", group: "Métricas", description: "Os 3 reels com mais visualizações nos últimos 7 dias (no Instagram, sem reels na semana, os posts com mais curtidas)" },
  { key: "following", label: "Seguindo", group: "Métricas", description: "Número de perfis seguidos" },
  { key: "tags", label: "Tags", group: "Informações", description: "Etiquetas coloridas do perfil" },
  { key: "notes", label: "Anotações", group: "Informações", description: "Nota interna salva no perfil" },
  { key: "bio", label: "Biografia", group: "Informações", description: "Texto da bio do perfil" },
  { key: "lastMeasured", label: "Status da medição", group: "Status", description: "Data/hora e status da última checagem no rodapé" },
];

const STORAGE_KEY = "socialmate_spy_card_fields";

export function loadSpyCardFields(): SpyCardFields {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SPY_CARD_FIELDS };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_SPY_CARD_FIELDS,
      ...parsed,
    };
  } catch {
    return { ...DEFAULT_SPY_CARD_FIELDS };
  }
}

export function saveSpyCardFields(fields: SpyCardFields): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(fields));
  } catch {}
}

const SORT_KEY = "socialmate_spy_sort";

/** The grid order is a per-browser preference; storage may be unavailable. */
export function loadSpySort(): SpySort {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    return raw && raw in SPY_SORT_LABELS ? (raw as SpySort) : "recent";
  } catch {
    return "recent";
  }
}

export function saveSpySort(sort: SpySort): void {
  try {
    localStorage.setItem(SORT_KEY, sort);
  } catch {
    /* private window or blocked storage: the choice lasts for this visit */
  }
}

/** How the Inteligência page lays out its sections: a column on the left, or tabs under the analysis panel. */
export type IntelLayout = "sidebar" | "tabs";

const LAYOUT_KEY = "socialmate_intel_layout";

export function loadIntelLayout(): IntelLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "tabs" ? "tabs" : "sidebar";
  } catch {
    return "sidebar";
  }
}

export function saveIntelLayout(layout: IntelLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    /* private window or blocked storage: the choice lasts for this visit */
  }
}

/** The sections the owner can drag into another order. Leituras is the extension's log and stays at the foot. */
export type IntelSection = "top" | "profiles" | "stories";

export const DEFAULT_SECTION_ORDER: IntelSection[] = ["top", "profiles", "stories"];

const ORDER_KEY = "socialmate_intel_order";

/** The saved order, cleaned: known sections once each, and a section it never had placed after its default neighbour. */
export function normalizeSectionOrder(saved: unknown): IntelSection[] {
  const order: IntelSection[] = [];
  if (Array.isArray(saved)) {
    for (const key of saved) {
      if ((DEFAULT_SECTION_ORDER as unknown[]).includes(key) && !order.includes(key as IntelSection)) order.push(key as IntelSection);
    }
  }
  if (!order.length) return [...DEFAULT_SECTION_ORDER];
  DEFAULT_SECTION_ORDER.forEach((key, i) => {
    if (order.includes(key)) return;
    const before = i > 0 ? order.indexOf(DEFAULT_SECTION_ORDER[i - 1]) : -1;
    order.splice(before + 1, 0, key);
  });
  return order;
}

export function loadSectionOrder(): IntelSection[] {
  try {
    return normalizeSectionOrder(JSON.parse(localStorage.getItem(ORDER_KEY) ?? "null"));
  } catch {
    return [...DEFAULT_SECTION_ORDER];
  }
}

export function saveSectionOrder(order: IntelSection[]): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  } catch {
    /* private window or blocked storage: the order lasts for this visit */
  }
}

/** The order with `key` moved to position `to`, clamped to the list. */
export function moveSection(order: IntelSection[], key: IntelSection, to: number): IntelSection[] {
  const rest = order.filter((k) => k !== key);
  rest.splice(Math.max(0, Math.min(to, rest.length)), 0, key);
  return rest;
}
