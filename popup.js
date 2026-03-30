document.addEventListener("DOMContentLoaded", async () => {
  const toggle = document.getElementById("toggle-enabled");
  const statusText = document.getElementById("status-text");
  const container = document.querySelector(".popup-container");
  const openPdfBtn = document.getElementById("open-pdf-btn");
  const fileInput = document.getElementById("file-input");

  const { hoverEnabled = true } =
    await chrome.storage.local.get("hoverEnabled");
  toggle.checked = hoverEnabled;
  updateUI(hoverEnabled);

  toggle.addEventListener("change", async () => {
    const enabled = toggle.checked;
    await chrome.storage.local.set({ hoverEnabled: enabled });
    updateUI(enabled);

    const response = await chrome.runtime.sendMessage({
      type: "TOGGLE_HOVER",
      enabled,
    });

    if (!enabled && response?.currentPdfUrl) {
      const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      const activeTab = tabs[0];

      if (activeTab?.url?.includes(chrome.runtime.getURL(""))) {
        chrome.tabs.update(activeTab.id, { url: response.currentPdfUrl });
      }
    }
  });

  openPdfBtn.addEventListener("click", () => {
    fileInput.click();
  });

  const openTabBtn = document.getElementById("open-tab-btn");

  openTabBtn.addEventListener("click", async () => {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab?.url) return;

      if (
        tab.url.startsWith("chrome://") ||
        tab.url.startsWith("chrome-extension://") ||
        tab.url.startsWith("about:")
      ) {
        openTabBtn.textContent = "Cannot open this page";
        setTimeout(() => {
          openTabBtn.innerHTML = openTabBtnOriginalHTML;
        }, 2000);
        return;
      }

      openTabBtn.textContent = "Opening…";
      openTabBtn.disabled = true;

      const response = await chrome.runtime.sendMessage({
        type: "FETCH_TAB_AS_PDF",
        url: tab.url,
        tabId: tab.id,
      });

      if (response?.success) {
        window.close();
      } else {
        openTabBtn.textContent = response?.error || "Failed to open";
        openTabBtn.disabled = false;
        setTimeout(() => {
          openTabBtn.innerHTML = openTabBtnOriginalHTML;
        }, 2000);
      }
    } catch (error) {
      console.error("Error opening tab as PDF:", error);
      openTabBtn.textContent = "Error";
      openTabBtn.disabled = false;
      setTimeout(() => {
        openTabBtn.innerHTML = openTabBtnOriginalHTML;
      }, 2000);
    }
  });

  const openTabBtnOriginalHTML = openTabBtn.innerHTML;

  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file || file.type !== "application/pdf") return;

    try {
      const arrayBuffer = await file.arrayBuffer();
      const base64 = arrayBufferToBase64(arrayBuffer);

      await chrome.runtime.sendMessage({
        type: "STORE_LOCAL_PDF",
        data: base64,
        name: file.name,
      });

      const viewerUrl = chrome.runtime.getURL("index.html");
      chrome.tabs.create({ url: viewerUrl });

      window.close();
    } catch (error) {
      console.error("Error loading PDF:", error);
    }
  });

  function updateUI(enabled) {
    if (enabled) {
      statusText.textContent = "Active - PDF files open in Hover";
      statusText.classList.remove("disabled");
      container.classList.remove("disabled");
    } else {
      statusText.textContent = "Disabled - Using default reader";
      statusText.classList.add("disabled");
      container.classList.add("disabled");
    }
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }
});
