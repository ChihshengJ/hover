const PDF_REGEX =
  "^https?://.*(?:\\.pdf(?:\\?.*)?|arxiv\\.org/pdf/.*|/pdf/.*)$";

// ============================================
// Redirect Rules Management
// ============================================

async function setupRedirectRules() {
  // Check if Hover is enabled
  const { hoverEnabled = true } = await chrome.storage.local.get('hoverEnabled');
  
  if (hoverEnabled) {
    await enableRedirectRules();
  } else {
    await disableRedirectRules();
  }
  
  console.log(`Hover PDF: ${hoverEnabled ? 'Enabled' : 'Disabled'}`);
}

async function enableRedirectRules() {
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

  console.log("PDF Redirect rules enabled");
}

async function disableRedirectRules() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [],
  });

  console.log("PDF Redirect rules disabled");
}

// ============================================
// Navigation Interception (for enabled state)
// ============================================

let navigationListener = null;

function setupNavigationListener() {
  if (navigationListener) return;
  
  navigationListener = async function(details) {
    // Check if enabled before intercepting
    const { hoverEnabled = true } = await chrome.storage.local.get('hoverEnabled');
    if (!hoverEnabled) return;
    
    if (details.frameId === 0 && isPdfUrl(details.url)) {
      const viewerUrl =
        chrome.runtime.getURL("index.html") +
        "?file=" +
        encodeURIComponent(details.url);
      chrome.tabs.update(details.tabId, { url: viewerUrl });
    }
  };
  
  chrome.webNavigation.onBeforeNavigate.addListener(navigationListener);
}

function removeNavigationListener() {
  if (navigationListener) {
    chrome.webNavigation.onBeforeNavigate.removeListener(navigationListener);
    navigationListener = null;
  }
}

function isPdfUrl(url) {
  if (url.toLowerCase().endsWith(".pdf")) {
    return true;
  }
  const pdfPatterns = [/arxiv\.org\/pdf\//, /\.pdf$/i, /\/pdf\//];
  return pdfPatterns.some((pattern) => pattern.test(url));
}

// ============================================
// Initialization
// ============================================

// Initialize on install or startup
chrome.runtime.onInstalled.addListener(async () => {
  // Set default enabled state on first install
  const { hoverEnabled } = await chrome.storage.local.get('hoverEnabled');
  if (hoverEnabled === undefined) {
    await chrome.storage.local.set({ hoverEnabled: true });
  }
  await setupRedirectRules();
  setupNavigationListener();
});

chrome.runtime.onStartup.addListener(async () => {
  await setupRedirectRules();
  const { hoverEnabled = true } = await chrome.storage.local.get('hoverEnabled');
  if (hoverEnabled) {
    setupNavigationListener();
  }
});

// Also set up on service worker activation
(async () => {
  await setupRedirectRules();
  const { hoverEnabled = true } = await chrome.storage.local.get('hoverEnabled');
  if (hoverEnabled) {
    setupNavigationListener();
  }
})();

// ============================================
// Message Handlers
// ============================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "TOGGLE_HOVER") {
    handleToggle(message.enabled)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
  
  if (message.type === "FETCH_PDF") {
    fetch(message.query)
      .then((response) => response.arrayBuffer())
      .then((buffer) => {
        sendResponse({ data: Array.from(new Uint8Array(buffer)) });
      })
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
  
  if (message.type === "FETCH_SCHOLAR") {
    fetchGoogleScholar(message.query)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (message.type === "FETCH_CITE") {
    fetchGoogleScholarCite(message.query)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (message.type === "FETCH_WEB") {
    fetchWebsite(message.query)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (message.type === "STORE_LOCAL_PDF") {
    // Store PDF data for the viewer to access
    // Using a different approach since service workers can't use sessionStorage
    localPdfData = {
      data: message.data,
      name: message.name
    };
    sendResponse({ success: true });
    return true;
  }
  
  if (message.type === "GET_LOCAL_PDF") {
    sendResponse({ 
      success: true, 
      data: localPdfData 
    });
    localPdfData = null; // Clear after retrieval
    return true;
  }
  
  if (message.type === "GET_HOVER_STATUS") {
    chrome.storage.local.get('hoverEnabled')
      .then(({ hoverEnabled = true }) => {
        sendResponse({ enabled: hoverEnabled });
      });
    return true;
  }
});

// Temporary storage for local PDF data (since service workers can't use sessionStorage)
let localPdfData = null;

async function handleToggle(enabled) {
  // Save state
  await chrome.storage.local.set({ hoverEnabled: enabled });
  
  // Update redirect rules
  if (enabled) {
    await enableRedirectRules();
    setupNavigationListener();
  } else {
    await disableRedirectRules();
    removeNavigationListener();
  }
  
  // Check if there's a currently open Hover viewer tab with a PDF
  const viewerUrl = chrome.runtime.getURL("index.html");
  const tabs = await chrome.tabs.query({});
  
  let currentPdfUrl = null;
  for (const tab of tabs) {
    if (tab.url && tab.url.startsWith(viewerUrl)) {
      const url = new URL(tab.url);
      currentPdfUrl = url.searchParams.get('file');
      break;
    }
  }
  
  return { 
    success: true, 
    enabled,
    currentPdfUrl 
  };
}

// ============================================
// Scholar Fetch Functions
// ============================================

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

async function fetchGoogleScholarCite(paperId) {
  const citeUrl = `https://scholar.google.com/scholar?q=info:${paperId}:scholar.google.com/&output=cite&hl=en`;

  const response = await fetch(citeUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!response.ok) {
    throw new Error(`Citation request failed: ${response.status}`);
  }

  const html = await response.text();
  return { html, paperId };
}

async function fetchWebsite(query) {
  const response = await fetch(query, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!response.ok) {
    throw new Error(`${query} request failed: ${response.status}`);
  }

  const html = await response.text();
  return { html, query };
}
