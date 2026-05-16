// Pure-browser DOCX builder — no dependencies, no build step.
// Exports: window.buildDocx(messages, title, imageDataMap) → Uint8Array

(function (global) {

  // ── CRC32 ──────────────────────────────────────────────────────────────────

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })();

  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // ── Binary helpers ─────────────────────────────────────────────────────────

  function concat(...arrays) {
    let total = 0;
    for (const a of arrays) total += a.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) { out.set(a, off); off += a.length; }
    return out;
  }

  function u16(n) {
    n = n >>> 0;
    return new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF]);
  }

  function u32(n) {
    n = n >>> 0;
    return new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]);
  }

  const enc = new TextEncoder();

  // ── ZIP builder (STORED, no compression) ──────────────────────────────────

  function buildZip(files) {
    // Phase 1: build all local entries and accumulate central-dir metadata
    const localParts = [];
    const cdEntries  = [];
    let offset = 0;

    for (const { name, data } of files) {
      const nb  = enc.encode(name);
      const cr  = crc32(data);
      const sz  = data.length;

      // Local file header (30 bytes fixed + variable)
      const lh = concat(
        new Uint8Array([0x50, 0x4B, 0x03, 0x04]), // signature
        u16(20),   // version needed
        u16(0),    // flags
        u16(0),    // compression: STORED
        u16(0),    // mod time
        u16(0),    // mod date
        u32(cr),   // crc-32
        u32(sz),   // compressed size
        u32(sz),   // uncompressed size
        u16(nb.length),
        u16(0),    // extra field length
        nb,
        data
      );

      cdEntries.push({ nb, cr, sz, offset });
      localParts.push(lh);
      offset += lh.length;
    }

    // Phase 2: central directory
    const cdParts = cdEntries.map(d => concat(
      new Uint8Array([0x50, 0x4B, 0x01, 0x02]), // signature
      u16(20),    // version made by
      u16(20),    // version needed
      u16(0),     // flags
      u16(0),     // compression
      u16(0),     // mod time
      u16(0),     // mod date
      u32(d.cr),  // crc-32
      u32(d.sz),  // compressed size
      u32(d.sz),  // uncompressed size
      u16(d.nb.length),
      u16(0),     // extra length
      u16(0),     // comment length
      u16(0),     // disk start
      u16(0),     // internal attrs
      u32(0),     // external attrs
      u32(d.offset),
      d.nb
    ));

    const cd = cdParts.length > 0 ? concat(...cdParts) : new Uint8Array(0);
    const count = cdEntries.length;

    // Phase 3: end of central directory
    const eocd = concat(
      new Uint8Array([0x50, 0x4B, 0x05, 0x06]), // signature
      u16(0),          // disk number
      u16(0),          // start disk
      u16(count),      // entries on disk
      u16(count),      // total entries
      u32(cd.length),  // size of CD
      u32(offset),     // offset of CD
      u16(0)           // comment length
    );

    return concat(...localParts, cd, eocd);
  }

  // ── Image dimension readers ────────────────────────────────────────────────

  function pngDims(data) {
    if (data.length < 24) return null;
    const v = new DataView(data.buffer, data.byteOffset);
    return { w: v.getUint32(16), h: v.getUint32(20) };
  }

  function jpegDims(data) {
    let i = 2;
    while (i + 8 < data.length) {
      if (data[i] !== 0xFF) break;
      const m = data[i + 1];
      const len = (data[i + 2] << 8) | data[i + 3];
      if ((m >= 0xC0 && m <= 0xC3) || (m >= 0xC5 && m <= 0xC7) ||
          (m >= 0xC9 && m <= 0xCB) || (m >= 0xCD && m <= 0xCF)) {
        return { h: (data[i + 5] << 8) | data[i + 6], w: (data[i + 7] << 8) | data[i + 8] };
      }
      i += 2 + len;
    }
    return null;
  }

  function imgMeta(data) {
    if (!data || data.length < 4) return { ext: 'png', dims: null };
    if (data[0] === 0x89 && data[1] === 0x50) return { ext: 'png',  dims: pngDims(data) };
    if (data[0] === 0xFF && data[1] === 0xD8) return { ext: 'jpeg', dims: jpegDims(data) };
    return { ext: 'png', dims: null };
  }

  // ── XML helpers ────────────────────────────────────────────────────────────

  // Escape XML special chars AND strip characters invalid in XML 1.0
  function xe(s) {
    return String(s)
      // Strip XML-invalid control characters (keep tab, LF, CR)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F￾￿]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── DOCX file builder ──────────────────────────────────────────────────────

  function buildDocxFiles(messages, title, imageDataMap) {
    const mediaFiles = [];

    // Relationships for document.xml.rels
    // rId1=styles, rId2=settings; images start at rId3; hyperlinks at rId1000+
    let rIdImg  = 3;
    let rIdHref = 1000;

    const imgRels   = [];   // {id, type:'image', target, ext:false}
    const hrefRels  = [];   // {id, type:'hyperlink', target, ext:true}
    const hrefMap   = new Map(); // url → rId

    // Register image data
    const imgRelMap = new Map(); // url → {rId, dims}
    let mediaIdx = 1;
    for (const [url, data] of Object.entries(imageDataMap || {})) {
      const { ext, dims } = imgMeta(data);
      const rId = `rId${rIdImg++}`;
      const fname = `image${mediaIdx++}.${ext}`;
      mediaFiles.push({ name: `word/media/${fname}`, data });
      imgRels.push({ id: rId, type: 'image', target: `media/${fname}` });
      imgRelMap.set(url, { rId, dims });
    }

    // Counters
    let drawingId = 1;

    // ── XML snippet builders ─────────────────────────────────────────────────

    function makeRun(text, bold, color, halfPt) {
      const parts = [];
      if (bold)   parts.push('<w:b/><w:bCs/>');
      if (color)  parts.push(`<w:color w:val="${color}"/>`);
      if (halfPt) parts.push(`<w:sz w:val="${halfPt}"/><w:szCs w:val="${halfPt}"/>`);
      const rPr = parts.length ? `<w:rPr>${parts.join('')}</w:rPr>` : '';
      return `<w:r>${rPr}<w:t xml:space="preserve">${xe(text)}</w:t></w:r>`;
    }

    function makeBr() { return '<w:r><w:br/></w:r>'; }

    function makePara(inner, styleId, spaceBefore, spaceAfter) {
      const sp = spaceBefore !== undefined ? spaceBefore : 0;
      const sa = spaceAfter  !== undefined ? spaceAfter  : 120;
      const pStyle = styleId ? `<w:pStyle w:val="${styleId}"/>` : '';
      const pPr = `<w:pPr>${pStyle}<w:spacing w:before="${sp}" w:after="${sa}"/></w:pPr>`;
      return `<w:p>${pPr}${inner}</w:p>`;
    }

    function makeHyperlink(text, url) {
      let rId = hrefMap.get(url);
      if (!rId) {
        rId = `rId${rIdHref++}`;
        hrefMap.set(url, rId);
        hrefRels.push({ id: rId, type: 'hyperlink', target: url });
      }
      return `<w:hyperlink r:id="${rId}"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr><w:t xml:space="preserve">${xe(text)}</w:t></w:r></w:hyperlink>`;
    }

    function makeImage(url) {
      const { dims } = imgRelMap.get(url);
      // 9525 EMU per pixel @ 96 DPI; max 6.5" wide = 5943600 EMU, 5" tall = 4572000 EMU
      const MAX_W = 5943600, MAX_H = 4572000;
      let cx, cy;
      if (dims && dims.w && dims.h) {
        cx = dims.w * 9525;
        cy = dims.h * 9525;
      } else {
        cx = 3810000; cy = 3810000; // ~400px fallback
      }
      if (cx > MAX_W) { cy = Math.round(cy * MAX_W / cx); cx = MAX_W; }
      if (cy > MAX_H) { cx = Math.round(cx * MAX_H / cy); cy = MAX_H; }
      const did = drawingId++;
      return `<w:p><w:pPr><w:spacing w:before="60" w:after="60"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${did}" name="Img${did}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${did}" name="Img${did}"/><pic:cNvPicPr><a:picLocks noChangeAspect="1"/></pic:cNvPicPr></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rel.rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    }

    // ── HTML → OOXML converter ───────────────────────────────────────────────

    function htmlToDocxBody(htmlStr) {
      if (!htmlStr) return [];
      const doc = new DOMParser().parseFromString(`<body>${htmlStr}</body>`, 'text/html');
      const out = [];

      function rpr(b, it, code, strike, col) {
        const p = [];
        if (b)      p.push('<w:b/><w:bCs/>');
        if (it)     p.push('<w:i/><w:iCs/>');
        if (strike) p.push('<w:strike/>');
        if (code)   p.push('<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="18"/><w:szCs w:val="18"/><w:shd w:val="clear" w:color="auto" w:fill="F0F0F0"/>');
        if (col)    p.push(`<w:color w:val="${col}"/>`);
        return p.length ? `<w:rPr>${p.join('')}</w:rPr>` : '';
      }

      function run(text, b, it, code, strike, col) {
        if (!text) return '';
        return `<w:r>${rpr(b,it,code,strike,col)}<w:t xml:space="preserve">${xe(text)}</w:t></w:r>`;
      }

      // Collect inline runs recursively, honouring bold/italic/code/strike/link
      function cr(node, b, it, code, strike, col) {
        let s = '';
        for (const c of node.childNodes) {
          if (c.nodeType === 3) {
            s += run(c.textContent, b, it, code, strike, col);
          } else if (c.nodeType === 1) {
            const t = c.tagName.toLowerCase();
            if      (t === 'strong' || t === 'b') s += cr(c, true,  it,   code,  strike, col);
            else if (t === 'em'     || t === 'i') s += cr(c, b,     true, code,  strike, col);
            else if (t === 'code')                s += cr(c, b,     it,   true,  strike, col);
            else if (t === 's' || t === 'del' || t === 'strike') s += cr(c, b, it, code, true, col);
            else if (t === 'a') {
              const href = c.getAttribute('href');
              const txt  = c.textContent.trim();
              if (href && txt) s += makeHyperlink(txt, href);
              else             s += cr(c, b, it, code, strike, col);
            }
            else if (t === 'br') s += '<w:r><w:br/></w:r>';
            else s += cr(c, b, it, code, strike, col);
          }
        }
        return s;
      }

      function para(inner, style, before, after, indL) {
        const sp  = `<w:spacing w:before="${before || 0}" w:after="${after !== undefined ? after : 80}"/>`;
        const ind = indL > 0 ? `<w:ind w:left="${indL}"/>` : '';
        const pst = style ? `<w:pStyle w:val="${style}"/>` : '';
        return `<w:p><w:pPr>${pst}${sp}${ind}</w:pPr>${inner}</w:p>`;
      }

      function codeLine(text) {
        return `<w:p><w:pPr><w:pStyle w:val="CodeBlock"/><w:spacing w:before="0" w:after="0"/></w:pPr>` +
               `<w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>` +
               `<w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>` +
               `<w:t xml:space="preserve">${xe(text)}</w:t></w:r></w:p>`;
      }

      function buildTable(tableEl) {
        const rows = [...tableEl.querySelectorAll('tr')];
        if (!rows.length) return '';
        const maxC = Math.max(...rows.map(r =>
          [...r.children].filter(c => /^t[dh]$/i.test(c.tagName)).length
        ));
        if (!maxC) return '';
        const tW = 9360, cW = Math.floor(tW / maxC);
        const bdr = s => `<w:${s} w:val="single" w:sz="4" w:color="CCCCCC" w:space="0"/>`;
        const borders = `<w:tblBorders>${['top','left','bottom','right','insideH','insideV'].map(bdr).join('')}</w:tblBorders>`;
        let x = `<w:tbl><w:tblPr><w:tblW w:w="${tW}" w:type="dxa"/>${borders}</w:tblPr>` +
                `<w:tblGrid>${Array(maxC).fill(`<w:gridCol w:w="${cW}"/>`).join('')}</w:tblGrid>`;
        for (const row of rows) {
          const cells = [...row.children].filter(c => /^t[dh]$/i.test(c.tagName));
          const isH   = row.parentElement?.tagName.toLowerCase() === 'thead' ||
                        cells.some(c => c.tagName.toLowerCase() === 'th');
          x += '<w:tr>';
          if (isH) x += '<w:trPr><w:tblHeader/></w:trPr>';
          for (let ci = 0; ci < maxC; ci++) {
            const cell  = cells[ci];
            const fill  = isH ? 'D5E8F0' : 'FFFFFF';
            const runs  = cell ? cr(cell, isH, false, false, false, isH ? '1F3864' : '') : run(' ');
            x += `<w:tc><w:tcPr><w:tcW w:w="${cW}" w:type="dxa"/>` +
                 `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` +
                 `<w:tcMar><w:top w:w="80" w:type="dxa"/><w:left w:w="120" w:type="dxa"/>` +
                 `<w:bottom w:w="80" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar></w:tcPr>` +
                 `<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>${runs || run(' ')}</w:p></w:tc>`;
          }
          x += '</w:tr>';
        }
        x += '</w:tbl>';
        return x;
      }

      function buildList(listEl, type, depth) {
        let n = 0;
        for (const li of listEl.childNodes) {
          if (li.nodeType !== 1 || li.tagName.toLowerCase() !== 'li') continue;
          n++;
          let runs = '', nested = [];
          for (const c of li.childNodes) {
            if (c.nodeType === 1 && /^[uo]l$/i.test(c.tagName)) nested.push(c);
            else runs += cr(c);
          }
          const indL = 720 + depth * 360;
          const pref = type === 'bullet' ? '•' : `${n}.`;
          out.push(`<w:p><w:pPr><w:spacing w:before="0" w:after="40"/>` +
                   `<w:ind w:left="${indL}" w:hanging="360"/></w:pPr>` +
                   `<w:r><w:t xml:space="preserve">${xe(pref)}\t</w:t></w:r>${runs}</w:p>`);
          for (const nl of nested)
            buildList(nl, nl.tagName.toLowerCase() === 'ol' ? 'number' : 'bullet', depth + 1);
        }
      }

      function walk(nodes, indBase) {
        for (const node of nodes) {
          if (node.nodeType === 3) {
            const txt = node.textContent.trim();
            if (txt) out.push(para(run(txt), null, 0, 80, indBase));
            continue;
          }
          if (node.nodeType !== 1) continue;
          const tag = node.tagName.toLowerCase();

          if (tag === 'p') {
            const runs = cr(node);
            if (runs) out.push(para(runs, null, 0, 80, indBase));
          } else if (/^h[1-6]$/.test(tag)) {
            const lvl = tag[1];
            const sp  = { 1:240, 2:200, 3:160, 4:120, 5:100, 6:80 }[lvl];
            out.push(para(cr(node, true), `Heading${lvl}`, sp, 80));
          } else if (tag === 'ul') {
            buildList(node, 'bullet', 0);
          } else if (tag === 'ol') {
            buildList(node, 'number', 0);
          } else if (tag === 'pre') {
            const codeEl = node.querySelector('code') || node;
            const lines  = codeEl.textContent.split('\n');
            if (lines.length && lines[lines.length - 1] === '') lines.pop();
            for (const ln of lines) out.push(codeLine(ln));
          } else if (tag === 'blockquote') {
            walk([...node.childNodes], (indBase || 0) + 720);
          } else if (tag === 'table') {
            const t = buildTable(node);
            if (t) out.push(t);
          } else if (tag === 'hr') {
            out.push(para('', null, 40, 40));
          } else if (['div','section','article','header','nav','main','aside'].includes(tag)) {
            walk([...node.childNodes], indBase);
          } else if (tag === 'br') {
            // skip bare br at block level
          } else {
            const runs = cr(node);
            if (runs) out.push(para(runs, null, 0, 80, indBase));
          }
        }
      }

      walk([...doc.body.childNodes], 0);
      return out;
    }

    // ── Build body ───────────────────────────────────────────────────────────

    const body = [];

    // Title
    body.push(makePara(makeRun(title, false, '', 0), 'Heading1', 0, 120));

    // Export metadata
    body.push(makePara(
      makeRun(`Exported ${new Date().toLocaleString()} · ${messages.length} messages`, false, '888888', 18),
      null, 0, 280
    ));

    for (const msg of messages) {
      const isUser = msg.role === 'user';
      const label  = isUser ? 'You' : 'Copilot';
      const color  = isUser ? '5a5a7a' : '0f6cbd';
      const ts     = msg.timestamp
        ? `   ${new Date(msg.timestamp).toLocaleString()}` : '';
      body.push(makePara(makeRun(label + ts, true, color, 20), null, 220, 60));

      // Use segments when available (preserves image position within text);
      // fall back to text-then-images for older cached messages.
      const segments = msg.segments && msg.segments.length
        ? msg.segments
        : [
            ...(msg.text ? [{ type: 'text', text: msg.text }] : []),
            ...(msg.images || []).map(i => ({ type: 'image', url: i.url, prompt: i.prompt || '' })),
          ];

      for (const seg of segments) {
        if (seg.type === 'image') {
          if (seg.url && imgRelMap.has(seg.url)) {
            body.push(makeImage(seg.url));
            if (seg.prompt) {
              body.push(makePara(makeRun(seg.prompt, false, '888888', 16), null, 40, 60));
            }
          } else if (seg.url) {
            body.push(makePara(
              makeRun(`[Image: ${seg.prompt || seg.url}]`, false, '888888', 16),
              null, 0, 60
            ));
          }
        } else {
          const htmlParts = seg.html ? htmlToDocxBody(seg.html) : null;
          if (htmlParts && htmlParts.length) {
            body.push(...htmlParts);
          } else if (seg.text) {
            for (const block of seg.text.split(/\n{2,}/)) {
              const lines = block.split('\n');
              let inner = '';
              lines.forEach((line, i) => {
                inner += makeRun(line, false, '', 0);
                if (i < lines.length - 1) inner += makeBr();
              });
              if (inner) body.push(makePara(inner, null, 0, 80));
            }
          }
        }
      }

      if (msg.citations && msg.citations.length) {
        let inner = makeRun('Sources: ', true, '555555', 18);
        msg.citations.forEach((c, i) => {
          if (i > 0) inner += makeRun(' · ', false, 'cccccc', 18);
          inner += makeHyperlink(c.name, c.url);
        });
        body.push(makePara(inner, null, 80, 80));
      }
    }

    // ── document.xml — all namespaces declared at root ───────────────────────

    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
${body.join('\n')}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`;

    // ── styles.xml ───────────────────────────────────────────────────────────

    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>
        <w:sz w:val="22"/>
        <w:szCs w:val="22"/>
      </w:rPr>
    </w:rPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:qFormat/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:spacing w:before="240" w:after="120"/>
      <w:outlineLvl w:val="0"/>
    </w:pPr>
    <w:rPr>
      <w:b/>
      <w:bCs/>
      <w:color w:val="0f6cbd"/>
      <w:sz w:val="36"/>
      <w:szCs w:val="36"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr>
    <w:rPr><w:b/><w:bCs/><w:color w:val="1F3864"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr><w:spacing w:before="160" w:after="60"/><w:outlineLvl w:val="2"/></w:pPr>
    <w:rPr><w:b/><w:bCs/><w:color w:val="2E5090"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading4">
    <w:name w:val="heading 4"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr><w:spacing w:before="120" w:after="40"/><w:outlineLvl w:val="3"/></w:pPr>
    <w:rPr><w:b/><w:bCs/><w:color w:val="2E5090"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading5">
    <w:name w:val="heading 5"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr><w:spacing w:before="100" w:after="40"/><w:outlineLvl w:val="4"/></w:pPr>
    <w:rPr><w:b/><w:bCs/><w:color w:val="595959"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading6">
    <w:name w:val="heading 6"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr><w:spacing w:before="80" w:after="40"/><w:outlineLvl w:val="5"/></w:pPr>
    <w:rPr><w:b/><w:bCs/><w:i/><w:iCs/><w:color w:val="595959"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="CodeBlock">
    <w:name w:val="Code Block"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr>
      <w:spacing w:before="0" w:after="0"/>
      <w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/>
      <w:ind w:left="120" w:right="120"/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>
      <w:sz w:val="18"/>
      <w:szCs w:val="18"/>
    </w:rPr>
  </w:style>
  <w:style w:type="character" w:styleId="Hyperlink">
    <w:name w:val="Hyperlink"/>
    <w:basedOn w:val="DefaultParagraphFont"/>
    <w:rPr>
      <w:color w:val="0563C1"/>
      <w:u w:val="single"/>
    </w:rPr>
  </w:style>
</w:styles>`;

    // ── settings.xml ─────────────────────────────────────────────────────────

    const settingsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:defaultTabStop w:val="720"/>
</w:settings>`;

    // ── document.xml.rels ────────────────────────────────────────────────────

    const BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const relTypeOf = {
      styles:    `${BASE}/styles`,
      settings:  `${BASE}/settings`,
      image:     `${BASE}/image`,
      hyperlink: `${BASE}/hyperlink`,
    };

    const allDocRels = [
      { id: 'rId1', type: 'styles',   target: 'styles.xml',   ext: false },
      { id: 'rId2', type: 'settings', target: 'settings.xml', ext: false },
      ...imgRels.map(r => ({ ...r, ext: false })),
      ...hrefRels.map(r => ({ ...r, ext: true })),
    ];

    const docRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${allDocRels.map(r =>
  `  <Relationship Id="${r.id}" Type="${relTypeOf[r.type]}" Target="${xe(r.target)}"${r.ext ? ' TargetMode="External"' : ''}/>`
).join('\n')}
</Relationships>`;

    // ── _rels/.rels ──────────────────────────────────────────────────────────

    const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

    // ── [Content_Types].xml ──────────────────────────────────────────────────

    const mediaExts = [...new Set(mediaFiles.map(f => f.name.split('.').pop()))];
    const mediaDefaults = mediaExts.map(e => {
      const ct = e === 'png' ? 'image/png' : 'image/jpeg';
      return `  <Default Extension="${e}" ContentType="${ct}"/>`;
    }).join('\n');

    const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
${mediaDefaults}
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
</Types>`;

    // ── Assemble ZIP entries ─────────────────────────────────────────────────

    return [
      { name: '[Content_Types].xml',          data: enc.encode(contentTypesXml) },
      { name: '_rels/.rels',                  data: enc.encode(rootRelsXml) },
      { name: 'word/document.xml',            data: enc.encode(documentXml) },
      { name: 'word/_rels/document.xml.rels', data: enc.encode(docRelsXml) },
      { name: 'word/styles.xml',              data: enc.encode(stylesXml) },
      { name: 'word/settings.xml',            data: enc.encode(settingsXml) },
      ...mediaFiles,
    ];
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  global.buildDocx = function (messages, title, imageDataMap) {
    return buildZip(buildDocxFiles(messages, title, imageDataMap || {}));
  };

})(typeof window !== 'undefined' ? window : globalThis);
