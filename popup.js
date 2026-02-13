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

    // If disabling and a PDF is currently open in Hover, redirect to the
    // original PDF URL so the browser's native reader takes over.
    if (!enabled && response?.currentPdfUrl) {
      const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      const activeTab = tabs[0];

      if (activeTab?.url?.includes(chrome.runtime.getURL(""))) {
        // Redirect to the original PDF URL
        chrome.tabs.update(activeTab.id, { url: response.currentPdfUrl });
      }
    }
  });

  openPdfBtn.addEventListener("click", () => {
    fileInput.click();
  });

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
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
});
