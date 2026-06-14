import { ingestFile } from "./src/ingest.js";

// Firefox destroys the toolbar popup the instant a native file dialog steals
// focus, so a file <input> hosted here never fires `change`. Chrome/Safari
// keep the popup alive, so they can pick inline. Branch on the build target.
const IS_FIREFOX = __TARGET__ === "firefox";

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

  openPdfBtn.addEventListener("click", async () => {
    // Firefox: route to the viewer's empty state, which hosts the picker in a
    // persistent tab that survives the file dialog. Chrome/Safari: pick inline
    // for the original one-click experience.
    if (IS_FIREFOX) {
      await chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
      window.close();
      return;
    }
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

  // Chrome/Safari one-click path: the popup stays alive across the file dialog,
  // so park the bytes and open the viewer straight from here.
  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      await ingestFile(file);
      await chrome.tabs.create({
        url: chrome.runtime.getURL("index.html"),
      });
      window.close();
    } catch (error) {
      console.error("[Hover/popup] Error loading PDF:", error);
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
});
