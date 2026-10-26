/**
 * Nord's Frost and Aurora — the nine hues of the palette that read as accents.
 * Polar Night is the app's own background and Snow Storm is its text, so
 * neither can also be a tag: a chip has to stand apart from what surrounds it.
 *
 * The order is the palette's own, and it is the order the pickers draw, so a
 * colour always sits where the eye last found it.
 */
export const NORD_TAG_COLORS = [
  "#8fbcbb", // nord7  — frost teal
  "#88c0d0", // nord8  — frost cyan
  "#81a1c1", // nord9  — frost blue
  "#5e81ac", // nord10 — frost deep blue
  "#bf616a", // nord11 — aurora red
  "#d08770", // nord12 — aurora orange
  "#ebcb8b", // nord13 — aurora yellow
  "#a3be8c", // nord14 — aurora green
  "#b48ead", // nord15 — aurora purple
] as const;

export type NordTagColor = (typeof NORD_TAG_COLORS)[number];

export function isNordTagColor(hex: string): boolean {
  return (NORD_TAG_COLORS as readonly string[]).includes(hex.trim().toLowerCase());
}

const HEX_RE = /^#[0-9a-f]{6}$/;

export function normalizeHex(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  const hashed = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return HEX_RE.test(hashed) ? hashed : null;
}

export const NOTE_ACCENT_FALLBACK = "#ebcb8b";

/**
 * A colour for a brand new tag: random, but only among the hues the list is
 * currently using least. Pure random hands out the same blue three times in a
 * row and the chips stop telling anything apart; cycling in palette order makes
 * every board look like the same rainbow. Least-used-then-random keeps the
 * spread of a rotation and the surprise the user asked for.
 *
 * `taken` is every colour already spent in the same list. Colours outside the
 * palette — a hex someone chose by hand — simply do not count towards it.
 */
export function pickTagColor(taken: readonly string[], random: () => number = Math.random): string {
  const used = new Map<string, number>(NORD_TAG_COLORS.map((hex) => [hex, 0]));
  for (const hex of taken) {
    const key = hex.trim().toLowerCase();
    const count = used.get(key);
    if (count !== undefined) used.set(key, count + 1);
  }

  const fewest = Math.min(...used.values());
  const free = [...used.entries()].filter(([, count]) => count === fewest).map(([hex]) => hex);
  return free[Math.floor(random() * free.length)] ?? NORD_TAG_COLORS[0];
}

/**
 * Colours for a batch of new tags at once, so adding "a, b, c" spreads them
 * instead of giving all three whatever was least used when the batch started.
 */
export function pickTagColors(count: number, taken: readonly string[], random: () => number = Math.random): string[] {
  const spent = [...taken];
  const picked: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const hex = pickTagColor(spent, random);
    picked.push(hex);
    spent.push(hex);
  }
  return picked;
}
