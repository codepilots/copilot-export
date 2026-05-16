importScripts('security.js');

// Seed storage with security defaults on first install or update.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(SECURITY_DEFAULTS, stored => {
    const update = {};
    if (!stored.approvedImageHosts) update.approvedImageHosts = SECURITY_DEFAULTS.approvedImageHosts;
    if (!stored.approvedTabHosts)   update.approvedTabHosts   = SECURITY_DEFAULTS.approvedTabHosts;
    if (Object.keys(update).length) chrome.storage.sync.set(update);
  });
});

// MIME types this extension is allowed to write to disk — one per export format.
const ALLOWED_DOWNLOAD_MIME = new Set([
  'text/markdown',
  'application/json',
  'text/plain',
  'text/html',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

// A safe, single-segment relative filename: word chars, dot, dash, space only.
// Rejects path separators, traversal, control chars and absolute paths.
function isSafeDownloadFilename(name) {
  return typeof name === 'string' &&
    name.length > 0 && name.length <= 200 &&
    /^[A-Za-z0-9._ -]+$/.test(name) &&
    !name.includes('..');
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  // ── Sender authentication ──────────────────────────────────────────────────
  // Only accept messages originating from this extension's own pages
  // (popup / options). Rejects content scripts, web pages and other extensions.
  const fromOwnPage = sender.id === chrome.runtime.id &&
    typeof sender.url === 'string' &&
    sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`);
  if (!fromOwnPage) {
    sendResponse({ success: false, error: 'Unauthorized sender.' });
    return;
  }

  // ── File download ──────────────────────────────────────────────────────────
  if (request.action === 'download') {
    const { content, filename, mimeType, isBase64 } = request;
    if (typeof content !== 'string' ||
        !ALLOWED_DOWNLOAD_MIME.has(mimeType) ||
        !isSafeDownloadFilename(filename)) {
      sendResponse({ success: false, error: 'Invalid download request.' });
      return;
    }
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
  // The URL is validated against the approved image host list before fetching.
  if (request.action === 'fetchImageAsBase64') {
    const { url } = request;
    chrome.storage.sync.get(
      { approvedImageHosts: SECURITY_DEFAULTS.approvedImageHosts },
      ({ approvedImageHosts }) => {
        if (!isApprovedUrl(url, approvedImageHosts)) {
          let hostname = url;
          try { hostname = new URL(url).hostname; } catch {}
          sendResponse({
            success: false,
            blocked: true,
            error: `Blocked: "${hostname}" is not in the approved image server list.`,
          });
          return;
        }
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
      }
    );
    return true;
  }

});
