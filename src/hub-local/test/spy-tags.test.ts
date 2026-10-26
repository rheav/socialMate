import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "./harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { purgeRemoved, SPY_REMOVED_KEEP_MS } from "../server/spy.js";
import { createApp, type CreatedApp } from "./harness";
import { NORD_TAG_COLORS } from "../shared/tag-colors.js";

let dir: string;
let created: CreatedApp;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "socialmate-tags-test-"));
  created = createApp({
    dbPath: path.join(dir, "test.db"),
    appPassword: "",
    appName: "socialmate-test",
    syncToken: "test-token",
  });
});

afterEach(() => {
  created.database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("spy tags & notes API", () => {
  it("renames only capitalization without deleting the vocabulary entry", async () => {
    const p = (await request(created.app).post("/api/spy/profiles").send({ url: "instagram.com/audit" })).body;
    await request(created.app).patch(`/api/spy/profiles/${p.id}`).send({ tags: ["Cliente"] }).expect(200);
    await request(created.app).patch("/api/spy/tags/Cliente").send({ name: "cliente" }).expect(200);
    const res = await request(created.app).get("/api/spy/tags");
    expect(res.body.tags).toEqual([expect.objectContaining({ name: "cliente", count: 1 })]);
  });

  it("canonicalizes tag spelling and preserves target spelling when merging tags", async () => {
    await request(created.app).post("/api/spy/tags").send({ names: ["Cliente", "Alvo"] });
    const p = (await request(created.app).post("/api/spy/profiles").send({ url: "instagram.com/audit" })).body;
    const patched = await request(created.app).patch(`/api/spy/profiles/${p.id}`).send({ tags: ["cliente", "CLIENTE", "alvo"] });
    expect(patched.body.tags).toEqual(["Cliente", "Alvo"]);
    await request(created.app).patch("/api/spy/tags/Cliente").send({ name: "alvo" }).expect(200);
    const profiles = await request(created.app).get("/api/spy/profiles");
    expect(profiles.body.profiles[0].tags).toEqual(["Alvo"]);
    expect((await request(created.app).get("/api/spy/tags")).body.tags).toEqual([expect.objectContaining({ name: "Alvo", count: 1 })]);
  });

  it("removes tags containing JSON-escaped characters from profiles", async () => {
    const p = (await request(created.app).post("/api/spy/profiles").send({ url: "instagram.com/audit" })).body;
    await request(created.app).patch(`/api/spy/profiles/${p.id}`).send({ tags: ['Cliente "A"'] }).expect(200);
    await request(created.app).delete(`/api/spy/tags/${encodeURIComponent('Cliente "A"')}`).expect(200);
    expect((await request(created.app).get("/api/spy/profiles")).body.profiles[0].tags).toEqual([]);
  });

  it("manages tags vocabulary with Nord colors and tracks counts", async () => {
    // Initially empty
    const initRes = await request(created.app).get("/api/spy/tags").expect(200);
    expect(initRes.body.tags).toEqual([]);

    // Add tags
    const addRes = await request(created.app)
      .post("/api/spy/tags")
      .send({ items: ["concorrente", { name: "referencia", color: "#81a1c1" }] })
      .expect(201);

    expect(addRes.body.tags.length).toBe(2);
    const conc = addRes.body.tags.find((t: any) => t.name === "concorrente");
    const ref = addRes.body.tags.find((t: any) => t.name === "referencia");
    expect(NORD_TAG_COLORS).toContain(conc.color);
    expect(ref.color).toBe("#81a1c1");
    expect(conc.count).toBe(0);

    // Save a profile
    const p1 = (
      await request(created.app)
        .post("/api/spy/profiles")
        .send({ url: "https://www.instagram.com/creator1" })
        .expect(201)
    ).body;

    expect(p1.tags).toEqual([]);
    expect(p1.notes).toBe("");

    // Update tags and notes on profile
    const patchRes = await request(created.app)
      .patch(`/api/spy/profiles/${encodeURIComponent(p1.id)}`)
      .send({
        tags: ["concorrente", "novo_tag"],
        notes: "Perfil focado em estética e rotina",
      })
      .expect(200);

    expect(patchRes.body.tags).toEqual(["concorrente", "novo_tag"]);
    expect(patchRes.body.notes).toBe("Perfil focado em estética e rotina");

    // "novo_tag" should have been automatically added to spy_tags vocabulary with a Nord color!
    const tagsAfter = (await request(created.app).get("/api/spy/tags").expect(200)).body.tags;
    expect(tagsAfter.length).toBe(3);
    const novo = tagsAfter.find((t: any) => t.name === "novo_tag");
    expect(novo).toBeDefined();
    expect(NORD_TAG_COLORS).toContain(novo.color);
    expect(novo.count).toBe(1);

    const concAfter = tagsAfter.find((t: any) => t.name === "concorrente");
    expect(concAfter.count).toBe(1);
  });

  it("spreads colors evenly across Nord palette", async () => {
    const names = NORD_TAG_COLORS.map((_, i) => `tag_${i}`);
    const res = await request(created.app)
      .post("/api/spy/tags")
      .send({ names })
      .expect(201);

    const colors = res.body.tags.map((t: any) => t.color);
    expect(new Set(colors).size).toBe(NORD_TAG_COLORS.length);
  });

  it("recolors a tag", async () => {
    await request(created.app)
      .post("/api/spy/tags")
      .send({ name: "urgente" })
      .expect(201);

    const recolored = await request(created.app)
      .patch("/api/spy/tags/urgente")
      .send({ color: "#bf616a" })
      .expect(200);

    expect(recolored.body.color).toBe("#bf616a");

    const getTags = await request(created.app).get("/api/spy/tags").expect(200);
    expect(getTags.body.tags.find((t: any) => t.name === "urgente").color).toBe("#bf616a");
  });

  it("renames a tag and updates all profiles wearing it", async () => {
    const p1 = (
      await request(created.app)
        .post("/api/spy/profiles")
        .send({ url: "https://www.instagram.com/creator1" })
        .expect(201)
    ).body;
    const p2 = (
      await request(created.app)
        .post("/api/spy/profiles")
        .send({ url: "https://www.instagram.com/creator2" })
        .expect(201)
    ).body;

    await request(created.app)
      .patch(`/api/spy/profiles/${encodeURIComponent(p1.id)}`)
      .send({ tags: ["antiga", "fixa"] })
      .expect(200);

    await request(created.app)
      .patch(`/api/spy/profiles/${encodeURIComponent(p2.id)}`)
      .send({ tags: ["antiga"] })
      .expect(200);

    const renameRes = await request(created.app)
      .patch("/api/spy/tags/antiga")
      .send({ name: "renomeada" })
      .expect(200);

    expect(renameRes.body.name).toBe("renomeada");
    expect(renameRes.body.affected).toBe(2);

    const p1After = (await request(created.app).get("/api/spy/profiles")).body.profiles.find(
      (p: any) => p.id === p1.id
    );
    expect(p1After.tags).toEqual(["renomeada", "fixa"]);

    const p2After = (await request(created.app).get("/api/spy/profiles")).body.profiles.find(
      (p: any) => p.id === p2.id
    );
    expect(p2After.tags).toEqual(["renomeada"]);
  });

  it("deletes a tag and strips it from all profiles", async () => {
    const p = (
      await request(created.app)
        .post("/api/spy/profiles")
        .send({ url: "https://www.instagram.com/creator1" })
        .expect(201)
    ).body;

    await request(created.app)
      .patch(`/api/spy/profiles/${encodeURIComponent(p.id)}`)
      .send({ tags: ["para_remover", "manter"] })
      .expect(200);

    await request(created.app).delete("/api/spy/tags/para_remover").expect(200);

    const tagsList = (await request(created.app).get("/api/spy/tags")).body.tags;
    expect(tagsList.some((t: any) => t.name === "para_remover")).toBe(false);

    const pAfter = (await request(created.app).get("/api/spy/profiles")).body.profiles.find(
      (item: any) => item.id === p.id
    );
    expect(pAfter.tags).toEqual(["manter"]);
  });

  it("keeps tags and notes when a removed profile is saved again within 7 days", async () => {
    const p = (await request(created.app).post("/api/spy/profiles").send({ url: "https://www.instagram.com/creator2" }).expect(201)).body;
    await request(created.app).patch(`/api/spy/profiles/${encodeURIComponent(p.id)}`).send({ tags: ["test_tag"], notes: "Nota" }).expect(200);
    await request(created.app).delete(`/api/spy/profiles/${encodeURIComponent(p.id)}`).expect(200);

    const restored = (await request(created.app).post("/api/spy/profiles").send({ url: "https://www.instagram.com/creator2" }).expect(200)).body;
    expect(restored.tags).toEqual(["test_tag"]);
    expect(restored.notes).toBe("Nota");
  });

  it("resets tags and notes once the 7 days have passed", async () => {
    const p = (
      await request(created.app)
        .post("/api/spy/profiles")
        .send({ url: "https://www.instagram.com/creator1" })
        .expect(201)
    ).body;

    await request(created.app)
      .patch(`/api/spy/profiles/${encodeURIComponent(p.id)}`)
      .send({ tags: ["test_tag"], notes: "Minha nota secreta" })
      .expect(200);

    // Remove profile, and let the undo window run out
    await request(created.app)
      .delete(`/api/spy/profiles/${encodeURIComponent(p.id)}`)
      .expect(200);
    purgeRemoved(created.database, Date.now() + SPY_REMOVED_KEEP_MS + 1);

    // Re-add profile
    const pRecreated = (
      await request(created.app)
        .post("/api/spy/profiles")
        .send({ url: "https://www.instagram.com/creator1" })
        .expect(201)
    ).body;

    expect(pRecreated.tags).toEqual([]);
    expect(pRecreated.notes).toBe("");
  });
});

// Local: there are no AI reports, so no report rule (hub-only).
describe.skip("report tags rule", () => {
  it("accepts only catalog tags, in the catalog's spelling, once each", async () => {
    await request(created.app).post("/api/spy/tags").send({ names: ["Appyon"] });
    const ok = await request(created.app).patch("/api/analyses/settings").send({ reportTags: ["appyon", "APPYON"] }).expect(200);
    expect(ok.body.settings.reportTags).toEqual(["Appyon"]);
    const bad = await request(created.app).patch("/api/analyses/settings").send({ reportTags: ["nope"] }).expect(400);
    expect(bad.body).toEqual({ error: "unknown_tag", tag: "nope" });
    await request(created.app).patch("/api/analyses/settings").send({ reportTags: "appyon" }).expect(400);
    await request(created.app).patch("/api/analyses/settings").send({ reportTags: ["appyon", 3] }).expect(400);
    expect((await request(created.app).get("/api/analyses/status")).body.settings.reportTags).toEqual(["Appyon"]);
  });

  it("renames the tag inside the rule too, and merges when the new name exists", async () => {
    await request(created.app).post("/api/spy/tags").send({ names: ["appyon", "avatar"] });
    await request(created.app).patch("/api/analyses/settings").send({ reportTags: ["appyon", "avatar"] }).expect(200);
    await request(created.app).patch("/api/spy/tags/appyon").send({ name: "ia" }).expect(200);
    expect((await request(created.app).get("/api/analyses/status")).body.settings.reportTags).toEqual(["ia", "avatar"]);
    await request(created.app).patch("/api/spy/tags/ia").send({ name: "avatar" }).expect(200);
    expect((await request(created.app).get("/api/analyses/status")).body.settings.reportTags).toEqual(["avatar"]);
  });

  it("refuses to delete a tag that is in the rule", async () => {
    await request(created.app).post("/api/spy/tags").send({ names: ["appyon", "real"] });
    await request(created.app).patch("/api/analyses/settings").send({ reportTags: ["appyon"] }).expect(200);
    const res = await request(created.app).delete("/api/spy/tags/APPYON").expect(409);
    expect(res.body).toEqual({ error: "tag_in_report_rule" });
    expect((await request(created.app).get("/api/spy/tags")).body.tags.map((t: { name: string }) => t.name)).toEqual(["appyon", "real"]);
    expect((await request(created.app).get("/api/analyses/status")).body.settings.reportTags).toEqual(["appyon"]);
    await request(created.app).delete("/api/spy/tags/real").expect(200);
  });
});
