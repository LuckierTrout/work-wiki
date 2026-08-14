const titleInput = document.querySelector("#title");
const urlInput = document.querySelector("#url");
const tagsInput = document.querySelector("#tags");
const message = document.querySelector("#message");
const saveButton = document.querySelector("#save");

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  titleInput.value = tab?.title ?? "";
  urlInput.value = /^https?:/.test(tab?.url ?? "") ? tab.url : "";
});

chrome.storage.local.get(["workwikiDefaultTags"], (stored) => {
  tagsInput.value = stored.workwikiDefaultTags ?? "";
});

saveButton.addEventListener("click", async () => {
  message.textContent = "";
  let url;
  try { url = new URL(urlInput.value); } catch { message.textContent = "Enter a valid page URL."; return; }
  if (!/^https?:$/.test(url.protocol)) { message.textContent = "Only web pages can be captured."; return; }
  const capture = new URL("https://workwiki.app/save");
  capture.searchParams.set("url", url.toString());
  if (titleInput.value.trim()) capture.searchParams.set("title", titleInput.value.trim());
  if (tagsInput.value.trim()) capture.searchParams.set("tags", tagsInput.value.trim());
  await chrome.storage.local.set({ workwikiDefaultTags: tagsInput.value.trim() });
  saveButton.disabled = true;
  await chrome.windows.create({ url: capture.toString(), type: "popup", width: 560, height: 760 });
  window.close();
});
