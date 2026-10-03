import { describe, expect, it } from "vitest";
import { profileStatus, syncStatus } from "./spyStatus.js";

const now = new Date(2026, 9, 3, 14, 0).getTime();
const hour = 3600000;
const fb = { id: "facebook:zuck", platform: "facebook", key: "zuck" };
const ig = { id: "instagram:nasa", platform: "instagram", key: "nasa" };
const day = { day: "2026-10-03" };
const at = (ms) => new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

describe("profileStatus", () => {
  it("prefers an in-flight measurement", () => {
    expect(profileStatus(fb, { state: { ...day, measuring: { id: fb.id } }, now })).toMatchObject({ kind: "measuring" });
  });
  it("shows a save the hub has not confirmed yet", () => {
    const queue = { ops: [{ op: "save", id: fb.id, at: now }] };
    expect(profileStatus(fb, { state: day, queue, now })).toMatchObject({ kind: "local", text: "salvo localmente · aguardando envio ao hub" });
  });
  it("names when a paused platform resumes", () => {
    const until = now + 3 * hour;
    expect(profileStatus(fb, { state: { ...day, blocked: { facebook: until } }, now }).text).toBe(`em pausa até ${at(until)}`);
  });
  it("names the Instagram daily cap", () => {
    expect(profileStatus(ig, { state: { ...day, igDaily: { day: "2026-10-03", count: 20 } }, now })).toMatchObject({ kind: "waiting", text: "limite diário do Instagram · amanhã" });
  });
  it("names the next retry and a spent budget", () => {
    const first = { ...day, attempts: { [fb.id]: { n: 1, at: now - hour } } };
    expect(profileStatus(fb, { state: first, now }).text).toBe(`nova tentativa às ${at(now + 5 * hour)}`);
    const spent = { ...day, attempts: { [fb.id]: { n: 2, at: now - hour } } };
    expect(profileStatus(fb, { state: spent, now })).toMatchObject({ kind: "failed", text: "falhou hoje · tenta amanhã" });
  });
  it("marks a measurement still waiting for upload", () => {
    const p = { ...fb, lastMeasuredAt: now - 2 * 60000 };
    expect(profileStatus(p, { state: day, now }).text).toBe("medido há 2 min");
    const queue = { snapshots: { [`${fb.id}|2026-10-03`]: {} } };
    expect(profileStatus(p, { state: day, queue, now }).text).toBe("medido há 2 min · aguardando envio");
  });
  it("ignores yesterday's attempts", () => {
    const old = { day: "2026-10-02", attempts: { [fb.id]: { n: 2, at: now - 20 * hour } } };
    expect(profileStatus(fb, { state: old, now })).toMatchObject({ kind: "pending", text: "aguardando medição" });
  });
});

describe("syncStatus", () => {
  it("counts pending work and reports a rejected change", () => {
    expect(syncStatus({ ops: [{}], snapshots: { a: {}, b: {} } }, {})).toEqual({ pending: 3, text: "3 alterações aguardando envio ao hub" });
    expect(syncStatus({}, {})).toEqual({ pending: 0, text: "sincronizado com o hub" });
    expect(syncStatus({ ops: [{}] }, {}).text).toBe("1 alteração aguardando envio ao hub");
    expect(syncStatus({}, { lastError: "limit_reached" }).text).toBe("o hub recusou: limite de 100 perfis");
  });
});
