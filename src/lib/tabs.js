// Resolve which browser tab a platform tool should drive. Extracted from App.jsx
// so Warm and IG-Sort (and future tools) share one implementation.
export const PLATFORM_HOST = {
  facebook: { re: /(^|\.)facebook\.com$/, glob: ["*://*.facebook.com/*"] },
  instagram: { re: /(^|\.)instagram\.com$/, glob: ["*://*.instagram.com/*"] },
  tiktok: { re: /(^|\.)tiktok\.com$/, glob: ["*://*.tiktok.com/*"] },
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
