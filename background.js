// Intercept PDF requests and redirect to our viewer
chrome.webRequest.onBeforeRequest.addListener(
  function (details) {
    if (details.type === "main_frame" && isPdfUrl(details.url)) {
      const viewerUrl =
        chrome.runtime.getURL("index.html") +
        "?file=" +
        encodeURIComponent(details.url);
      return { redirectUrl: viewerUrl };
    }
  },
  {
    urls: ["<all_urls>"],
    types: ["main_frame"],
  },
  ["blocking"],
);

chrome.webNavigation.onBeforeNavigate.addListener(function (details) {
  if (details.frameId === 0 && isPdfUrl(details.url)) {
    const viewerUrl =
      chrome.runtime.getURL("index.html") +
      "?file=" +
      encodeURIComponent(details.url);
    chrome.tabs.update(details.tabId, { url: viewerUrl });
  }
});

function isPdfUrl(url) {
  if (url.toLowerCase().endsWith(".pdf")) {
    return true;
  }

  const pdfPatterns = [/arxiv\.org\/pdf\//, /\.pdf$/i, /\/pdf\//];

  return pdfPatterns.some((pattern) => pattern.test(url));
}
