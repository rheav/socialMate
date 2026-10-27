// A throwaway Chrome for Testing (headless, its own profile) driven over raw CDP.
// Never the shared Chrome: store captures must not touch the owner's browser or accounts.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CFT = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ extension, port = 9334 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "socialmate-store-"));
  const args = [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--headless=new", "--no-first-run",
    "--no-default-browser-check", "--hide-scrollbars", "--lang=pt-BR",
    // Nothing reaches Meta from a capture run, whatever the Spy decides to do.
    "--host-resolver-rules=MAP *.instagram.com 127.0.0.1, MAP *.facebook.com 127.0.0.1, MAP *.fbcdn.net 127.0.0.1, MAP *.cdninstagram.com 127.0.0.1"];
  if (extension) args.push(`--disable-extensions-except=${extension}`, `--load-extension=${extension}`);
  const proc = spawn(CFT, [...args, "about:blank"], { stdio: "ignore" });
  let version;
  for (let i = 0; i < 50 && !version; i++) {
    await wait(200);
    version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null);
  }
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const pend = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((r) => { const id = ++n; pend.set(id, r); ws.send(JSON.stringify({ id, method, params, sessionId })); });

  let extId = null;
  if (extension) {
    for (let i = 0; i < 30 && !extId; i++) {
      await wait(300);
      const { result } = await send("Target.getTargets");
      const sw = result.targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/service-worker-loader.js"));
      if (sw) extId = new URL(sw.url).host;
    }
    if (!extId) throw new Error("extension service worker not found");
  }

  async function open(url, { width = 1280, height = 800, scale = 1 } = {}) {
    const { result: { targetId } } = await send("Target.createTarget", { url: "about:blank" });
    const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false }, sessionId);
    await send("Page.navigate", { url }, sessionId);
    await wait(1800);
    const ev = async (expression) => {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval failed");
      return r.result?.result?.value;
    };
    const shot = async (opts = {}) => Buffer.from((await send("Page.captureScreenshot", { format: "png", ...opts }, sessionId)).result.data, "base64");
    const close = () => send("Target.closeTarget", { targetId });
    return { ev, shot, close, sessionId };
  }

  async function close() {
    ws.close();
    proc.kill();
    await wait(500);
    rmSync(profile, { recursive: true, force: true });
  }
  return { extId, open, close, send };
}
