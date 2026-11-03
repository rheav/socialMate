// "Fontes" button on the Instagram and TikTok rails (private build): sends a
// post's photos to ugc-factory's "Fontes de look" library through the worker
// (FBW_FONTES_SEND → background/fontes.js). INLINED into the rails' @private
// regions — see this dir's README before editing (only a sibling import).
import { railSay } from "./railTheme.js";

/**
 * Send each photo in turn. Stops at the first refusal, since the rest would meet
 * the same closed app or the same server error. A thrown error (the extension
 * was reloaded under this page) propagates to the caller.
 */
export async function fontesSend(urls, origin, pageUrl, send = (m) => chrome.runtime.sendMessage(m)) {
  let added = 0;
  let dup = 0;
  for (const url of urls) {
    const res = await send({ type: "FBW_FONTES_SEND", url, origin, pageUrl });
    if (!res || !res.ok) return { added, dup, error: (res && res.error) || "server" };
    if (res.duplicate) dup += 1;
    else added += 1;
  }
  return { added, dup, error: null };
}

/** What the button says afterwards, and in which tone. */
export function fontesVerdict({ added, dup, error }) {
  if (error === "app") return { text: "Abra o UGC Factory", tone: "warn" };
  if (error) return { text: error === "fetch" ? "Não baixou a foto" : "Falhou", tone: "err" };
  if (added + dup === 1) return added ? { text: "Nas Fontes", tone: "ok" } : { text: "Já estava nas Fontes", tone: "dim" };
  if (!added) return { text: `As ${dup} já estavam nas Fontes`, tone: "dim" };
  return { text: dup ? `${added} nas Fontes, ${dup} já estava${dup > 1 ? "m" : ""}` : `${added} nas Fontes`, tone: "ok" };
}

/** The button's name: what it is about to send. */
export function fontesLabel(count, isVideo) {
  if (count > 1) return `Mandar as ${count} fotos às Fontes`;
  return isVideo ? "Mandar a capa às Fontes" : "Mandar a foto às Fontes";
}

/** The click: a spinner and "Enviando…" while it goes, then the verdict beside the button. */
export function fontesClick(btn, urls, origin, pageUrl) {
  if (btn.classList.contains("busy")) return;
  btn.classList.add("busy");
  railSay(btn, urls.length > 1 ? `Enviando ${urls.length} fotos…` : "Enviando…", "", 120000);
  fontesSend(urls, origin, pageUrl)
    .then(fontesVerdict, () => ({ text: "Recarregue a página", tone: "err" })) // this page's chrome.* died with an extension reload
    .then(({ text, tone }) => {
      btn.classList.remove("busy");
      railSay(btn, text, tone);
    });
}
