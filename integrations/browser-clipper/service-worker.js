chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "save-to-workwiki",
    title: "Save page to WorkWiki",
    contexts: ["page", "link", "selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const sourceUrl = info.linkUrl || tab?.url;
  if (!sourceUrl || !/^https?:/.test(sourceUrl)) return;
  const capture = new URL("https://workwiki.app/save");
  capture.searchParams.set("url", sourceUrl);
  if (tab?.title) capture.searchParams.set("title", tab.title);
  if (info.selectionText) capture.searchParams.set("text", `${info.selectionText}\n${sourceUrl}`);
  chrome.windows.create({ url: capture.toString(), type: "popup", width: 560, height: 760 });
});
