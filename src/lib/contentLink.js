// ============================================================================
// PANEL → CONTENT-SCRIPT LINK — the one place that decides what a messaging
// failure MEANS and what the user is told about it.
//
// WHY this exists: every tool panel owned a private copy of
//
//     try { return await chrome.tabs.sendMessage(tabId, msg); } catch { return null; }
//
// so an unreachable content script produced literally nothing — no action, no
// error, no explanation. A user who clicked "Iniciar" on a Facebook tab that
// predated the last extension reload saw the panel do absolutely nothing and
// concluded the extension was broken. The engine was fine the whole time.
//
// The transport is shared, so the diagnosis and the recovery copy have to be
// shared too — nine panels inventing nine wordings for the same failure is how
// you end up with eight of them saying nothing at all.
//
// This module is deliberately PURE (no react, no chrome) so the policy below is
// unit-testable; useContentLink.js wires it to the browser and
// components/ui/ContentLinkBanner.jsx renders it.
// ============================================================================

export const LINK_OK = "ok";
export const LINK_NO_TAB = "no-tab"; // no tab of this platform is open at all
export const LINK_UNREACHABLE = "unreachable"; // tab exists, content script silent

// A BACKGROUND POLL must not scream on a single miss: an SPA navigation tears
// the content script down for a few hundred ms and it comes straight back, and
// a banner that blinks on every page change is noise people learn to ignore.
// A CLICK is the opposite — the user is standing there waiting on an answer, so
// one failure is reported at once (`userAction` below). That asymmetry is the
// whole fix: tolerate flapping, never swallow intent.
export const MISS_THRESHOLD = 3;

export const INITIAL_LINK = {
  status: LINK_OK,
  misses: 0, // consecutive failed sends
  error: null, // raw chrome error text from the last failure
  action: null, // pt-BR infinitive of what the user was trying to do, if any
  proven: false, // a send has actually gone through since the last reset
  flagged: false, // background's fbw_need_reload mirror
};

// Where a platform's "open a tab for me" recovery lands. Kept beside the rest of
// the link policy (and NOT in lib/tabs.js) because it is recovery UI, not tab
// resolution — tabs.js matches hosts, this navigates to one.
export const PLATFORM_HOME = {
  facebook: "https://www.facebook.com/",
  instagram: "https://www.instagram.com/",
  tiktok: "https://www.tiktok.com/",
  pinterest: "https://www.pinterest.com/",
};

/**
 * Fold one transport event into the link state.
 *
 * Events:
 *   { kind: "ok" }                                   a send round-tripped
 *   { kind: "no-tab", action? }                      no tab of this platform
 *   { kind: "miss", error?, userAction?, action? }   a send threw
 *   { kind: "flag", value }                          background ping verdict
 *   { kind: "reset" }                                platform switch / repaired
 */
export function nextLinkState(state = INITIAL_LINK, event = {}) {
  switch (event.kind) {
    case "ok":
      // Direct proof the tab is live. Wins over every weaker signal, including a
      // sticky fbw_need_reload written before this tab was repaired.
      return { ...INITIAL_LINK, status: LINK_OK, proven: true };

    case "no-tab":
      return {
        ...state,
        status: LINK_NO_TAB,
        misses: 0,
        error: null,
        action: event.action || null,
      };

    case "miss": {
      const misses = state.misses + 1;
      // A click reports immediately; a poll waits for the run of misses that
      // distinguishes "gone" from "navigating".
      const hard = !!event.userAction || misses >= MISS_THRESHOLD;
      return {
        status: hard
          ? LINK_UNREACHABLE
          : state.status === LINK_UNREACHABLE
            ? LINK_UNREACHABLE
            : LINK_OK,
        misses,
        error: event.error || null,
        action: event.action || null,
        // A confirmed break retires the old proof, so the background's flag is
        // allowed to speak again on the next tab activation.
        proven: hard ? false : state.proven,
        flagged: state.flagged,
      };
    }

    case "flag": {
      // The background's tabs.onActivated ping is a REAL signal and stays in
      // force — this only changes how it is presented. Two guards keep it from
      // crying wolf:
      //
      //   `initial` — the value already sitting in storage when the panel
      //   opened. Its age is unknown (it can be days old, since the flag is
      //   only rewritten on a tab activation) and our own first send settles
      //   the question within one poll tick, so it is RECORDED but never raises
      //   the banner. Recording still matters: it is what lets a successful
      //   send clear the stale key for everyone reading it.
      //
      //   `proven` — a live false→true transition IS a fresh verdict and may
      //   raise the banner, but not once a send of ours has gone through. The
      //   flag is global and one-shot; our traffic is current and tab-specific.
      if (!event.value) return { ...state, flagged: false };
      if (event.initial || state.proven || state.status === LINK_NO_TAB)
        return { ...state, flagged: true };
      return { ...state, flagged: true, status: LINK_UNREACHABLE };
    }

    case "reset":
      return { ...INITIAL_LINK };

    default:
      return state;
  }
}

// pt-BR banner copy. Lives here rather than in the component so the wording is
// covered by tests and cannot drift between tools.
//
// `action` is what the user was trying to do, as an infinitive phrase
// ("iniciar o aquecimento"); when present the headline names the thing that
// failed instead of describing the connection in the abstract.
export function linkCopy(status, platformName, action = null) {
  const name = platformName || "site";
  if (status === LINK_NO_TAB)
    return {
      tone: "warn",
      title: action
        ? `Não foi possível ${action}: nenhuma aba do ${name} está aberta.`
        : `Nenhuma aba do ${name} está aberta.`,
      detail: `Esta ferramenta controla uma aba do ${name} — abra uma para continuar.`,
      action: `Abrir o ${name}`,
      hint: `Abrir o ${name} em uma nova aba`,
    };
  if (status === LINK_UNREACHABLE)
    return {
      tone: "error",
      title: action
        ? `Não foi possível ${action}: a aba do ${name} perdeu a conexão com a extensão.`
        : `A aba do ${name} perdeu a conexão com a extensão.`,
      detail:
        "Isso acontece quando a extensão é atualizada ou recarregada com a aba já aberta. Reconecte a aba — suas configurações aqui não se perdem.",
      action: "Reconectar aba",
      hint: "Reinjetar a extensão na aba (e recarregá-la, se for preciso)",
    };
  return null;
}

// Chrome's messaging errors are English strings produced by the browser, not by
// us. Translate the ones we actually see; anything else passes through verbatim
// so a genuinely novel failure stays visible instead of hiding behind a generic
// "algo deu errado".
export function linkErrorText(error) {
  const raw = String(error ?? "").trim();
  if (!raw) return null;
  if (/Receiving end does not exist|Could not establish connection/i.test(raw))
    return "A aba não respondeu — o script da extensão não está ativo nela.";
  if (/message port closed/i.test(raw))
    return "A aba fechou a conexão antes de responder.";
  if (/No tab with id|tab was closed/i.test(raw)) return "A aba foi fechada.";
  if (/cannot be scripted|Cannot access|Extension manifest/i.test(raw))
    return "A extensão não tem permissão para agir nesta aba.";
  return raw;
}
