import { describe, expect, it } from "vitest";
import { activityNow, profileStatus, reelsLine, syncStatus } from "./spyStatus.js";

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
    expect(syncStatus({ ops: [{}], snapshots: { a: {}, b: {} } }, {})).toMatchObject({ pending: 3, text: "3 registros aguardando envio ao hub" });
    expect(syncStatus({}, {})).toMatchObject({ pending: 0, text: "sincronizado com o hub", tone: "ok" });
    expect(syncStatus({ ops: [{}] }, {}).text).toBe("1 registro aguardando envio ao hub");
    expect(syncStatus({}, { lastError: "limit_reached" })).toMatchObject({ text: "o hub recusou: limite de 100 perfis", tone: "warn" });
  });

  it("counts readings and reels too, and says when the last upload failed and why", () => {
    const queue = { readings: { a: {}, b: {} }, reels: { r: {} }, reelsStatus: { s: {} } };
    expect(syncStatus(queue, {}).pending).toBe(4);
    const hub = { ok: false, at: now - 5 * 60000, status: 0, error: "Failed to fetch" };
    expect(syncStatus(queue, {}, hub, now)).toMatchObject({ tone: "warn",
      text: "4 registros aguardando envio · último envio falhou há 5 min (hub fora do ar ou sem rede) · tenta de novo sozinho" });
    expect(syncStatus({}, {}, { ok: true, at: now - 120000, sent: 3 }, now).text).toBe("sincronizado com o hub · último envio há 2 min");
    expect(syncStatus(queue, {}, { ok: false, at: now, status: 401 }, now).text).toContain("token recusado");
  });
});

describe("activityNow", () => {
  const profiles = [ig, { id: "instagram:natgeo", platform: "instagram", key: "natgeo" },
    { ...fb, name: "Mark Zuckerberg" }, { id: "facebook:meta", platform: "facebook", key: "meta" }];
  const batch = { own: true, manualAt: now - 60000, startedAt: now - 60000, total: 3, pending: ["nasa", "natgeo"],
    current: null, nextAt: now + 23000 };

  it("is idle with the next automatic pass when nothing runs", () => {
    const a = activityNow({}, profiles, { now, nextTickAt: now + 3 * 3600000 });
    expect(a.busy).toBe(false);
    expect(a.lines).toEqual([expect.objectContaining({ text: "Nada em andamento · próxima passada automática às 17:00" })]);
  });

  it("says when the daily pass is off and Medir agora is the only way", () => {
    const a = activityNow({}, profiles, { now, dailyOff: true });
    expect(a.lines[0].text).toBe("Nada em andamento · medição diária desligada em Opções; o Medir agora continua funcionando");
  });

  it("follows an Instagram batch: progress, the profile being read, the wait and the queue", () => {
    let a = activityNow({ igBatch: batch }, profiles, { now });
    expect(a.busy).toBe(true);
    expect(a.lines[0]).toMatchObject({ platform: "instagram", spinning: false,
      text: "Lote manual · 1 de 3 perfis · próximo @nasa em 23 s", detail: "na fila depois: @natgeo" });
    a = activityNow({ igBatch: { ...batch, current: "nasa" },
      measuring: { id: "instagram:nasa", platform: "instagram", key: "nasa" } }, profiles, { now });
    expect(a.lines[0]).toMatchObject({ spinning: true, text: "Lote manual · 1 de 3 perfis · lendo @nasa…" });
    a = activityNow({ igBatch: { ...batch, manualAt: undefined, total: undefined } }, profiles, { now });
    expect(a.lines[0].text).toMatch(/^Lote diário · 0 de 2 perfis/);
  });

  it("follows the Facebook queue, a reading in progress and the reels reading", () => {
    const a = activityNow({ fbManual: ["facebook:zuck", "facebook:meta"],
      measuring: { id: "facebook:meta", platform: "facebook", key: "meta" },
      reelsJob: { profileId: "facebook:zuck", mode: "initial", pages: 4, added: 37, nextAt: now + 31000 } },
      profiles, { now, nextTickAt: now + 41000 });
    expect(a.lines.map((l) => l.text)).toEqual([
      "Lendo @meta…",
      "2 na fila do Medir agora · próximo Mark Zuckerberg em 41 s",
      "Reels de Mark Zuckerberg (leitura inicial) · 4 páginas, 37 reels · próxima página em 31 s",
    ]);
  });

  it("explains a platform pause", () => {
    const a = activityNow({ blocked: { instagram: now + 2 * 3600000 }, blockedReason: { instagram: "rate_limited" } },
      profiles, { now });
    expect(a.lines[0]).toMatchObject({ platform: "instagram", tone: "warn",
      text: "Em pausa até 16:00 — a rede limitou as consultas" });
  });
});

describe("reelsLine", () => {
  const p = (reels) => ({ ...fb, reels });
  it("follows the first full reading of a Facebook profile", () => {
    expect(reelsLine(ig, {})).toBeNull();
    expect(reelsLine(fb, {})).toBeNull();
    expect(reelsLine(p({ status: "pending", count: 0 }), {})).toBe("reels: na fila para a primeira leitura");
    expect(reelsLine(p({ status: "running", count: 140 }), { reelsJob: { profileId: fb.id, pages: 3 } })).toBe("lendo reels · 140 até agora");
    expect(reelsLine(p({ status: "running", count: 300 }), {})).toBe("300+ reels · a leitura continua");
    expect(reelsLine(p({ status: "done", count: 523 }), {})).toBe("523 reels");
    expect(reelsLine(p({ status: "done", count: 523 }), { reelsJob: { profileId: fb.id, mode: "catchup" } })).toBe("523 reels · buscando novos");
  });
});
