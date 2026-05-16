const imageHostsEl = document.getElementById('imageHosts');
const tabHostsEl   = document.getElementById('tabHosts');
const saveBtn      = document.getElementById('saveBtn');
const resetBtn     = document.getElementById('resetBtn');
const savedMsg     = document.getElementById('savedMsg');

function hostsToText(arr) {
  return (arr || []).join('\n');
}

function textToHosts(txt) {
  return txt.split('\n').map(l => l.trim()).filter(Boolean);
}

function flashSaved() {
  savedMsg.style.display = 'block';
  setTimeout(() => { savedMsg.style.display = 'none'; }, 2000);
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
  await chrome.storage.sync.set({
    approvedImageHosts: textToHosts(imageHostsEl.value),
    approvedTabHosts:   textToHosts(tabHostsEl.value),
  });
  flashSaved();
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
