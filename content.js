// Content script for detecting PDF downloads
console.log("Hover PDF Reader content script loaded");

// Listen for PDF downloads
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PDF_DETECTED") {
    console.log("PDF detected:", message.url);
  }
});
