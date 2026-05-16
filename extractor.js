// Runs in world: 'MAIN' via chrome.scripting.executeScript — has full access to React fiber.
// Must be self-contained (no chrome.* APIs available here).
// The last expression is returned to popup.js as injection.result.

(() => {
  const SEL = {
    userContent:  '.fai-UserMessage__message',
    botContent:   '.fai-CopilotMessage__content',
    userTurn:     '.fai-UserMessage',
    botTurn:      '.fai-CopilotMessage',
    citation:     '.fai-Citation',
    designerHost: '[id^="designer-host"]',
  };

  // ── React fiber ──────────────────────────────────────────────────────────────

  function getFiberProps(el, depth) {
    const key = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternals'));
    if (!key) return null;
    let fiber = el[key];
    for (let i = 0; i < depth && fiber; i++) fiber = fiber.return;
    return fiber?.memoizedProps || null;
  }

  // ── Security helpers ─────────────────────────────────────────────────────────

  // Returns true when a URL is safe to use in href/src attributes.
  // Allows https, http, mailto, and relative references; blocks javascript:, data:, etc.
  function isSafeHref(value) {
    const v = (value || '').trim();
    if (!v || v.startsWith('#') || v.startsWith('/') || v.startsWith('?') || v.startsWith('.')) return true;
    try {
      const { protocol } = new URL(v);
      return protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:';
    } catch {
      return !/^(javascript|data|vbscript):/i.test(v);
    }
  }

  function sanitizeHref(url) {
    return isSafeHref(url) ? url : '#';
  }

  // Strips dangerous tags and attributes from an HTML string before it is
  // injected into the export document.  Removes script, style, iframe, svg,
  // form elements and all event-handler / unsafe-scheme attributes.
  function sanitizeHtml(htmlStr) {
    if (!htmlStr) return '';
    const REMOVE_TAGS = new Set([
      'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed',
      'applet', 'link', 'base', 'meta', 'noscript', 'template',
      'form', 'input', 'button', 'select', 'textarea', 'svg', 'math',
    ]);
    const parsed = new DOMParser().parseFromString(`<body>${htmlStr}</body>`, 'text/html');
    function walkEl(el) {
      [...el.children].forEach(walkEl);
      if (REMOVE_TAGS.has(el.tagName.toLowerCase())) { el.remove(); return; }
      const drop = [];
      for (const { name } of el.attributes) {
        const n = name.toLowerCase();
        if (n.startsWith('on')) { drop.push(name); continue; }
        if (['href', 'src', 'action', 'formaction', 'xlink:href'].includes(n)) {
          if (!isSafeHref(el.getAttribute(name))) drop.push(name);
        }
        if (n === 'srcset' || n === 'xml:base') drop.push(name);
      }
      drop.forEach(a => el.removeAttribute(a));
    }
    walkEl(parsed.body);
    return parsed.body.innerHTML;
  }

  // ── Images ───────────────────────────────────────────────────────────────────

  function extractImages(contentEl) {
    const images = [];
    contentEl.querySelectorAll(SEL.designerHost).forEach(host => {
      try {
        const props = getFiberProps(host, 1);
        if (!props) return;
        const pci = props.persistContentInfo;
        const prompt = pci?.prompt || '';
        const timestamp = pci?.message?.timestamp || null;
        const refUrl = pci?.message?.messageAnnotations?.[0]
          ?.messageAnnotationMetadata?.imageReferenceUrl || '';
        const configUrls = props.experienceConfig?.imageHistoryData?.data?.imgUrl || [];
        const urls = refUrl ? [refUrl, ...configUrls.filter(u => u !== refUrl)] : configUrls;
        urls.forEach(url => { if (url) images.push({ prompt, url, timestamp }); });
      } catch {}
    });
    return images;
  }

  // ── Citations ────────────────────────────────────────────────────────────────

  function extractCitations(contentEl) {
    const seen = new Set();
    const out = [];
    contentEl.querySelectorAll(SEL.citation).forEach(cite => {
      try {
        JSON.parse(cite.getAttribute('data-grouped-citations') || '[]').forEach(c => {
          if (c.url && !seen.has(c.url)) { seen.add(c.url); out.push({ name: c.name, url: c.url }); }
        });
      } catch {}
    });
    return out;
  }

  // ── Segments: ordered text/image blocks preserving DOM position ──────────────

  function extractSegments(contentEl, images) {
    const segments = [];
    let imgIdx = 0;

    function addContent(text, html) {
      if (!text && !html) return;
      const last = segments[segments.length - 1];
      if (last && last.type === 'text') {
        if (text) last.text += '\n\n' + text;
        if (html) last.html = (last.html || '') + '\n' + html;
      } else {
        segments.push({ type: 'text', text: text || '', html: html || '' });
      }
    }

    function stripElement(el) {
      const clone = el.cloneNode(true);
      clone.querySelectorAll(
        `button,[role="button"],svg,[class*="action" i],[class*="toolbar" i],[class*="tooltip" i]`
      ).forEach(n => n.remove());
      clone.querySelectorAll(SEL.citation).forEach(cite => {
        try {
          const grouped = JSON.parse(cite.getAttribute('data-grouped-citations') || '[]');
          const span = document.createElement('span');
          span.innerHTML = grouped.map(c =>
            c.url
              ? `<a href="${sanitizeHref(c.url).replace(/"/g, '&quot;')}">${(c.name || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</a>`
              : (c.name || '')
          ).join(', ');
          cite.replaceWith(span);
        } catch { cite.remove(); }
      });
      return {
        text: (clone.innerText || clone.textContent || '').trim(),
        html: clone.outerHTML,
      };
    }

    function walk(node) {
      for (const child of node.children) {
        if (child.id && child.id.startsWith('designer-host')) {
          const img = images[imgIdx++];
          if (img?.url) segments.push({ type: 'image', url: img.url, prompt: img.prompt || '' });
        } else if (child.querySelector(SEL.designerHost)) {
          walk(child); // contains an image deeper — recurse to preserve sibling order
        } else {
          const { text, html } = stripElement(child);
          addContent(text, html);
        }
      }
    }

    walk(contentEl);

    if (!segments.length) {
      // Fallback: plain text then any images
      const t = toPlain(contentEl);
      if (t) segments.push({ type: 'text', text: t });
      for (const img of images) {
        if (img?.url) segments.push({ type: 'image', url: img.url, prompt: img.prompt || '' });
      }
    }

    return segments;
  }

  // ── Markdown conversion ──────────────────────────────────────────────────────

  function toMarkdown(el, images) {
    const clone = el.cloneNode(true);

    // Replace designer-host iframes with image markdown BEFORE any chrome stripping
    let imgIdx = 0;
    clone.querySelectorAll(SEL.designerHost).forEach(host => {
      const img = images[imgIdx++];
      const span = document.createElement('span');
      span.textContent = img
        ? `\n\n![${img.prompt || 'Generated image'}](${img.url})\n`
        : '\n\n[Generated image — URL unavailable]\n';
      host.replaceWith(span);
    });

    // Strip chrome
    clone.querySelectorAll(
      'button,[role="button"],svg,img,[class*="action" i],[class*="toolbar" i],[class*="tooltip" i]'
    ).forEach(n => n.remove());

    // Convert citations to inline links
    clone.querySelectorAll(SEL.citation).forEach(cite => {
      try {
        const grouped = JSON.parse(cite.getAttribute('data-grouped-citations') || '[]');
        cite.replaceWith(grouped.length
          ? grouped.map(c => `[${c.name}](${sanitizeHref(c.url)})`).join(', ')
          : '');
      } catch { cite.remove(); }
    });

    // Code
    clone.querySelectorAll('pre').forEach(pre => {
      const lang = pre.querySelector('code')?.className?.match(/language-(\S+)/)?.[1] || '';
      pre.replaceWith(`\n\`\`\`${lang}\n${(pre.innerText || pre.textContent || '').trim()}\n\`\`\`\n`);
    });
    clone.querySelectorAll('code').forEach(c => c.replaceWith(`\`${c.textContent}\``));
    clone.querySelectorAll('strong,b').forEach(b => b.replaceWith(`**${b.textContent}**`));
    clone.querySelectorAll('em,i').forEach(i => i.replaceWith(`_${i.textContent}_`));
    for (let h = 1; h <= 6; h++) {
      clone.querySelectorAll(`h${h}`).forEach(el => {
        const p = document.createElement('p');
        p.textContent = `${'#'.repeat(h)} ${el.textContent.trim()}`;
        el.replaceWith(p);
      });
    }
    clone.querySelectorAll('li').forEach(li => {
      const p = document.createElement('p');
      p.textContent = (li.closest('ol') ? '1. ' : '- ') + li.textContent.trim();
      li.replaceWith(p);
    });
    clone.querySelectorAll('ul,ol').forEach(l => l.replaceWith(...l.childNodes));

    return (clone.innerText || clone.textContent || '').trim();
  }

  function toPlain(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll(
      `button,[role="button"],svg,img,[class*="action" i],[class*="toolbar" i],${SEL.designerHost}`
    ).forEach(n => n.remove());
    clone.querySelectorAll(SEL.citation).forEach(cite => {
      try {
        const grouped = JSON.parse(cite.getAttribute('data-grouped-citations') || '[]');
        cite.replaceWith(grouped.map(c => c.name).join(', '));
      } catch { cite.remove(); }
    });
    return (clone.innerText || clone.textContent || '').trim();
  }

  // ── Gather messages ──────────────────────────────────────────────────────────

  function gatherMessages() {
    const messages = [];

    // Strategy 1: precise fai- content selectors
    const userEls = [...document.querySelectorAll(SEL.userContent)];
    const botEls  = [...document.querySelectorAll(SEL.botContent)];

    if (userEls.length || botEls.length) {
      const all = [
        ...userEls.map(el => ({ el, role: 'user' })),
        ...botEls.map(el => ({ el, role: 'assistant' })),
      ].sort((a, b) =>
        a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
      );

      for (const { el, role } of all) {
        const images    = role === 'assistant' ? extractImages(el)    : [];
        const citations = role === 'assistant' ? extractCitations(el) : [];
        const segments  = role === 'assistant'
          ? extractSegments(el, images)
          : [{ type: 'text', text: toPlain(el) }];
        const text      = segments.filter(s => s.type === 'text').map(s => s.text).join('\n\n') || toPlain(el);
        const markdown  = toMarkdown(el, images);
        const timestamp = images[0]?.timestamp || null;
        if (text.length < 2 && images.length === 0) continue;
        messages.push({ role, text, markdown, images, citations, timestamp, segments });
      }
      if (messages.length) return messages;
    }

    // Strategy 2: fai-UserMessage / fai-CopilotMessage turn containers
    const all2 = [
      ...[...document.querySelectorAll(SEL.userTurn)].map(el => ({ el, role: 'user' })),
      ...[...document.querySelectorAll(SEL.botTurn)].map(el => ({ el, role: 'assistant' })),
    ].sort((a, b) =>
      a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    );

    for (const { el, role } of all2) {
      const images    = role === 'assistant' ? extractImages(el)    : [];
      const citations = role === 'assistant' ? extractCitations(el) : [];
      const clone = el.cloneNode(true);
      clone.querySelectorAll(
        '[class*="__accessibleHeading"],[class*="__avatar"],[class*="__name"],' +
        '[class*="__actions"],[class*="__footnote"],[class*="__actionBar"],' +
        'button,[role="button"],svg,img'
      ).forEach(n => n.remove());
      const text = toPlain(clone);
      const segments = role === 'assistant'
        ? extractSegments(el, images)
        : [{ type: 'text', text }];
      if (text.length < 2 && images.length === 0) continue;
      messages.push({ role, text, markdown: toMarkdown(clone, images), images, citations, timestamp: null, segments });
    }

    return messages;
  }

  // ── Format builders ──────────────────────────────────────────────────────────

  function buildMarkdown(messages, title) {
    const lines = [`# ${title}`, `_Exported ${new Date().toLocaleString()}_`, ''];
    for (const msg of messages) {
      const label = msg.role === 'user' ? '**You**' : '**Copilot**';
      const ts = msg.timestamp ? ` _(${new Date(msg.timestamp).toLocaleString()})_` : '';
      lines.push(`---\n### ${label}${ts}`);
      lines.push(msg.markdown || msg.text);
      if (msg.citations.length) {
        lines.push('');
        lines.push('**Sources:** ' + msg.citations.map(c => `[${c.name}](${sanitizeHref(c.url)})`).join(' · '));
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  function buildJSON(messages, title) {
    return JSON.stringify({
      title,
      exportedAt: new Date().toISOString(),
      messages: messages.map(m => ({
        role: m.role,
        text: m.text,
        timestamp: m.timestamp || null,
        images: m.images.map(i => ({ prompt: i.prompt, url: i.url })),
        citations: m.citations.map(c => ({ name: c.name, url: c.url })),
      })),
    }, null, 2);
  }

  function buildText(messages, title) {
    const sep = '─'.repeat(60);
    const lines = [title, `Exported: ${new Date().toLocaleString()}`, sep, ''];
    for (const msg of messages) {
      const label = msg.role === 'user' ? 'You' : 'Copilot';
      const ts = msg.timestamp ? ` (${new Date(msg.timestamp).toLocaleString()})` : '';
      lines.push(`[${label}${ts}]`);
      if (msg.text) lines.push(msg.text);
      msg.images.forEach(img => {
        lines.push(`[Generated image: "${img.prompt}"]`);
        lines.push(`  ${img.url}`);
      });
      if (msg.citations.length) {
        lines.push('Sources:');
        msg.citations.forEach(c => lines.push(`  ${c.name}: ${c.url}`));
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  // ── HTML / PDF builder ───────────────────────────────────────────────────────

  function buildHTML(messages, title) {
    const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    function renderSegments(segments) {
      return segments.map(seg => {
        if (seg.type === 'image') {
          return `<figure class="gen-image">
            <img src="${esc(seg.url)}" alt="${esc(seg.prompt)}" loading="lazy">
            <figcaption>${esc(seg.prompt)}</figcaption>
          </figure>`;
        }
        // Use rich HTML when available (preserves bold, code, headings, lists, etc.)
        if (seg.html) {
          return `<div class="rich-content">${sanitizeHtml(seg.html)}</div>`;
        }
        return (seg.text || '').split(/\n{2,}/).map(block => {
          const lines = block.split('\n').map(l => esc(l)).join('<br>');
          return `<p>${lines}</p>`;
        }).join('');
      }).join('');
    }

    function renderMessage(msg) {
      const isUser = msg.role === 'user';
      const ts = msg.timestamp
        ? `<span class="ts">${new Date(msg.timestamp).toLocaleString()}</span>` : '';

      const body = renderSegments(msg.segments);

      // Citations
      const cites = msg.citations.length
        ? `<div class="sources"><span class="sources-label">Sources:</span> ` +
          msg.citations.map(c =>
            `<a href="${esc(sanitizeHref(c.url))}" target="_blank">${esc(c.name)}</a>`
          ).join('<span class="sep"> · </span>') +
          `</div>`
        : '';

      return `
        <div class="message ${isUser ? 'user' : 'assistant'}">
          <div class="bubble-header">
            <span class="role-label">${isUser ? 'You' : 'Copilot'}</span>${ts}
          </div>
          <div class="bubble">
            ${body}${cites}
          </div>
        </div>`;
    }

    const messagesHtml = messages.map(renderMessage).join('\n');
    const exportedAt = new Date().toLocaleString();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: "Segoe UI", system-ui, sans-serif;
      font-size: 13px;
      line-height: 1.6;
      color: #1a1a2e;
      background: #fff;
      padding: 32px 48px 64px;
    }

    .page {
      width: 100%;
    }

    h1 {
      font-size: 20px;
      font-weight: 700;
      color: #0f6cbd;
      margin-bottom: 4px;
    }

    .meta {
      font-size: 11px;
      color: #888;
      margin-bottom: 28px;
      padding-bottom: 16px;
      border-bottom: 1px solid #eee;
    }

    .message { margin-bottom: 20px; }

    .bubble-header {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 4px;
    }

    .role-label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .04em;
      text-transform: uppercase;
    }

    .message.user .role-label  { color: #5a5a7a; }
    .message.assistant .role-label { color: #0f6cbd; }

    .ts {
      font-size: 10px;
      color: #aaa;
    }

    .bubble {
      border-radius: 12px;
      padding: 12px 16px;
      max-width: 90%;
    }

    .message.user .bubble {
      background: #eff6ff;
      border: 1px solid #d0e8ff;
      margin-left: auto;
    }

    .message.assistant .bubble {
      background: #fafafa;
      border: 1px solid #eee;
    }

    .bubble p { margin-bottom: 8px; }
    .bubble p:last-of-type { margin-bottom: 0; }

    /* ── Rich content formatting ─────────────────── */
    .rich-content { font-size: inherit; line-height: inherit; }
    .rich-content > *:first-child { margin-top: 0; }
    .rich-content > *:last-child  { margin-bottom: 0; }

    .rich-content p  { margin: 0 0 8px; }
    .rich-content h1 { font-size: 17px; font-weight: 700; color: #0f6cbd; margin: 14px 0 6px; }
    .rich-content h2 { font-size: 15px; font-weight: 700; color: #1f3864; margin: 12px 0 5px; }
    .rich-content h3 { font-size: 13px; font-weight: 700; color: #2e5090; margin: 10px 0 4px; }
    .rich-content h4,
    .rich-content h5,
    .rich-content h6 { font-size: 12px; font-weight: 700; color: #444; margin: 8px 0 4px; }

    .rich-content strong, .rich-content b { font-weight: 700; }
    .rich-content em,     .rich-content i { font-style: italic; }
    .rich-content s, .rich-content del    { text-decoration: line-through; }

    .rich-content a { color: #0f6cbd; text-decoration: none; }
    .rich-content a:hover { text-decoration: underline; }

    .rich-content code {
      font-family: "Cascadia Code", "Courier New", monospace;
      font-size: 11.5px;
      background: #f0f0f0;
      border-radius: 3px;
      padding: 1px 4px;
    }

    .rich-content pre {
      background: #f5f5f5;
      border: 1px solid #e0e0e0;
      border-radius: 6px;
      padding: 10px 12px;
      margin: 8px 0;
      overflow-x: auto;
      font-size: 11px;
      line-height: 1.5;
    }

    .rich-content pre code {
      background: none;
      padding: 0;
      border-radius: 0;
      font-size: inherit;
    }

    .rich-content ul, .rich-content ol {
      padding-left: 22px;
      margin: 4px 0 8px;
    }

    .rich-content li { margin-bottom: 3px; }
    .rich-content li > ul, .rich-content li > ol { margin: 3px 0; }

    .rich-content blockquote {
      border-left: 3px solid #0f6cbd;
      margin: 8px 0;
      padding: 4px 0 4px 12px;
      color: #555;
    }

    .rich-content table {
      border-collapse: collapse;
      width: 100%;
      margin: 8px 0;
      font-size: 12px;
    }

    .rich-content th, .rich-content td {
      border: 1px solid #ddd;
      padding: 5px 8px;
      text-align: left;
    }

    .rich-content th {
      background: #d5e8f0;
      font-weight: 700;
      color: #1f3864;
    }

    .rich-content tr:nth-child(even) td { background: #f9f9f9; }

    .rich-content hr {
      border: none;
      border-top: 1px solid #e0e0e0;
      margin: 10px 0;
    }

    .gen-image {
      margin: 12px 0 4px;
      display: inline-block;
    }

    .gen-image img {
      max-width: 100%;
      max-height: 480px;
      border-radius: 8px;
      display: block;
    }

    .gen-image figcaption {
      font-size: 11px;
      color: #888;
      margin-top: 4px;
      font-style: italic;
    }

    .sources {
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid #e8e8e8;
      font-size: 11px;
      color: #555;
    }

    .sources-label { font-weight: 600; }
    .sources .sep  { color: #ccc; }

    .sources a {
      color: #0f6cbd;
      text-decoration: none;
    }

    .sources a:hover { text-decoration: underline; }

    /* ── Print styles ────────────────────────────── */
    @media print {
      body { padding: 0; font-size: 11px; }
      .message.user .bubble {
        background: #f0f4ff !important;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      .rich-content pre, .rich-content code {
        background: #f5f5f5 !important;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      .rich-content th {
        background: #d5e8f0 !important;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      .rich-content pre { white-space: pre-wrap; word-break: break-all; }
      .gen-image img { max-height: 320px; }
      .message { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="page">
    <h1>${esc(title)}</h1>
    <div class="meta">Exported ${esc(exportedAt)} · ${messages.length} messages</div>
    ${messagesHtml}
  </div>
</body>
</html>`;
  }

  // ── Message cache key (for deduplication across scroll passes) ───────────────

  function makeCacheKey(msg) {
    const text = (msg.text || '').trim().slice(0, 200);
    const imgUrl = (msg.images[0]?.url || '').slice(-60);
    return `${msg.role}|${text}|${imgUrl}`;
  }

  // ── Entry point — result is returned to popup.js via executeScript ───────────

  const format = window.__copilotExportFormat || 'markdown';

  // Accumulate mode: gather current DOM messages into the global cache and return early.
  // popup.js calls this repeatedly as it scrolls through the chat.
  if (format === 'accumulate') {
    const msgs = gatherMessages();
    if (!window.__copilotExtractCache) {
      window.__copilotExtractCache     = [];
      window.__copilotExtractCacheKeys = new Map(); // key → index in cache
    }
    for (const msg of msgs) {
      const key = makeCacheKey(msg);
      if (window.__copilotExtractCacheKeys.has(key)) {
        // Replace if the new version has more content (e.g. images loaded)
        const idx = window.__copilotExtractCacheKeys.get(key);
        const cached = window.__copilotExtractCache[idx];
        if (msg.images.length > cached.images.length ||
            msg.citations.length > cached.citations.length) {
          window.__copilotExtractCache[idx] = msg;
        }
      } else {
        window.__copilotExtractCacheKeys.set(key, window.__copilotExtractCache.length);
        window.__copilotExtractCache.push(msg);
      }
    }
    return { success: true, cached: window.__copilotExtractCache.length };
  }

  // Normal mode: gather current DOM messages and merge with anything in the cache.
  let messages = gatherMessages();

  if (window.__copilotExtractCache && window.__copilotExtractCache.length > 0) {
    const cacheKeyMap = window.__copilotExtractCacheKeys;
    const result = [...window.__copilotExtractCache];
    for (const msg of messages) {
      const key = makeCacheKey(msg);
      if (cacheKeyMap.has(key)) {
        // Prefer current DOM version if it has more content
        const idx = cacheKeyMap.get(key);
        if (msg.images.length > result[idx].images.length ||
            msg.citations.length > result[idx].citations.length) {
          result[idx] = msg;
        }
      } else {
        result.push(msg); // new message at the end (bottom of chat)
      }
    }
    messages = result;
    window.__copilotExtractCache     = null;
    window.__copilotExtractCacheKeys = null;
  }

  if (!messages.length) {
    return { success: false, error: 'No chat messages found. Open a Copilot conversation and try again.' };
  }

  const title = document.title
    ?.replace(/[-|–—]\s*(Microsoft Copilot|Copilot|BizChat|M365 Copilot).*/i, '')
    .trim() || 'Copilot Chat';

  let content, filename, mimeType;
  if (format === 'json') {
    content = buildJSON(messages, title);
    filename = `copilot-chat-${Date.now()}.json`;
    mimeType = 'application/json';
  } else if (format === 'text') {
    content = buildText(messages, title);
    filename = `copilot-chat-${Date.now()}.txt`;
    mimeType = 'text/plain';
  } else if (format === 'pdf') {
    content = buildHTML(messages, title);
    filename = `copilot-chat-${Date.now()}.html`;
    mimeType = 'text/html';
  } else if (format === 'docx') {
    content = JSON.stringify({
      title,
      messages: messages.map(m => ({
        role: m.role,
        text: m.text,
        timestamp: m.timestamp || null,
        segments: (m.segments || []).map(s =>
          s.type === 'image'
            ? { type: 'image', url: s.url, prompt: s.prompt || '' }
            : { type: 'text',  text: s.text || '', html: s.html || '' }
        ),
        images: m.images.map(i => ({ prompt: i.prompt, url: i.url })),
        citations: m.citations.map(c => ({ name: c.name, url: c.url })),
      })),
    });
    filename = `copilot-chat-${Date.now()}.docx`;
    mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  } else {
    content = buildMarkdown(messages, title);
    filename = `copilot-chat-${Date.now()}.md`;
    mimeType = 'text/markdown';
  }

  return {
    success: true,
    content,
    filename,
    mimeType,
    count: messages.length,
    imageCount: messages.reduce((n, m) => n + m.images.length, 0),
    citationCount: messages.reduce((n, m) => n + m.citations.length, 0),
  };
})();
