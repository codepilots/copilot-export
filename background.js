chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {

  // ── File download ──────────────────────────────────────────────────────────
  if (request.action === 'download') {
    const { content, filename, mimeType, isBase64 } = request;
    const b64 = isBase64 ? content : btoa(unescape(encodeURIComponent(content)));
    const dataUrl = `data:${mimeType};base64,${b64}`;
    chrome.downloads.download({ url: dataUrl, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true, downloadId });
      }
    });
    return true;
  }

  // ── Fetch image with auth cookies and return as base64 data URL ────────────
  // The service worker context sends cookies for the target domain, which
  // the print page (null-origin srcdoc iframe) cannot do on its own.
  if (request.action === 'fetchImageAsBase64') {
    const { url } = request;
    fetch(url, { credentials: 'include' })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then(blob => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => resolve(reader.result);   // data:image/...;base64,...
        reader.onerror = () => reject(new Error('FileReader failed'));
        reader.readAsDataURL(blob);
      }))
      .then(dataUrl => sendResponse({ success: true, dataUrl }))
      .catch(err   => sendResponse({ success: false, error: err.message }));
    return true;
  }

});
