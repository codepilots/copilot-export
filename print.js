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
