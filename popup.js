const exportBtn = document.getElementById('exportBtn');
const btnText   = document.getElementById('btnText');
const spinner   = document.getElementById('spinner');
const statusEl  = document.getElementById('status');

function setLoading(on) {
  exportBtn.disabled = on;
  btnText.textContent = on ? 'Exporting…' : 'Export chat';
  spinner.classList.toggle('hidden', !on);
}

function showStatus(type, message) {
  statusEl.className = `status ${type}`;
  statusEl.textContent = message;
  statusEl.classList.remove('hidden');
}

function getFormat() {
  return document.querySelector('input[name="format"]:checked')?.value || 'markdown';
}

document.querySelectorAll('.js-settings').forEach(link =>
  link.addEventListener('click', e => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  })
);

// On open, decide whether this tab is exportable and show the matching view.
// (When the popup is open, activeTab grants the current tab's URL even
// without the "tabs" permission.)
(async () => {
  const mainView = document.getElementById('mainView');
  const unavailableView = document.getElementById('unavailableView');
  let available = false;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const { approvedTabHosts } = await chrome.storage.sync.get({
      approvedTabHosts: SECURITY_DEFAULTS.approvedTabHosts,
    });
    available = !!tab?.url && isApprovedUrl(tab.url, approvedTabHosts);
  } catch {}
  mainView.classList.toggle('hidden', !available);
  unavailableView.classList.toggle('hidden', available);
})();

exportBtn.addEventListener('click', async () => {
  setLoading(true);
  statusEl.classList.add('hidden');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    showStatus('error', 'Could not access the current tab.');
    setLoading(false);
    return;
  }

  // Verify the active tab is on an approved domain before proceeding.
  const { approvedTabHosts } = await chrome.storage.sync.get({
    approvedTabHosts: SECURITY_DEFAULTS.approvedTabHosts,
  });
  if (!isApprovedUrl(tab.url, approvedTabHosts)) {
    let hostname = tab.url;
    try { hostname = new URL(tab.url).hostname; } catch {}
    showStatus('error',
      `Export blocked: "${hostname}" is not an approved domain. ` +
      `Open a Copilot chat on a supported Microsoft 365 site, or update the approved domains in Settings.`
    );
    setLoading(false);
    return;
  }

  try {
    // Step 1: reset cache and locate the scroll container robustly
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        window.__copilotExtractCache     = null;
        window.__copilotExtractCacheKeys = null;

        // Walk up from a message element — most reliable way to find the chat scroll container
        function findScrollEl() {
          const anchor = document.querySelector(
            '.fai-CopilotMessage__content, .fai-UserMessage__message'
          );
          if (anchor) {
            let el = anchor.parentElement;
            while (el && el !== document.documentElement) {
              const s = getComputedStyle(el);
              if ((s.overflowY === 'auto' || s.overflowY === 'scroll') &&
                   el.scrollHeight > el.clientHeight + 50) return el;
              el = el.parentElement;
            }
          }
          // Fallback: class name, then broad scan
          return document.querySelector('.fai-CopilotChat') ||
            [...document.querySelectorAll('*')].find(el => {
              if (el === document.body || el === document.documentElement) return false;
              const s = getComputedStyle(el);
              return (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
                     el.scrollHeight > el.clientHeight + 100 &&
                     el.clientHeight > 150;
            }) || document.documentElement;
        }

        window.__copilotScrollEl = findScrollEl();
      },
    });

    // Step 2: sweep UP incrementally so any lazy-loaded history gets fetched,
    // then settle at the top before the downward accumulation pass.
    // Each step scrolls up by ~80 % of the viewport and waits for content to render.
    const UP_PASSES = 60;
    for (let i = 0; i < UP_PASSES; i++) {
      const [ur] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: () => {
          const c = window.__copilotScrollEl;
          if (!c) return { atTop: true };
          const atTop = c.scrollTop <= 10;
          if (!atTop) c.scrollBy({ top: -Math.max(c.clientHeight * 0.8, 400), behavior: 'instant' });
          return { atTop, scrollTop: c.scrollTop };
        },
      });
      if (ur.result?.atTop) break;
      await new Promise(r => setTimeout(r, 600)); // wait for lazy-loaded messages to render
    }

    // Step 2b: at the top — wait for any in-flight loads to settle, retrying if
    // the container keeps growing (more history arriving from the server).
    let prevH = 0;
    for (let t = 0; t < 6; t++) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: () => {
          const c = window.__copilotScrollEl;
          if (c) c.scrollTo({ top: 0, behavior: 'instant' });
        },
      });
      await new Promise(r => setTimeout(r, 700));
      const [hRes] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: () => {
          const c = window.__copilotScrollEl;
          return c ? c.scrollHeight : 0;
        },
      });
      const h = hRes.result || 0;
      if (h === prevH && t > 0) break; // height stable — no more loading
      prevH = h;
    }

    // Step 3: sweep DOWN accumulating every message as it enters the DOM
    const MAX_PASSES = 100;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      // Accumulate whatever is currently rendered in the DOM
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: () => { window.__copilotExportFormat = 'accumulate'; },
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        files: ['extractor.js'],
      });

      // Scroll down; use smaller steps (60 %) for better overlap between passes
      const [sr] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: () => {
          const c = window.__copilotScrollEl;
          if (!c) return { atBottom: true };
          const atBottom = c.scrollTop + c.clientHeight >= c.scrollHeight - 80;
          if (!atBottom) c.scrollBy({ top: Math.max(c.clientHeight * 0.6, 250), behavior: 'instant' });
          return { atBottom };
        },
      });
      if (sr.result?.atBottom) break;
      await new Promise(r => setTimeout(r, 550)); // longer wait to handle slow React renders
    }

    // Step 4: one final accumulation pass at the bottom, then run the real extraction
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => { window.__copilotExportFormat = 'accumulate'; },
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      files: ['extractor.js'],
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: (fmt) => { window.__copilotExportFormat = fmt; },
      args: [getFormat()],
    });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      files: ['extractor.js'],
    });

    const response = injection?.result;

    setLoading(false);

    if (!response?.success) {
      showStatus('error', response?.error || 'Export failed — no messages found.');
      return;
    }

    const parts = [`${response.count} message${response.count !== 1 ? 's' : ''}`];
    if (response.imageCount)    parts.push(`${response.imageCount} image${response.imageCount !== 1 ? 's' : ''}`);
    if (response.citationCount) parts.push(`${response.citationCount} citation${response.citationCount !== 1 ? 's' : ''}`);

    // Step 5a: DOCX — build Open XML document in-browser, download as binary
    if (getFormat() === 'docx') {
      const raw = JSON.parse(response.content);
      const { title, messages: msgs } = raw;

      // Collect unique image URLs — segments has them inline; images array is the fallback
      const imgUrls = [...new Set(
        msgs.flatMap(m => (m.segments || m.images || []).map(s => s.url).filter(Boolean))
      )];

      const imageDataMap = {};
      let docxBlockedImages = 0;
      if (imgUrls.length) {
        showStatus('success', `Fetching ${imgUrls.length} image${imgUrls.length !== 1 ? 's' : ''}…`);
        for (const url of imgUrls) {
          try {
            const result = await new Promise(resolve =>
              chrome.runtime.sendMessage({ action: 'fetchImageAsBase64', url }, resolve)
            );
            if (result?.success) {
              const b64 = result.dataUrl.split(',')[1];
              const bin = atob(b64);
              const arr = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
              imageDataMap[url] = arr;
            } else if (result?.blocked) {
              docxBlockedImages++;
            }
          } catch {}
        }
      }

      const docxBytes = buildDocx(msgs, title, imageDataMap);

      // Convert Uint8Array → base64 in chunks to avoid stack overflow
      let binary = '';
      const CHUNK = 8192;
      for (let i = 0; i < docxBytes.length; i += CHUNK) {
        binary += String.fromCharCode(...docxBytes.subarray(i, Math.min(i + CHUNK, docxBytes.length)));
      }
      const b64 = btoa(binary);

      chrome.runtime.sendMessage(
        {
          action: 'download',
          content: b64,
          filename: response.filename,
          mimeType: response.mimeType,
          isBase64: true,
        },
        (dlResponse) => {
          if (dlResponse?.success) {
            const blockedNote = docxBlockedImages
              ? ` — ${docxBlockedImages} image${docxBlockedImages !== 1 ? 's' : ''} skipped (server not approved; add it in Settings)`
              : '';
            showStatus(docxBlockedImages ? 'error' : 'success',
              `Exported ${parts.join(', ')} → ${response.filename}${blockedNote}`);
          } else {
            showStatus('error', dlResponse?.error || 'Download failed.');
          }
        }
      );
      return;
    }

    // Step 5b: PDF — embed images as base64, store HTML, open print page
    if (getFormat() === 'pdf') {
      let html = response.content;

      // Find all external image URLs in the generated HTML
      const imgPattern = /src="(https?:\/\/[^"]+)"/g;
      const imgUrls = [...html.matchAll(imgPattern)].map(m => m[1])
        .filter(u => !u.startsWith('data:'));

      let pdfBlockedImages = 0;
      if (imgUrls.length) {
        showStatus('success', `Fetching ${imgUrls.length} image${imgUrls.length !== 1 ? 's' : ''}…`);
        // Fetch each image via the background service worker (has auth cookies).
        // Only URLs from approved servers will be fetched; others are left as-is.
        for (const url of imgUrls) {
          try {
            const result = await new Promise(resolve =>
              chrome.runtime.sendMessage({ action: 'fetchImageAsBase64', url }, resolve)
            );
            if (result?.success) {
              // Function replacement: treats the data URL literally so any
              // `$` sequences in it are not interpreted as replacement patterns.
              html = html.replace(`src="${url}"`, () => `src="${result.dataUrl}"`);
            } else if (result?.blocked) {
              pdfBlockedImages++;
            }
          } catch {}
        }
      }

      await chrome.storage.session.set({ copilotPrintHtml: html });
      await chrome.tabs.create({ url: chrome.runtime.getURL('print.html') });
      const pdfBlockedNote = pdfBlockedImages
        ? ` — ${pdfBlockedImages} image${pdfBlockedImages !== 1 ? 's' : ''} skipped (server not approved; add it in Settings)`
        : '';
      showStatus(pdfBlockedImages ? 'error' : 'success',
        `Print preview opened — ${parts.join(', ')}${pdfBlockedNote}`);
      return;
    }

    // Step 5c: all other formats — send to background for download
    chrome.runtime.sendMessage(
      { action: 'download', content: response.content, filename: response.filename, mimeType: response.mimeType },
      (dlResponse) => {
        if (dlResponse?.success) {
          showStatus('success', `Exported ${parts.join(', ')} → ${response.filename}`);
        } else {
          showStatus('error', dlResponse?.error || 'Download failed.');
        }
      }
    );

  } catch (err) {
    setLoading(false);
    showStatus('error', `Error: ${err.message}`);
  }
});
