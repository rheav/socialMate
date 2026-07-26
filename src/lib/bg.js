// One place to talk to the service worker from the panel.
//
// Every tool pane used to carry its own `bg()`:
//
//   const bg = (msg) => new Promise((r) =>
//     chrome.runtime.sendMessage(msg, (res) => r(res || { ok: false })));
//
// which has two bugs that made a failed download look like a successful one:
//
//   1. it never read chrome.runtime.lastError, so Chrome logged "Unchecked
//      runtime.lastError" and a dead/asleep worker resolved as {ok:false};
//   2. nobody checked the resolved `.ok` — only a *thrown* exception reached the
//      caller's catch, and this promise never rejects. So the button went green
//      whether the file landed on disk or not.
//
// sendBg() keeps the never-rejects shape (callers rely on it) but always returns
// a real {ok, error}. Use requireOk() when you want the failure to throw so an
// existing try/catch reports it.
export function sendBg(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        const err = chrome.runtime.lastError; // MUST be read, or Chrome warns
        if (err) return resolve({ ok: false, error: err.message });
        if (res == null)
          return resolve({ ok: false, error: "sem resposta do serviço" });
        // A handler that answers without an explicit `ok` is treated as success:
        // several background routes reply {started:true} / {videoId}.
        resolve("ok" in res ? res : { ok: true, ...res });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e?.message || e) });
    }
  });
}

// Same call, but a non-ok reply throws — for call sites already wrapped in
// try/catch that set an "error" status.
export async function requireOk(msg) {
  const res = await sendBg(msg);
  if (!res.ok) throw new Error(res.error || "falhou");
  return res;
}
