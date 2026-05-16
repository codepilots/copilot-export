// Shared security configuration and URL-validation helpers.
// Loaded by background.js (via importScripts) and by popup.html / options.html (via <script>).

const SECURITY_DEFAULTS = {
  // Hostnames from which images and files may be fetched during export.
  // Patterns may use a "*."-prefix wildcard, e.g. "*.sharepoint.com".
  // Deliberately does NOT include a SharePoint wildcard: every tenant has its
  // own <tenant>.sharepoint.com host, so a wildcard would allow credentialed
  // fetches to arbitrary tenants. Users who export SharePoint-hosted images
  // add their specific tenant host in the extension's Settings page.
  approvedImageHosts: [
    'copilot.microsoft.com',
    'm365.cloud.microsoft',
    'www.microsoft365.com',
    'teams.microsoft.com',
    'outlook.office.com',
    'outlook.office365.com',
    'designerapp.officeapps.live.com',
  ],

  // Hostnames of tabs on which the extension is allowed to run (export).
  // Must stay aligned with content_scripts.matches in manifest.json.
  approvedTabHosts: [
    'copilot.microsoft.com',
    'm365.cloud.microsoft',
    'www.microsoft365.com',
    '*.sharepoint.com',
    'teams.microsoft.com',
    'outlook.office.com',
    'outlook.office365.com',
  ],
};

// Returns true when `hostname` matches `pattern`.
// Patterns starting with "*." require at least one subdomain label before the suffix.
function secMatchesHost(pattern, hostname) {
  hostname = hostname.toLowerCase();
  pattern  = pattern.toLowerCase().trim();
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1); // e.g. '.sharepoint.com'
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }
  return hostname === pattern;
}

// Returns true when `pattern` is specific enough to safely allow credentialed
// fetches / extension execution. Rejects overly-broad patterns: a pattern must
// resolve to at least two DNS labels, and a "*."-wildcard's fixed part must
// itself have at least two labels — so "*.sharepoint.com" is accepted but
// "*.com" (every .com host) and a bare "*" are not.
function secValidateHostPattern(pattern) {
  pattern = (pattern || '').toLowerCase().trim();
  if (!pattern) return false;
  const host = pattern.startsWith('*.') ? pattern.slice(2) : pattern;
  const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
  return new RegExp(`^${LABEL}(?:\\.${LABEL})+$`).test(host);
}

// Returns true when `url` is an https:// URL whose hostname matches at least
// one entry in `patterns`.  Returns false for any other scheme or a bad URL.
function isApprovedUrl(url, patterns) {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'https:') return false;
    return (patterns || []).some(p => secMatchesHost(p, hostname));
  } catch {
    return false;
  }
}
