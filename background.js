const PDF_REGEX =
  "^https?://.*(?:\\.pdf(?:\\?.*)?|arxiv\\.org/pdf/.*|/pdf/.*)$";

async function setupRedirectRules() {
  const extensionId = chrome.runtime.id;
  const viewerUrl = chrome.runtime.getURL("index.html");

  const rules = [
    {
      id: 1,
      priority: 1,
      action: {
        type: "redirect",
        redirect: {
          regexSubstitution: `${viewerUrl}?file=\\0`,
        },
      },
      condition: {
        regexFilter: PDF_REGEX,
        resourceTypes: ["main_frame"],
      },
    },
  ];

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: rules,
  });

  console.log("PDF Redirect rules initialized");
}

// Initialize on install or startup
chrome.runtime.onInstalled.addListener(setupRedirectRules);
chrome.runtime.onStartup.addListener(setupRedirectRules);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "FETCH_PDF") {
    fetch(message.query)
      .then((response) => response.arrayBuffer())
      .then((buffer) => {
        sendResponse({ data: Array.from(new Uint8Array(buffer)) });
      })
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "FETCH_SCHOLAR") {
    fetchGoogleScholar(message.query)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "FETCH_CITE") {
    fetchGoogleScholarCite(message.query)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
});

async function fetchGoogleScholar(query) {
  const searchUrl = `https://scholar.google.com/scholar?q=${encodeURIComponent(query)}&hl=en`;

  const response = await fetch(searchUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!response.ok) {
    throw new Error(`Scholar request failed: ${response.status}`);
  }

  const html = await response.text();
  return { html, query };
}

async function fetchGoogleScholarCite(query) {
  const searchUrl = `https://scholar.google.com/scholar?q=info:${query}:scholar.google.com&output=cite`;

  const response = await fetch(searchUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!response.ok) {
    throw new Error(`Scholar request failed: ${response.status}`);
  }

  const html = await response.text();
  return { html, query };
}

chrome.webNavigation.onBeforeNavigate.addListener(function(details) {
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
