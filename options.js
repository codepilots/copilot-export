const imageHostsEl = document.getElementById('imageHosts');
const tabHostsEl   = document.getElementById('tabHosts');
const saveBtn      = document.getElementById('saveBtn');
const resetBtn     = document.getElementById('resetBtn');
const savedMsg     = document.getElementById('savedMsg');

function hostsToText(arr) {
  return (arr || []).join('\n');
}

function partitionHosts(txt) {
  const valid = [], invalid = [];
  for (const line of txt.split('\n')) {
    const h = line.trim();
    if (!h) continue;
    (secValidateHostPattern(h) ? valid : invalid).push(h);
  }
  return { valid, invalid };
}

function flashSaved() {
  savedMsg.textContent = 'Settings saved.';
  savedMsg.style.background = '';
  savedMsg.style.color = '';
  savedMsg.style.borderColor = '';
  savedMsg.style.display = 'block';
  clearTimeout(flashSaved._t);
  flashSaved._t = setTimeout(() => { savedMsg.style.display = 'none'; }, 2000);
}

function warnRejected(rejected) {
  const plural = rejected.length === 1 ? 'entry' : 'entries';
  savedMsg.textContent =
    `Saved. Ignored ${rejected.length} invalid or too-broad ${plural}: ` +
    `${rejected.join(', ')} — use a specific host (contoso.sharepoint.com) ` +
    `or a wildcard with at least two labels (*.sharepoint.com).`;
  savedMsg.style.background = '#fff4ce';
  savedMsg.style.color = '#6b5b00';
  savedMsg.style.borderColor = '#e8d57e';
  savedMsg.style.display = 'block';
  clearTimeout(flashSaved._t);
  flashSaved._t = setTimeout(() => { savedMsg.style.display = 'none'; }, 8000);
}

async function load() {
  const stored = await chrome.storage.sync.get({
    approvedImageHosts: SECURITY_DEFAULTS.approvedImageHosts,
    approvedTabHosts:   SECURITY_DEFAULTS.approvedTabHosts,
  });
  imageHostsEl.value = hostsToText(stored.approvedImageHosts);
  tabHostsEl.value   = hostsToText(stored.approvedTabHosts);
}

saveBtn.addEventListener('click', async () => {
  const img = partitionHosts(imageHostsEl.value);
  const tab = partitionHosts(tabHostsEl.value);
  await chrome.storage.sync.set({
    approvedImageHosts: img.valid,
    approvedTabHosts:   tab.valid,
  });
  // Reflect the cleaned lists back so the user sees exactly what was stored.
  imageHostsEl.value = img.valid.join('\n');
  tabHostsEl.value   = tab.valid.join('\n');
  const rejected = [...img.invalid, ...tab.invalid];
  if (rejected.length) warnRejected(rejected);
  else flashSaved();
});

resetBtn.addEventListener('click', async () => {
  imageHostsEl.value = hostsToText(SECURITY_DEFAULTS.approvedImageHosts);
  tabHostsEl.value   = hostsToText(SECURITY_DEFAULTS.approvedTabHosts);
  await chrome.storage.sync.set({
    approvedImageHosts: SECURITY_DEFAULTS.approvedImageHosts,
    approvedTabHosts:   SECURITY_DEFAULTS.approvedTabHosts,
  });
  flashSaved();
});

load();
