import { ingestFile } from "./src/platform/ingest.js";

// Firefox destroys the toolbar popup the instant a native file dialog steals
// focus, so a file <input> hosted here never fires `change`. Chrome/Safari
// keep the popup alive, so they can pick inline. Branch on the build target.
const IS_FIREFOX = __TARGET__ === "firefox";

const ALL_SITES = { origins: ["<all_urls>"] };

// Where to send the user when the browser won't prompt for site access.
const SITE_ACCESS_HELP =
  __TARGET__ === "firefox"
    ? 'Turn on "Access your data for all websites" in about:addons → Hover PDF → Permissions.'
    : __TARGET__ === "safari"
      ? 'Open Safari → Settings → Extensions → Hover PDF and set "Other websites" to Allow.'
      : 'Set "Site access" to "On all sites" on Hover\'s extension page.';

document.addEventListener("DOMContentLoaded", async () => {
  const toggle = document.getElementById("toggle-enabled") as HTMLInputElement;
  const statusText = document.getElementById("status-text");
  const container = document.querySelector(".popup-container");
  const openPdfBtn = document.getElementById(
    "open-pdf-btn",
  ) as HTMLButtonElement;
  const fileInput = document.getElementById("file-input") as HTMLInputElement;

  const { hoverEnabled = true } =
    await chrome.storage.local.get("hoverEnabled");
  toggle.checked = Boolean(hoverEnabled);
  updateUI(Boolean(hoverEnabled));

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

  const accessSection = document.getElementById("access-section");
  const accessText = document.getElementById("access-text");
  const grantAccessBtn = document.getElementById(
    "grant-access-btn",
  ) as HTMLButtonElement;

  try {
    accessSection.hidden = await chrome.permissions.contains(ALL_SITES);
  } catch {
    // Can't tell; don't nag.
  }

  grantAccessBtn.addEventListener("click", () => {
    // Call request() synchronously from the click: browsers only show the
    // prompt during a user gesture. Firefox may close the popup when the prompt
    // appears; the grant still lands and the badge clears on its own.
    chrome.permissions
      .request(ALL_SITES)
      .then((granted) => {
        if (granted) accessSection.hidden = true;
      })
      .catch(() => {
        // Not requestable from here: hand over to the settings page where
        // the browser has one we can open, written instructions otherwise.
        accessText.textContent = SITE_ACCESS_HELP;
        if (__TARGET__ === "chrome") {
          chrome.runtime.sendMessage({ type: "OPEN_EXTENSION_SETTINGS" });
        } else {
          grantAccessBtn.hidden = true;
        }
      });
  });

  const openTabBtn = document.getElementById(
    "open-tab-btn",
  ) as HTMLButtonElement;

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
    const file = (e.target as HTMLInputElement).files[0];
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

  function updateUI(enabled: boolean) {
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
