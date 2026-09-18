import { describe, expect, it } from "vitest";
import {
  DEFAULT_TX_PENALTY,
  TX_PENALTY_KEY,
  TX_PENALTY_VALUES,
  normalizeTxPenalty,
  readStoredTxPenalty,
  txPenaltyLabel,
  txPenaltyValue,
  writeStoredTxPenalty,
} from "./txPenalty.js";

const memoryStorage = (init = {}) => {
  const data = { ...init };
  return {
    data,
    get: async (k) => ({ [k]: data[k] }),
    set: async (o) => Object.assign(data, o),
  };
};

describe("repetition penalty setting", () => {
  it("is off by default, with 1.1 ready for when it is turned on", () => {
    expect(TX_PENALTY_KEY).toBe("fbw_tx_rep_penalty");
    expect(DEFAULT_TX_PENALTY).toEqual({ enabled: false, value: 1.1 });
    expect(TX_PENALTY_VALUES).toEqual([1.05, 1.1, 1.2]);
  });

  it("falls back to the default for anything malformed — never to a penalty", () => {
    expect(normalizeTxPenalty(undefined)).toEqual({ enabled: false, value: 1.1 });
    expect(normalizeTxPenalty("1.2")).toEqual({ enabled: false, value: 1.1 });
    expect(normalizeTxPenalty({ enabled: "yes", value: 1.2 })).toEqual({ enabled: false, value: 1.2 });
    expect(normalizeTxPenalty({ enabled: true, value: 7 })).toEqual({ enabled: true, value: 1.1 });
    expect(normalizeTxPenalty({ enabled: true, value: 1.05 })).toEqual({ enabled: true, value: 1.05 });
  });

  it("turns the setting into the number Whisper gets — 1 means no penalty", () => {
    expect(txPenaltyValue({ enabled: false, value: 1.2 })).toBe(1);
    expect(txPenaltyValue({ enabled: true, value: 1.2 })).toBe(1.2);
    expect(txPenaltyValue(null)).toBe(1);
  });

  it("labels a recorded value", () => {
    expect(txPenaltyLabel(1)).toBe("desligada");
    expect(txPenaltyLabel(1.1)).toBe("1.1");
    expect(txPenaltyLabel(null)).toBeNull();
    expect(txPenaltyLabel(undefined)).toBeNull();
  });

  it("round-trips through storage, merging partial writes", async () => {
    const storage = memoryStorage();
    expect(await readStoredTxPenalty(storage)).toEqual({ enabled: false, value: 1.1 });
    await writeStoredTxPenalty({ enabled: true }, storage);
    expect(await readStoredTxPenalty(storage)).toEqual({ enabled: true, value: 1.1 });
    await writeStoredTxPenalty({ value: 1.2 }, storage);
    expect(storage.data[TX_PENALTY_KEY]).toEqual({ enabled: true, value: 1.2 });
  });

  it("reads the default when storage throws", async () => {
    const broken = { get: async () => { throw new Error("gone"); } };
    expect(await readStoredTxPenalty(broken)).toEqual({ enabled: false, value: 1.1 });
  });
});
