(async () => {
  const { copilotPrintHtml } = await chrome.storage.session.get('copilotPrintHtml');

  const loading  = document.getElementById('loading');
  const frame    = document.getElementById('frame');
  const printBtn = document.getElementById('printBtn');

  if (!copilotPrintHtml) {
    loading.textContent = 'No content found — please go back and export again.';
    return;
  }

  loading.remove();
  frame.style.display = 'block';

  // Set up the print trigger BEFORE doc.write so it captures the iframe's load event.
  // Running this in the parent (rather than an inline script in the HTML) keeps all
  // JavaScript out of the sandboxed iframe, which blocks injected scripts from the
  // chat content running in an extension-origin context.
  frame.onload = () => {
    const imgs = [...frame.contentDocument.querySelectorAll('img')];
    if (!imgs.length) { setTimeout(() => frame.contentWindow?.print(), 300); return; }
    let loaded = 0;
    const tryPrint = () => { if (++loaded >= imgs.length) setTimeout(() => frame.contentWindow?.print(), 300); };
    imgs.forEach(img => {
      if (img.complete) tryPrint();
      else { img.onload = tryPrint; img.onerror = tryPrint; }
    });
  };

  // Write directly to the iframe's document (same-origin extension page).
  // This avoids srcdoc's null-origin restriction so images load correctly.
  const doc = frame.contentDocument || frame.contentWindow.document;
  doc.open();
  doc.write(copilotPrintHtml);
  doc.close();

  // Wire the toolbar print button to the iframe's window
  printBtn.onclick = () => frame.contentWindow?.print();

  // Clean up storage
  chrome.storage.session.remove('copilotPrintHtml');
})();
