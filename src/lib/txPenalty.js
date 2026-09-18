// Whisper's repetition penalty, as a setting (Opções → Transcrição).
//
// The penalty lowers the score of every token already generated in the window.
// It exists against Whisper's loops on silence/music ("obrigado obrigado…"), but
// it punishes LEGITIMATE repeats just as hard: speech repeats "you", "que", "de"
// all the time. Measured on a 57 s English clip with whisper-base: 1.1 (the old
// hard-coded value) → 28 of 180 words wrong, the ending cut off; off → 0 wrong.
// So it is off by default, and the value used is stored on each transcript
// (`repetitionPenalty`, 1 = off) and synced, so a bad transcript can be traced.
//
// cleanChunks in the offscreen document still drops looping chunks either way.

export const TX_PENALTY_KEY = "fbw_tx_rep_penalty"; // { enabled, value }
export const TX_PENALTY_VALUES = [1.05, 1.1, 1.2];
export const DEFAULT_TX_PENALTY = { enabled: false, value: 1.1 };

/** A malformed stored value falls back to OFF: a corrupt key must not start penalizing. */
export function normalizeTxPenalty(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: r.enabled === true,
    value: TX_PENALTY_VALUES.includes(r.value) ? r.value : DEFAULT_TX_PENALTY.value,
  };
}

/** The number Whisper receives. 1 is "no penalty" (Transformers.js skips the processor). */
export function txPenaltyValue(setting) {
  const s = normalizeTxPenalty(setting);
  return s.enabled ? s.value : 1;
}

/** A recorded value for display; null when the record has none (caption track, older record). */
export function txPenaltyLabel(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value <= 1 ? "desligada" : String(value);
}

export async function readStoredTxPenalty(storage = globalThis.chrome?.storage?.local) {
  try {
    const r = await storage?.get?.(TX_PENALTY_KEY);
    return normalizeTxPenalty(r?.[TX_PENALTY_KEY]);
  } catch {
    return { ...DEFAULT_TX_PENALTY };
  }
}

export async function writeStoredTxPenalty(patch, storage = globalThis.chrome?.storage?.local) {
  const next = normalizeTxPenalty({ ...(await readStoredTxPenalty(storage)), ...patch });
  try {
    await storage?.set?.({ [TX_PENALTY_KEY]: next });
  } catch {
    /* the panel still shows what was picked */
  }
  return next;
}
