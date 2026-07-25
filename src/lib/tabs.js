// Resolve which browser tab a platform tool should drive. Extracted from App.jsx
// so Warm and IG-Sort (and future tools) share one implementation.
export const PLATFORM_HOST = {
  facebook: { re: /(^|\.)facebook\.com$/, glob: ["*://*.facebook.com/*"] },
  instagram: { re: /(^|\.)instagram\.com$/, glob: ["*://*.instagram.com/*"] },
  tiktok: { re: /(^|\.)tiktok\.com$/, glob: ["*://*.tiktok.com/*"] },
  // Deliberately kept in lockstep with host_permissions/manifest.config.js, which
  // injects pin-api.js on *://*.pinterest.com/* ONLY — Chrome match patterns can't
  // wildcard a TLD, so unlike facebook/instagram/tiktok above this can't be widened
  // to Pinterest's country domains (pinterest.co.uk, pinterest.com.au, pinterest.fr)
  // without a manifest change too. Widening just the regex would make the panel
  // adopt a tab it has no content script to talk to: sendMessage rejects silently and
  // the panel is stuck on "Reading the page…" with no diagnostic. .com subdomains
  // (br.pinterest.com, etc.) still match, since those ARE covered by the manifest glob.
  pinterest: { re: /(^|\.)pinterest\.com$/, glob: ["*://*.pinterest.com/*"] },
};

export const matchesPlatform = (platform, url) => {
  try {
    return PLATFORM_HOST[platform].re.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

export const hasChromeTabs = () =>
  typeof chrome !== "undefined" && !!chrome?.tabs?.query;

export async function resolvePlatformTab(platform) {
  if (!hasChromeTabs()) return null;
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && matchesPlatform(platform, active.url || "")) return active.id;
  const tabs = await chrome.tabs.query({ url: PLATFORM_HOST[platform].glob });
  return tabs.length ? tabs[0].id : null;
}

// The platform (facebook/instagram/tiktok) of the currently active tab, or null.
export async function detectActivePlatform() {
  if (!hasChromeTabs()) return null;
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = active?.url || "";
  for (const p of Object.keys(PLATFORM_HOST))
    if (matchesPlatform(p, url)) return p;
  return null;
}
