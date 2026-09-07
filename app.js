import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.worker.min.mjs';

const DB_NAME = 'paperless-workspace';
const DB_VERSION = 1;
const STORE = 'documents';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const state = {
  docs: [],
  current: null,
  currentPdf: null,
  page: 1,
  mode: 'read',
  binderOrder: [],
  searchTimer: null,
  renderTask: null,
};

function esc(value = '') {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function normalize(s = '') { return String(s).replace(/\s+/g, ' ').trim(); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function status(text = '') { $('#status').textContent = text; }
function slugify(s) { return normalize(s).replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'binder'; }

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbGetAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function dbGet(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function dbPut(doc) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(doc);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function dbDelete(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function fingerprint(file) {
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  return { id: hex.slice(0, 24), bytes };
}

function groupItemsIntoLines(items, viewportHeight) {
  const usable = items.filter(i => normalize(i.str));
  usable.sort((a, b) => {
    const dy = b.transform[5] - a.transform[5];
    return Math.abs(dy) > 2.5 ? dy : a.transform[4] - b.transform[4];
  });
  const lines = [];
  for (const item of usable) {
    const y = item.transform[5];
    let line = lines.find(l => Math.abs(l.y - y) <= 2.5);
    if (!line) {
      line = { y, items: [] };
      lines.push(line);
    }
    line.items.push(item);
  }
  lines.sort((a, b) => b.y - a.y);
  return lines.map(line => {
    line.items.sort((a, b) => a.transform[4] - b.transform[4]);
    const text = normalize(line.items.map(x => x.str).join(' '));
    const weighted = line.items.reduce((acc, x) => {
      const size = Math.abs(x.height || x.transform[3] || 0);
      const weight = Math.max(1, normalize(x.str).length);
      acc.sum += size * weight; acc.weight += weight;
      return acc;
    }, { sum: 0, weight: 0 });
    const size = weighted.weight ? weighted.sum / weighted.weight : 10;
    const x = Math.min(...line.items.map(i => i.transform[4]));
    const bold = line.items.some(i => /bold|black|semibold|demi/i.test(i.fontName || ''));
    return {
      text, size: +size.toFixed(2), bold, x: +x.toFixed(1), y: +line.y.toFixed(1),
      topRatio: viewportHeight ? 1 - (line.y / viewportHeight) : 0.5
    };
  }).filter(l => l.text);
}

function dominantBodySize(pageLines) {
  const weights = new Map();
  for (const lines of pageLines) {
    for (const l of lines) {
      if (l.size < 6 || l.size > 40 || l.text.length < 3) continue;
      const k = Math.round(l.size * 2) / 2;
      weights.set(k, (weights.get(k) || 0) + Math.min(l.text.length, 160));
    }
  }
  if (!weights.size) return 10;
  return [...weights.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function inferStructure(pageLines, bodySize) {
  const repeated = new Map();
  for (const lines of pageLines) {
    for (const l of lines) repeated.set(l.text, (repeated.get(l.text) || 0) + 1);
  }
  const candidates = [];
  pageLines.forEach((lines, pIdx) => {
    for (const l of lines) {
      const text = l.text;
      if (text.length < 2 || text.length > 180) continue;
      if ((repeated.get(text) || 0) > Math.max(3, Math.floor(pageLines.length * .18))) continue;
      if (l.topRatio < .035 || l.topRatio > .94) continue;
      const numbered = /^(?:\d+(?:\.\d+){0,5}|[A-Z]\.|chapter\s+\d+|appendix\s+[A-Z0-9]+)\b/i.test(text);
      const caps = text.length >= 4 && text.length < 90 && text === text.toUpperCase() && /[A-Z]/.test(text);
      let score = 0;
      if (l.size >= bodySize * 1.45) score += 4;
      else if (l.size >= bodySize * 1.25) score += 3;
      else if (l.size >= bodySize * 1.10) score += 2;
      else if (l.size >= bodySize * 1.02) score += 1;
      if (l.bold) score += 1;
      if (numbered) score += 2;
      if (caps) score += 1;
      if (score >= 3) candidates.push({ ...l, page: pIdx + 1, score });
    }
  });
  if (!candidates.length) return [];
  const sizes = [...new Set(candidates.map(c => c.size))].sort((a, b) => b - a);
  const structure = candidates.map(c => {
    const m = c.text.match(/^(\d+(?:\.\d+)*)\b/);
    let level;
    if (m) level = Math.min(5, m[1].split('.').length);
    else if (/^(chapter|appendix)\b/i.test(c.text)) level = 1;
    else level = Math.min(4, Math.max(1, sizes.indexOf(c.size) + 1));
    return { level, title: c.text, page: c.page, source: 'inferred' };
  });
  const clean = [];
  for (const h of structure) {
    const prev = clean[clean.length - 1];
    if (prev && prev.title === h.title && Math.abs(prev.page - h.page) <= 1) continue;
    clean.push(h);
  }
  return clean.slice(0, 3000);
}

async function outlineStructure(pdf) {
  const outline = await pdf.getOutline();
  if (!outline?.length) return [];
  const out = [];
  async function walk(items, level) {
    for (const item of items) {
      let page = 1;
      try {
        let dest = item.dest;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        if (Array.isArray(dest) && dest[0]) page = (await pdf.getPageIndex(dest[0])) + 1;
      } catch (_) {}
      const title = normalize(item.title);
      if (title) out.push({ level, title, page, source: 'bookmark' });
      if (item.items?.length) await walk(item.items, level + 1);
    }
  }
  await walk(outline, 1);
  return out;
}

function mapSections(structure, pages) {
  const sorted = [...structure].sort((a, b) => a.page - b.page || a.level - b.level);
  const sections = new Array(pages).fill('');
  let current = '', idx = 0;
  for (let p = 1; p <= pages; p++) {
    while (idx < sorted.length && sorted[idx].page <= p) {
      current = sorted[idx].title;
      idx++;
    }
    sections[p - 1] = current;
  }
  return sections;
}

async function parsePdf(file, bytes, id) {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
  const pageLines = [];
  const pageTexts = [];
  let visibleChars = 0;

  for (let p = 1; p <= pdf.numPages; p++) {
    status(`Indexing ${file.name} · page ${p}/${pdf.numPages}`);
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const lines = groupItemsIntoLines(content.items, viewport.height);
    pageLines.push(lines);
    const text = normalize(lines.map(l => l.text).join('\n'));
    pageTexts.push(text);
    visibleChars += text.length;
  }

  if (visibleChars < Math.max(30, pdf.numPages * 4)) {
    throw new Error('This looks image-only or scanned. Paperless currently supports born-digital PDFs only.');
  }

  let structure = await outlineStructure(pdf);
  const bodySize = dominantBodySize(pageLines);
  if (!structure.length) structure = inferStructure(pageLines, bodySize);
  const sections = mapSections(structure, pdf.numPages);
  let metadata = {};
  try {
    const meta = await pdf.getMetadata();
    metadata = meta?.info || {};
  } catch (_) {}
  await pdf.destroy();

  return {
    id, name: file.name, size: file.size, created: Date.now(), pages: pageTexts.length,
    bytes, pageTexts, pageLines, structure, sections, bodySize, metadata
  };
}

async function importFiles(files) {
  const pdfs = [...files].filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
  if (!pdfs.length) return;
  for (const file of pdfs) {
    try {
      status(`Opening ${file.name}…`);
      const { id, bytes } = await fingerprint(file);
      const existing = await dbGet(id);
      if (existing) {
        status(`${file.name} is already in your library.`);
        continue;
      }
      const doc = await parsePdf(file, bytes, id);
      await dbPut(doc);
      await loadDocs();
      await openDoc(id);
      status(`Ready · ${doc.pages} pages · ${doc.structure.length} headings`);
    } catch (err) {
      console.error(err);
      status(`Could not import ${file.name}`);
      alert(`${file.name}\n\n${err.message || err}`);
    }
  }
}

async function loadDocs() {
  const all = await dbGetAll();
  state.docs = all.sort((a, b) => b.created - a.created).map(d => ({
    id: d.id, name: d.name, pages: d.pages, structureCount: d.structure?.length || 0, created: d.created
  }));
  const known = new Set(state.docs.map(d => d.id));
  state.binderOrder = state.binderOrder.filter(id => known.has(id));
  for (const d of state.docs) if (!state.binderOrder.includes(d.id)) state.binderOrder.push(d.id);
  renderDocs();
  renderBinder();
}

function renderDocs() {
  const el = $('#docs');
  if (!state.docs.length) {
    el.innerHTML = '<div class="noDocs">No PDFs yet.<br>Open or drop a born-digital PDF to start.</div>';
    return;
  }
  el.innerHTML = state.docs.map(d => `
    <div class="docCard ${state.current?.id === d.id ? 'active' : ''}" data-id="${d.id}">
      <b title="${esc(d.name)}">${esc(d.name)}</b>
      <span>${d.pages} pages · ${d.structureCount} headings</span>
      <button class="docDelete" data-delete="${d.id}" title="Remove from this device">×</button>
    </div>`).join('');
  $$('.docCard').forEach(card => card.addEventListener('click', e => {
    if (e.target.closest('[data-delete]')) return;
    openDoc(card.dataset.id);
  }));
  $$('[data-delete]').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const id = btn.dataset.delete;
    const d = state.docs.find(x => x.id === id);
    if (!confirm(`Remove “${d?.name || 'this PDF'}” from this browser?\n\nThe original file on your computer is not touched.`)) return;
    await dbDelete(id);
    if (state.current?.id === id) {
      state.current = null;
      state.currentPdf = null;
      renderEmpty();
    }
    await loadDocs();
  }));
}

function renderEmpty() {
  $('#docPane').classList.add('empty');
  $('#docPane').innerHTML = `
    <div class="emptyState">
      <span class="eyebrow">Born-digital PDFs</span>
      <h1>Make PDFs behave like software.</h1>
      <p>Open a PDF and Paperless will infer its structure, index its contents, and turn it into a navigable workspace. Nothing is uploaded.</p>
      <button class="primary" onclick="document.getElementById('fileInput').click()">Open a PDF</button>
    </div>`;
}

async function openDoc(id) {
  status('Opening…');
  const doc = await dbGet(id);
  if (!doc) return;
  if (state.currentPdf) {
    try { await state.currentPdf.destroy(); } catch (_) {}
  }
  state.current = doc;
  state.currentPdf = await pdfjsLib.getDocument({ data: new Uint8Array(doc.bytes.slice(0)) }).promise;
  state.page = 1;
  state.mode = 'read';
  $('#searchScope').value = 'current';
  $('#searchBox').placeholder = 'Search this PDF…';
  $('#searchBox').value = '';
  renderDocs();
  renderWorkspace();
  await showPage(1);
  status(`${doc.pages} pages · ${doc.structure.length} headings`);
}

function renderWorkspace() {
  const doc = state.current;
  if (!doc) return renderEmpty();
  $('#docPane').classList.remove('empty');
  const tree = doc.structure.length ? doc.structure.map(h => `
    <button class="headingBtn" data-page="${h.page}" style="padding-left:${8 + (clamp(h.level,1,5)-1)*14}px" title="${esc(h.source)}">
      ${esc(h.title)}
    </button>`).join('') : '<div class="noDocs">No structure confidently detected. Search and page browsing still work.</div>';
  $('#docPane').innerHTML = `
    <div class="workspace">
      <aside class="outline">
        <div class="outlineTop"><h2>${esc(doc.name)}</h2><small>${doc.pages} pages · ${doc.structure.length} headings</small></div>
        <div class="segmented"><button id="readMode" class="active">Reading</button><button id="sourceMode">Source</button></div>
        <div id="outlineBody" class="outlineBody">${tree}</div>
      </aside>
      <section class="reader" id="reader">
        <div id="pageBody"></div>
        <div class="pager">
          <button id="prevPage" aria-label="Previous page">←</button>
          <input id="pageInput" class="pageInput" inputmode="numeric" value="1" aria-label="Page number">
          <span id="pageCount">/ ${doc.pages}</span>
          <button id="nextPage" aria-label="Next page">→</button>
        </div>
      </section>
    </div>`;
  $$('.headingBtn').forEach(btn => btn.addEventListener('click', () => showPage(+btn.dataset.page)));
  $('#readMode').addEventListener('click', () => setMode('read'));
  $('#sourceMode').addEventListener('click', () => setMode('source'));
  $('#prevPage').addEventListener('click', () => showPage(state.page - 1));
  $('#nextPage').addEventListener('click', () => showPage(state.page + 1));
  $('#pageInput').addEventListener('change', () => showPage(Number($('#pageInput').value)));
  $('#pageInput').addEventListener('keydown', e => { if (e.key === 'Enter') showPage(Number(e.currentTarget.value)); });
}

async function setMode(mode) {
  state.mode = mode;
  $('#readMode')?.classList.toggle('active', mode === 'read');
  $('#sourceMode')?.classList.toggle('active', mode === 'source');
  await showPage(state.page);
}

function headingLevelForLine(line, page) {
  const normalized = normalize(line.text);
  const match = state.current.structure.find(h => h.page === page && normalize(h.title) === normalized);
  return match ? clamp(match.level, 1, 3) : 0;
}

async function showPage(p) {
  if (!state.current) return;
  const page = clamp(Number.isFinite(+p) ? +p : 1, 1, state.current.pages);
  state.page = page;
  if ($('#pageInput')) $('#pageInput').value = page;
  if ($('#reader')) $('#reader').scrollTop = 0;
  const body = $('#pageBody');
  if (!body) return;

  if (state.mode === 'source') {
    body.innerHTML = '<canvas id="sourceCanvas" class="sourceCanvas"></canvas>';
    const pdfPage = await state.currentPdf.getPage(page);
    const base = pdfPage.getViewport({ scale: 1 });
    const targetWidth = Math.min(1100, Math.max(650, ($('#reader')?.clientWidth || 900) - 70));
    const scale = targetWidth / base.width;
    const viewport = pdfPage.getViewport({ scale });
    const canvas = $('#sourceCanvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (state.renderTask) { try { state.renderTask.cancel(); } catch (_) {} }
    state.renderTask = pdfPage.render({ canvasContext: ctx, viewport });
    try { await state.renderTask.promise; } catch (e) { if (e?.name !== 'RenderingCancelledException') throw e; }
    return;
  }

  const lines = state.current.pageLines[page - 1] || [];
  const bodySize = state.current.bodySize || 10;
  const rendered = lines.map(line => {
    const level = headingLevelForLine(line, page);
    let cls = 'readLine';
    if (level) cls += ` heading${level}`;
    else if (line.size >= bodySize * 1.35) cls += ' heading2';
    return `<p class="${cls}">${esc(line.text)}</p>`;
  }).join('');
  body.innerHTML = `<article class="paper"><div class="pageMeta">Page ${page} of ${state.current.pages}</div>${rendered || '<p class="readLine">No extractable text on this page.</p>'}</article>`;
}

function makeSnippet(text, tokens, radius = 110) {
  const low = text.toLowerCase();
  let idx = Infinity;
  for (const t of tokens) {
    const i = low.indexOf(t.toLowerCase());
    if (i >= 0) idx = Math.min(idx, i);
  }
  if (!Number.isFinite(idx)) idx = 0;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + radius);
  let out = esc(text.slice(start, end));
  for (const token of tokens.sort((a,b) => b.length - a.length)) {
    const safe = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(${safe})`, 'gi'), '<mark>$1</mark>');
  }
  return `${start ? '…' : ''}${out}${end < text.length ? '…' : ''}`;
}

function searchDoc(doc, q) {
  const tokens = normalize(q).toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const results = [];
  doc.pageTexts.forEach((text, idx) => {
    const low = text.toLowerCase();
    if (!tokens.every(t => low.includes(t))) return;
    results.push({
      docId: doc.id, name: doc.name, page: idx + 1,
      section: doc.sections?.[idx] || '', snippet: makeSnippet(text, tokens)
    });
  });
  return results;
}

async function runSearch(q) {
  q = normalize(q);
  if (!q) {
    if (state.current) { renderWorkspace(); await showPage(state.page); }
    status(state.current ? `${state.current.pages} pages · ${state.current.structure.length} headings` : '');
    return;
  }
  const scope = $('#searchScope').value;
  let results = [];
  if (scope === 'current' && state.current) {
    results = searchDoc(state.current, q);
  } else {
    status('Searching library…');
    const all = await dbGetAll();
    for (const doc of all) results.push(...searchDoc(doc, q));
  }
  results = results.slice(0, 250);
  status(`${results.length}${results.length === 250 ? '+' : ''} matches`);

  if (!state.current && results[0]) await openDoc(results[0].docId);
  if (!state.current) return;
  const outline = $('#outlineBody');
  if (!outline) return;
  let html = '';
  let lastDoc = null;
  for (const r of results) {
    if (scope === 'all' && r.name !== lastDoc) {
      html += `<div class="searchGroup">${esc(r.name)}</div>`;
      lastDoc = r.name;
    }
    html += `<div class="result" data-doc="${r.docId}" data-page="${r.page}"><b>${esc(r.section || `Page ${r.page}`)}</b><small>Page ${r.page}</small><p>${r.snippet}</p></div>`;
  }
  outline.innerHTML = html || '<div class="noDocs">No matches.</div>';
  $$('.result').forEach(r => r.addEventListener('click', async () => {
    const id = r.dataset.doc;
    const page = +r.dataset.page;
    if (state.current?.id !== id) await openDoc(id);
    await showPage(page);
  }));
}

function renderBinder() {
  const el = $('#binderDocs');
  if (!state.docs.length) {
    el.innerHTML = '<div class="noDocs">Load some PDFs first.</div>';
    return;
  }
  const orderedDocs = state.binderOrder.map(id => state.docs.find(d => d.id === id)).filter(Boolean);
  el.innerHTML = orderedDocs.map((d, idx) => `
    <div class="binderRow" data-binder-id="${d.id}">
      <input type="checkbox" id="bind_${d.id}" value="${d.id}" checked>
      <label for="bind_${d.id}"><b>${esc(d.name)}</b><br><small>${d.pages} pages · ${d.structureCount} headings</small></label>
      <div class="reorder"><button data-up="${idx}" title="Move up">↑</button><button data-down="${idx}" title="Move down">↓</button></div>
    </div>`).join('');
  $$('[data-up]').forEach(btn => btn.addEventListener('click', () => moveBinder(+btn.dataset.up, -1)));
  $$('[data-down]').forEach(btn => btn.addEventListener('click', () => moveBinder(+btn.dataset.down, 1)));
}
function moveBinder(idx, delta) {
  const next = idx + delta;
  if (next < 0 || next >= state.binderOrder.length) return;
  [state.binderOrder[idx], state.binderOrder[next]] = [state.binderOrder[next], state.binderOrder[idx]];
  renderBinder();
}

async function buildBinder() {
  if (!window.PDFLib) return alert('Binder library did not load. Check your internet connection and reload the page.');
  const selected = $$('#binderDocs input[type="checkbox"]:checked').map(x => x.value);
  if (!selected.length) return alert('Select at least one PDF.');
  const ordered = state.binderOrder.filter(id => selected.includes(id));
  const docs = [];
  for (const id of ordered) {
    const d = await dbGet(id);
    if (d) docs.push(d);
  }
  const title = normalize($('#binderTitle').value) || 'Compiled Binder';
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
  const out = await PDFDocument.create();
  out.setTitle(title);
  out.setCreator('Paperless');
  out.setProducer('Paperless Binder');
  const font = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);

  const indexRows = [];
  for (const d of docs) {
    indexRows.push({ type: 'doc', title: d.name, doc: d });
    for (const h of (d.structure || []).filter(h => h.level === 1).slice(0, 14)) {
      indexRows.push({ type: 'section', title: h.title, localPage: h.page, doc: d });
    }
  }
  const rowsPerPage = 34;
  const indexPageCount = Math.max(1, Math.ceil(indexRows.length / rowsPerPage));
  const prefixPages = 1 + indexPageCount;
  let cumulative = 0;
  const docStarts = new Map();
  docs.forEach(d => { docStarts.set(d.id, prefixPages + cumulative + 1); cumulative += d.pages; });

  let page = out.addPage([612, 792]);
  page.drawText(title, { x: 54, y: 650, size: 28, font: bold, color: rgb(.08,.09,.11) });
  page.drawText('Compiled with Paperless', { x: 54, y: 618, size: 11, font, color: rgb(.42,.45,.50) });
  page.drawText(`${docs.length} documents · ${docs.reduce((n,d) => n + d.pages, 0)} source pages`, { x: 54, y: 588, size: 12, font, color: rgb(.20,.22,.25) });

  for (let ip = 0; ip < indexPageCount; ip++) {
    page = out.addPage([612, 792]);
    page.drawText(ip === 0 ? 'Binder Index' : 'Binder Index — continued', { x: 54, y: 738, size: 18, font: bold, color: rgb(.08,.09,.11) });
    let y = 704;
    const rows = indexRows.slice(ip * rowsPerPage, (ip + 1) * rowsPerPage);
    for (const row of rows) {
      const start = docStarts.get(row.doc.id);
      const pageNo = row.type === 'doc' ? start : start + row.localPage - 1;
      const indent = row.type === 'section' ? 16 : 0;
      const size = row.type === 'doc' ? 10.5 : 9.2;
      const useFont = row.type === 'doc' ? bold : font;
      const maxChars = row.type === 'doc' ? 70 : 76;
      const label = row.title.length > maxChars ? row.title.slice(0, maxChars - 1) + '…' : row.title;
      page.drawText(label, { x: 54 + indent, y, size, font: useFont, color: rgb(.16,.18,.21) });
      page.drawText(String(pageNo), { x: 526, y, size, font, color: rgb(.36,.39,.43) });
      y -= 19;
    }
  }

  status('Building binder…');
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    status(`Building binder · ${i + 1}/${docs.length}`);
    const src = await PDFDocument.load(d.bytes.slice(0), { ignoreEncryption: true });
    const copied = await out.copyPages(src, src.getPageIndices());
    copied.forEach(p => out.addPage(p));
  }
  const bytes = await out.save({ useObjectStreams: true });
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const filename = `${slugify(title)}.pdf`;
  $('#binderResult').innerHTML = `<div class="downloadCard">Binder ready: <a id="binderDownload" download="${esc(filename)}">Download ${esc(filename)}</a></div>`;
  $('#binderDownload').href = url;
  status('Binder ready');
}

function switchView(view) {
  $$('.nav').forEach(n => n.classList.toggle('active', n.dataset.view === view));
  $$('.view').forEach(v => v.classList.remove('active'));
  $(`#${view}View`).classList.add('active');
  if (view === 'binder') renderBinder();
}

function wireUi() {
  const pick = () => $('#fileInput').click();
  $('#openBtn').addEventListener('click', pick);
  $('#libraryOpenBtn').addEventListener('click', pick);
  $('#emptyOpenBtn').addEventListener('click', pick);
  $('#fileInput').addEventListener('change', async e => {
    await importFiles(e.target.files);
    e.target.value = '';
  });
  $$('.nav').forEach(n => n.addEventListener('click', () => switchView(n.dataset.view)));
  $('#searchBox').addEventListener('input', e => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => runSearch(e.target.value), 160);
  });
  $('#searchScope').addEventListener('change', () => {
    $('#searchBox').placeholder = $('#searchScope').value === 'all' ? 'Search all PDFs…' : 'Search this PDF…';
    if ($('#searchBox').value) runSearch($('#searchBox').value);
  });
  $('#buildBinder').addEventListener('click', buildBinder);

  let dragDepth = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('#dropOverlay').classList.add('show'); });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('dragleave', e => { e.preventDefault(); dragDepth--; if (dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').classList.remove('show'); } });
  window.addEventListener('drop', async e => {
    e.preventDefault(); dragDepth = 0; $('#dropOverlay').classList.remove('show');
    if (e.dataTransfer?.files?.length) await importFiles(e.dataTransfer.files);
  });
  window.addEventListener('keydown', e => {
    if (!state.current || ['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName)) return;
    if (e.key === 'ArrowLeft') showPage(state.page - 1);
    if (e.key === 'ArrowRight') showPage(state.page + 1);
  });
}

(async function init() {
  wireUi();
  await loadDocs();
  if (state.docs.length) await openDoc(state.docs[0].id);
  else status('Ready');
})();
