document.getElementById("ver").textContent =
  "v" + (chrome.runtime.getManifest().version_name || chrome.runtime.getManifest().version);

document.getElementById("open").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && /https:\/\/(www|web)\.facebook\.com\//.test(tab.url || "")) {
    chrome.tabs.reload(tab.id);
  } else {
    chrome.tabs.create({ url: "https://www.facebook.com/watch" });
  }
  window.close();
});
