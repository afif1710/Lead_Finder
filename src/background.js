/* The toolbar button reveals the panel; no tab, storage, or download permission. */
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "MLF_SHOW_PANEL" });
    await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
  } catch {
    await chrome.action.setBadgeText({ tabId: tab.id, text: "Maps" });
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#23675a" });
    await chrome.action.setTitle({ tabId: tab.id, title: "Open Google Maps and refresh the tab to show Maps Lead Finder." });
  }
});
