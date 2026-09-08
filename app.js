import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.worker.min.mjs';

const DB_NAME = 'pdfed-workspace';
const DB_VERSION = 2;
const STORE = 'documents';
const PARSER_VERSION = 3;
const APP_VERSION = '0.7';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const state = {
  docs: [],
  current: null,
  currentPdf: null,
  currentPdfTask: null,
  page: 1,
  currentSectionId: null,
  mode: 'read',
  sideTab: 'outline',
  binderOrder: [],
  searchTimer: null,
  renderTask: null,
  planIndex: null,
  annotationTool: 'select',
  annotationDraft: null,
  selectedAnnotationId: null,
  annotationDefaults: { color: '#356fc4', opacity: 1, lineWidth: 3 },
  exportPending: null,
  compareA: null,
  compareB: null,
  compareData: null,
  libraryFilter: 'all',
  libraryQuery: '',
  binderMeta: {},
  thumbObserver: null,
};

function esc(value = '') {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function normalize(s = '') { return String(s).replace(/\s+/g, ' ').trim(); }
function canonical(s = '') { return normalize(s).toLowerCase().replace(/[–—]/g, '-'); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function status(text = '') { $('#status').textContent = text; }
function slugify(s) { return normalize(s).replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'binder'; }
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0, at = 0;
  while ((at = haystack.indexOf(needle, at)) >= 0) { count++; at += Math.max(1, needle.length); }
  return count;
}

function bytesLabel(n=0) {
  if (!n) return '0 KB';
  const units=['B','KB','MB','GB']; let i=0,v=n;
  while(v>=1024 && i<units.length-1){v/=1024;i++;}
  return `${v>=10 || i===0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
function dateLabel(ts) {
  if (!ts) return 'Never';
  const d=new Date(ts), now=new Date();
  const days=Math.floor((now-d)/86400000);
  if(days<=0) return 'Today'; if(days===1) return 'Yesterday'; if(days<7) return `${days} days ago`;
  return d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:d.getFullYear()===now.getFullYear()?undefined:'numeric'});
}
function uid(prefix='id') { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`; }
function defaultAnnotationColor(type='rect') {
  if (type === 'highlight') return '#ffd94d';
  if (type === 'underline') return '#e64f2d';
  if (type === 'strikeout') return '#c52f2f';
  if (type === 'text') return '#b99c35';
  if (type === 'note') return '#ffc845';
  if (type === 'redact') return '#111111';
  return '#356fc4';
}
function hexRgb(hex='#356fc4') {
  const clean=String(hex).replace('#','').trim();
  const full=clean.length===3?clean.split('').map(c=>c+c).join(''):clean.padEnd(6,'0').slice(0,6);
  return [parseInt(full.slice(0,2),16)/255,parseInt(full.slice(2,4),16)/255,parseInt(full.slice(4,6),16)/255];
}
function normalizeAnnotation(a={}) {
  a.color ||= defaultAnnotationColor(a.type);
  a.opacity = Number.isFinite(+a.opacity) ? clamp(+a.opacity,.08,1) : (a.type==='highlight'?.34:1);
  a.lineWidth = Number.isFinite(+a.lineWidth) ? clamp(+a.lineWidth,1,10) : 3;
  return a;
}
function hasRedactions(doc=state.current) { return !!doc && annotationsFor(doc).some(a=>a.type==='redact'); }
function ensureEditState(doc) {
  doc.editState ||= {};
  if (!Array.isArray(doc.editState.pageOrder) || !doc.editState.pageOrder.length) {
    doc.editState.pageOrder = Array.from({length:doc.pages||0},(_,i)=>({uid:uid('p'),sourcePage:i+1,rotation:0}));
  } else {
    doc.editState.pageOrder = doc.editState.pageOrder.map((e,i) => {
      if (typeof e === 'number') return {uid:uid('p'),sourcePage:e,rotation:0};
      return {uid:e.uid||uid('p'),sourcePage:+e.sourcePage||i+1,rotation:((+e.rotation||0)%360+360)%360};
    }).filter(e=>e.sourcePage>=1 && e.sourcePage<=doc.pages);
  }
  if (!Array.isArray(doc.editState.annotations)) doc.editState.annotations=[];
  doc.editState.annotations = doc.editState.annotations.map(normalizeAnnotation);
  doc.editState.dirty = !!doc.editState.dirty;
  return doc.editState;
}
function planFor(doc=state.current) { return doc ? ensureEditState(doc).pageOrder : []; }
function annotationsFor(doc=state.current) { return doc ? ensureEditState(doc).annotations : []; }
function currentPlanEntry() {
  const plan=planFor();
  if(Number.isInteger(state.planIndex) && plan[state.planIndex]) return plan[state.planIndex];
  const idx=plan.findIndex(e=>e.sourcePage===state.page);
  return plan[idx] || {uid:`source_${state.page}`,sourcePage:state.page,rotation:0};
}
async function saveCurrentEdits(message='Edits saved locally') {
  if(!state.current) return;
  state.current.updated=Date.now();
  ensureEditState(state.current).dirty=true;
  await dbPut(state.current);
  await loadDocs();
  status(message);
}

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

function mergeTextCells(items) {
  if (!items.length) return [];
  const cells = [];
  let cur = null;
  for (const item of [...items].sort((a,b) => a.transform[4] - b.transform[4])) {
    const text = normalize(item.str);
    if (!text) continue;
    const x = item.transform[4];
    const right = x + Math.abs(item.width || 0);
    const size = Math.abs(item.height || item.transform[3] || 10);
    if (!cur || x - cur.right > Math.max(12, size * 1.55)) {
      if (cur) cells.push(cur);
      cur = { text, x, right, size };
    } else {
      cur.text = normalize(`${cur.text} ${text}`);
      cur.right = Math.max(cur.right, right);
      cur.size = (cur.size + size) / 2;
    }
  }
  if (cur) cells.push(cur);
  return cells;
}

function splitWideColumnCollisions(lines, pageWidth) {
  if (!pageWidth) return lines;
  const out=[];
  for(const line of lines){
    const cells=line.cells||[];
    if(cells.length<2){out.push(line);continue;}
    let bestGap=0,bestIdx=-1;
    for(let i=0;i<cells.length-1;i++){
      const gap=cells[i+1].x-cells[i].right;
      if(gap>bestGap){bestGap=gap;bestIdx=i;}
    }
    if(bestGap<pageWidth*.14){out.push(line);continue;}
    const left=cells.slice(0,bestIdx+1), right=cells.slice(bestIdx+1);
    const lt=normalize(left.map(c=>c.text).join(' ')), rt=normalize(right.map(c=>c.text).join(' '));
    // Long text on both sides is much more likely to be two columns than a table row.
    if(lt.length<18 || rt.length<18){out.push(line);continue;}
    const make=(group,text)=>({...line,text,x:group[0].x,right:group[group.length-1].right,width:group[group.length-1].right-group[0].x,cells:group});
    out.push(make(left,lt),make(right,rt));
  }
  return out;
}

function orderPageLines(lines, pageWidth) {
  if (lines.length < 12 || !pageWidth) return lines;
  const bodyish = lines.filter(l => l.width < pageWidth * .52 && l.text.length > 18 && !l.boilerplate);
  const left = bodyish.filter(l => l.x < pageWidth * .42);
  const right = bodyish.filter(l => l.x > pageWidth * .46);
  const likelyTwoColumn = left.length >= 5 && right.length >= 5 && (left.length + right.length) >= bodyish.length * .68;
  if (!likelyTwoColumn) return lines;

  const spanning = lines.filter(l => l.width >= pageWidth * .58 || (l.x < pageWidth * .25 && l.right > pageWidth * .72));
  const firstColumnY = Math.max(...bodyish.map(l => l.y), -Infinity);
  const topSpanning = spanning.filter(l => l.y >= firstColumnY - 16).sort((a,b) => b.y-a.y || a.x-b.x);
  const rest = lines.filter(l => !topSpanning.includes(l));
  const leftCol = rest.filter(l => l.x < pageWidth * .48).sort((a,b) => b.y-a.y || a.x-b.x);
  const rightCol = rest.filter(l => l.x >= pageWidth * .48).sort((a,b) => b.y-a.y || a.x-b.x);
  const ordered = [...topSpanning, ...leftCol, ...rightCol];
  ordered.forEach((l,i) => { l.index = i; l.column = l.x < pageWidth * .48 ? 1 : 2; });
  for (let i=0;i<ordered.length;i++) {
    if (!i || ordered[i-1].column !== ordered[i].column) ordered[i].gapAbove = 0;
    else ordered[i].gapAbove = +(ordered[i-1].y - ordered[i].y).toFixed(1);
  }
  return ordered;
}

function groupItemsIntoLines(items, viewportHeight, viewportWidth) {
  const usable = items.filter(i => normalize(i.str));
  usable.sort((a, b) => {
    const dy = b.transform[5] - a.transform[5];
    return Math.abs(dy) > 2.5 ? dy : a.transform[4] - b.transform[4];
  });
  const lines = [];
  for (const item of usable) {
    const y = item.transform[5];
    let line = lines.find(l => Math.abs(l.y - y) <= 2.5);
    if (!line) { line = { y, items: [] }; lines.push(line); }
    line.items.push(item);
  }
  lines.sort((a, b) => b.y - a.y);
  let mapped = lines.map((line, idx) => {
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
    const right = Math.max(...line.items.map(i => i.transform[4] + Math.abs(i.width || 0)));
    const fontNames = line.items.map(i => i.fontName || '').join(' ');
    const cells = mergeTextCells(line.items);
    return {
      index: idx, text, size: +size.toFixed(2),
      bold: /bold|black|semibold|demi|heavy/i.test(fontNames),
      italic: /italic|oblique/i.test(fontNames),
      x: +x.toFixed(1), right: +right.toFixed(1), width: +(right-x).toFixed(1), y: +line.y.toFixed(1),
      topRatio: viewportHeight ? 1 - (line.y / viewportHeight) : .5,
      boilerplate: false, gapAbove: 0, column: 1,
      cells: cells.map(c => ({ text:c.text, x:+c.x.toFixed(1), right:+c.right.toFixed(1) })),
    };
  }).filter(l => l.text);
  for (let i=1;i<mapped.length;i++) mapped[i].gapAbove = +(mapped[i-1].y - mapped[i].y).toFixed(1);
  mapped = splitWideColumnCollisions(mapped, viewportWidth);
  mapped.sort((a,b)=>b.y-a.y || a.x-b.x);
  mapped.forEach((l,i)=>{l.index=i;});
  mapped = orderPageLines(mapped, viewportWidth);
  return mapped;
}

function boilerplateSignature(text) {
  return canonical(text)
    .replace(/\bpage\s+\d+(?:\s+of\s+\d+)?\b/g, 'page #')
    .replace(/\b\d{1,4}\b/g, '#');
}

function markBoilerplate(pageLines) {
  if (pageLines.length < 2) return;
  const seen = new Map();
  pageLines.forEach(lines => {
    const onPage = new Set();
    lines.forEach(line => {
      const edge = line.topRatio < .13 || line.topRatio > .88;
      if (!edge) return;
      const sig = boilerplateSignature(line.text);
      if (sig.length < 2 || sig.length > 150) return;
      onPage.add(sig);
    });
    onPage.forEach(sig => seen.set(sig, (seen.get(sig) || 0) + 1));
  });
  const threshold = Math.max(2, Math.ceil(pageLines.length * .32));
  pageLines.forEach(lines => lines.forEach(line => {
    const sig = boilerplateSignature(line.text);
    const purePageNo = /^\s*(?:page\s+)?\d+(?:\s+of\s+\d+)?\s*$/i.test(line.text);
    if ((line.topRatio < .13 || line.topRatio > .88) && ((seen.get(sig) || 0) >= threshold || purePageNo)) line.boilerplate = true;
  }));
}

function dominantBodySize(pageLines) {
  const weights = new Map();
  for (const lines of pageLines) {
    for (const l of lines) {
      if (l.boilerplate || l.size < 6 || l.size > 40 || l.text.length < 3) continue;
      const k = Math.round(l.size * 2) / 2;
      const bodyLike = l.text.length > 35 ? 1.4 : 1;
      weights.set(k, (weights.get(k) || 0) + Math.min(l.text.length, 180) * bodyLike);
    }
  }
  if (!weights.size) return 10;
  return [...weights.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function parseHeadingIdentifier(text) {
  const t = normalize(text);
  let m = t.match(/^(?:section|sec\.?|§)\s+([A-Z0-9]+(?:[.\-][A-Z0-9]+){0,6})\b/i);
  if (m) return { type: 'section', key: canonical(m[1]), depth: m[1].split(/[.\-]/).length };
  m = t.match(/^((?:\d+)(?:[.\-]\d+){0,6})(?:[.)])?(?:\s+|$)/);
  if (m) return { type: 'section', key: canonical(m[1]), depth: m[1].split(/[.\-]/).length };
  m = t.match(/^(chapter|appendix|article)\s+([A-Z0-9IVXLC]+)\b/i);
  if (m) return { type: m[1].toLowerCase(), key: canonical(m[2]), depth: 1 };
  return null;
}

function headingCandidateKey(h) { return `${h.page}:${h.lineIndex ?? -1}:${canonical(h.title)}`; }

function detectTocPages(pageLines) {
  const toc = new Set();
  pageLines.forEach((lines, pIdx) => {
    const visible = lines.filter(l => !l.boilerplate);
    const titleHit = visible.slice(0, 12).some(l => /^(?:table of )?contents\b|^contents\s*$/i.test(l.text));
    const entryLike = visible.filter(l => /\.{3,}\s*\d+\s*$/.test(l.text) || /\b\d+(?:[.\-]\d+){0,5}\s+.{3,80}\s+\d+\s*$/.test(l.text));
    const trailingPage = visible.filter(l => /\s\d{1,4}\s*$/.test(l.text) && l.text.length < 130);
    if (titleHit || entryLike.length >= 5 || (visible.length >= 12 && trailingPage.length / visible.length > .55)) toc.add(pIdx + 1);
  });
  return toc;
}

function inferHeadingCandidates(pageLines, bodySize, tocPages = new Set()) {
  const leftXs = [];
  pageLines.forEach(lines => lines.forEach(l => { if (!l.boilerplate && l.text.length > 30) leftXs.push(l.x); }));
  leftXs.sort((a,b) => a-b);
  const leftMargin = leftXs.length ? leftXs[Math.floor(leftXs.length * .15)] : 54;

  const styleFrequency = new Map();
  pageLines.forEach(lines => lines.forEach(l => {
    if (l.boilerplate || l.text.length < 2 || l.text.length > 190) return;
    const sizeBand = Math.round(l.size * 2) / 2;
    const key = `${sizeBand}|${l.bold?1:0}|${l.italic?1:0}`;
    styleFrequency.set(key, (styleFrequency.get(key) || 0) + 1);
  }));

  const raw = [];
  pageLines.forEach((lines, pIdx) => {
    for (const l of lines) {
      const text = normalize(l.text);
      if (l.boilerplate || text.length < 2 || text.length > 190 || l.topRatio < .02 || l.topRatio > .96) continue;
      if (/^[\d\W]+$/.test(text)) continue;
      const id = parseHeadingIdentifier(text);
      const caps = text.length >= 4 && text.length < 95 && text === text.toUpperCase() && /[A-Z]/.test(text);
      const ratio = l.size / Math.max(1, bodySize);
      const titleish = !/[.!?]$/.test(text) && text.split(/\s+/).length <= 18;
      const tocPenalty = tocPages.has(pIdx + 1) && !/^(?:table of )?contents\b/i.test(text);
      let score = .08;
      const reasons = [];
      if (ratio >= 1.60) { score += .38; reasons.push('large type'); }
      else if (ratio >= 1.35) { score += .30; reasons.push('larger type'); }
      else if (ratio >= 1.18) { score += .21; reasons.push('raised type'); }
      else if (ratio >= 1.07) { score += .10; }
      if (l.bold) { score += .15; reasons.push('bold'); }
      if (id) { score += .24; reasons.push('numbered'); }
      if (caps) { score += .08; reasons.push('all caps'); }
      if (l.gapAbove >= bodySize * 1.8) { score += .10; reasons.push('spacing'); }
      else if (l.gapAbove >= bodySize * 1.35) score += .05;
      if (l.x <= leftMargin + 30) score += .05;
      if (text.length <= 90) score += .04;
      if (titleish) score += .03;
      if (/[.!?]$/.test(text) && !id) score -= .12;
      if (text.split(/\s+/).length > 18 && !id) score -= .15;
      if (tocPenalty) score -= .34;
      if (l.cells?.length >= 3 && !id) score -= .18;
      const styleKey = `${Math.round(l.size*2)/2}|${l.bold?1:0}|${l.italic?1:0}`;
      const freq = styleFrequency.get(styleKey) || 0;
      if (freq >= 3 && freq <= Math.max(80, pageLines.length * 3)) score += .04;
      const confidence = clamp(score, 0, .99);
      if (confidence >= .58) raw.push({
        title:text, page:pIdx+1, lineIndex:l.index, y:l.y, size:l.size, bold:l.bold,
        confidence:+confidence.toFixed(2), identifier:id, source:'inferred', styleKey,
        reasons, tocPage:tocPages.has(pIdx+1),
      });
    }
  });

  // Learn level ordering from recurring heading styles rather than assuming one global font size ladder.
  const candidateStyles = new Map();
  raw.forEach(c => {
    if (!candidateStyles.has(c.styleKey)) candidateStyles.set(c.styleKey, { size:c.size, bold:c.bold, count:0, numberedDepths:[] });
    const st = candidateStyles.get(c.styleKey); st.count++;
    if (c.identifier?.depth) st.numberedDepths.push(c.identifier.depth);
  });
  const styleLevels = new Map();
  for (const [k, st] of candidateStyles) {
    if (st.numberedDepths.length) {
      const depths = st.numberedDepths.sort((a,b)=>a-b);
      styleLevels.set(k, clamp(depths[Math.floor(depths.length/2)],1,5));
    }
  }
  const unresolved = [...candidateStyles.entries()].filter(([k]) => !styleLevels.has(k)).sort((a,b) => b[1].size-a[1].size || Number(b[1].bold)-Number(a[1].bold));
  let inferredLevel = 1;
  for (const [k, st] of unresolved) {
    const nearKnown = [...candidateStyles.entries()].filter(([kk]) => styleLevels.has(kk)).sort((a,b) => Math.abs(a[1].size-st.size)-Math.abs(b[1].size-st.size))[0];
    if (nearKnown && Math.abs(nearKnown[1].size-st.size) <= 1.2) styleLevels.set(k, styleLevels.get(nearKnown[0]));
    else { styleLevels.set(k, clamp(inferredLevel,1,5)); inferredLevel++; }
  }

  raw.forEach(c => {
    if (c.identifier?.depth) c.level = clamp(c.identifier.depth,1,5);
    else if (/^(chapter|appendix|article)\b/i.test(c.title)) c.level = 1;
    else c.level = clamp(styleLevels.get(c.styleKey) || 1,1,5);
    c.key = headingCandidateKey(c);
  });

  const clean = [];
  for (const c of raw.sort((a,b) => a.page-b.page || a.lineIndex-b.lineIndex)) {
    const prev = clean[clean.length-1];
    if (prev && canonical(prev.title) === canonical(c.title) && prev.page === c.page && Math.abs(prev.lineIndex-c.lineIndex)<=1) {
      if (c.confidence > prev.confidence) clean[clean.length-1] = c;
      continue;
    }
    clean.push(c);
  }
  return clean.slice(0,5000);
}

function findHeadingLineIndex(lines, title) {
  const target = canonical(title);
  let exact = lines.find(l => canonical(l.text) === target);
  if (exact) return exact.index;
  exact = lines.find(l => canonical(l.text).includes(target) || target.includes(canonical(l.text)));
  return exact?.index ?? 0;
}

async function outlineCandidates(pdf, pageLines) {
  const outline = await pdf.getOutline();
  if (!outline?.length) return [];
  const out = [];
  let order = 0;
  async function walk(items, level) {
    for (const item of items) {
      let page = 1;
      try {
        let dest = item.dest;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        if (Array.isArray(dest) && dest[0]) page = (await pdf.getPageIndex(dest[0])) + 1;
      } catch (_) {}
      const title = normalize(item.title);
      if (title) {
        const lineIndex = findHeadingLineIndex(pageLines[page - 1] || [], title);
        const c = {
          title, page, lineIndex, y: (pageLines[page - 1] || [])[lineIndex]?.y ?? 0,
          level: clamp(level, 1, 5), confidence: 1, source: 'bookmark', order: order++,
          identifier: parseHeadingIdentifier(title),
        };
        c.key = headingCandidateKey(c);
        out.push(c);
      }
      if (item.items?.length) await walk(item.items, level + 1);
    }
  }
  await walk(outline, 1);
  return out;
}

function mergeHeadingCandidates(bookmarks, inferred) {
  const out = [...bookmarks];
  for (const c of inferred) {
    const duplicate = bookmarks.find(b => b.page === c.page && canonical(b.title) === canonical(c.title));
    if (!duplicate) out.push(c);
  }
  return out.sort((a,b) => a.page-b.page || a.lineIndex-b.lineIndex || (a.order ?? 0)-(b.order ?? 0));
}

function regionFromCaption(lines, idx, type, metric, bodySize) {
  const line = lines[idx];
  const pageW = metric?.width || Math.max(612, line.right + 40);
  const pageH = metric?.height || 792;
  const prev = lines.slice(0, idx).reverse().find(l => !l.boilerplate && !/^(?:figure|fig\.?|table)\s+/i.test(l.text));
  const next = lines.slice(idx + 1).find(l => !l.boilerplate && !/^(?:figure|fig\.?|table)\s+/i.test(l.text));
  const gapAbove = prev ? prev.y - line.y : pageH * .28;
  const gapBelow = next ? line.y - next.y : pageH * .28;
  let direction;
  if (type === 'figure') direction = gapAbove >= Math.max(bodySize * 3, gapBelow * .8) ? 'above' : 'below';
  else direction = gapBelow >= Math.max(bodySize * 2.2, gapAbove * .7) ? 'below' : 'above';

  const x1 = clamp(Math.min(line.x, pageW * .07) - 4, 0, pageW - 20);
  const x2 = clamp(Math.max(line.right, pageW * .93) + 4, x1 + 20, pageW);
  let y1, y2;
  if (direction === 'above') {
    y1 = clamp(line.y + bodySize * .75, 0, pageH);
    y2 = clamp(prev ? prev.y - bodySize * .85 : Math.min(pageH - 18, line.y + pageH * .34), y1 + 24, pageH);
  } else {
    y2 = clamp(line.y - bodySize * .55, 24, pageH);
    y1 = clamp(next ? next.y + bodySize * .85 : Math.max(18, line.y - pageH * .30), 0, y2 - 24);
  }
  if (y2 - y1 < 38) {
    if (direction === 'above') y2 = clamp(y1 + pageH * .22, y1 + 38, pageH);
    else y1 = clamp(y2 - pageH * .22, 0, y2 - 38);
  }
  return { x1:+x1.toFixed(1), y1:+y1.toFixed(1), x2:+x2.toFixed(1), y2:+y2.toFixed(1), direction, confidence:+clamp(.60 + Math.min(.30, Math.max(gapAbove,gapBelow)/Math.max(1,pageH)*1.4),.55,.92).toFixed(2) };
}

function alignedCells(a, b) {
  if (!a?.cells || !b?.cells || a.cells.length < 3 || b.cells.length < 3) return false;
  const ax = a.cells.slice(0,5).map(c=>c.x);
  const bx = b.cells.slice(0,5).map(c=>c.x);
  let matches = 0;
  for (const x of ax) if (bx.some(y => Math.abs(x-y) <= 18)) matches++;
  return matches >= Math.min(3, ax.length, bx.length);
}

function detectUncaptionedTables(pageLines, pageMetrics, bodySize, existing) {
  const objects = [];
  pageLines.forEach((lines,pIdx) => {
    let start = null;
    let prev = null;
    const flush = endIdx => {
      if (start == null || endIdx - start < 2) { start = null; prev = null; return; }
      const block = lines.slice(start, endIdx + 1);
      const page = pIdx + 1;
      const overlapsCaption = existing.some(o => o.type==='table' && o.page===page && Math.abs(o.lineIndex-start) < 8);
      if (!overlapsCaption) {
        const metric = pageMetrics[pIdx] || {width:612,height:792};
        const x1 = clamp(Math.min(...block.map(l=>l.x))-8,0,metric.width);
        const x2 = clamp(Math.max(...block.map(l=>l.right))+8,x1+20,metric.width);
        const y1 = clamp(Math.min(...block.map(l=>l.y))-bodySize*1.1,0,metric.height);
        const y2 = clamp(Math.max(...block.map(l=>l.y))+bodySize*1.4,y1+20,metric.height);
        objects.push({
          id:`table:auto:${page}:${start}`, type:'table', number:`p${page}`, key:`table:auto:${page}:${start}`,
          title:`Detected table on page ${page}`, caption:'Uncaptioned table region', page, lineIndex:start,
          confidence:.72, sectionId:null, autoDetected:true,
          region:{x1:+x1.toFixed(1),y1:+y1.toFixed(1),x2:+x2.toFixed(1),y2:+y2.toFixed(1),direction:'inline',confidence:.72},
        });
      }
      start = null; prev = null;
    };
    lines.forEach((line,idx) => {
      const rowish = !line.boilerplate && line.cells?.length >= 3 && line.text.length < 180 && !/[.!?]$/.test(line.text);
      if (rowish && (!prev || alignedCells(prev,line))) {
        if (start == null) start = idx;
        prev = line;
      } else if (start != null) flush(idx-1);
      else prev = null;
    });
    if (start != null) flush(lines.length-1);
  });
  return objects;
}

function detectObjects(pageLines, pageMetrics = [], bodySize = 10) {
  const objects = [];
  const figureRx = /^(?:figure|fig\.?)\s+([A-Z]?\d+(?:[.\-]\d+)*(?:[A-Z])?)\s*(?:[:.\-–—]\s*|\s+)(.*)$/i;
  const tableRx = /^table\s+([A-Z]?\d+(?:[.\-]\d+)*(?:[A-Z])?)\s*(?:[:.\-–—]\s*|\s+)(.*)$/i;
  pageLines.forEach((lines,pIdx) => lines.forEach((line,idx) => {
    if (line.boilerplate) return;
    let m = line.text.match(figureRx), type='figure';
    if (!m) { m=line.text.match(tableRx); type='table'; }
    if (!m) return;
    const number=canonical(m[1]);
    objects.push({
      id:`${type}:${number}:${pIdx+1}:${line.index}`, type, number, key:`${type}:${number}`,
      title:normalize(line.text), caption:normalize(m[2]), page:pIdx+1, lineIndex:line.index,
      confidence:.96, sectionId:null, autoDetected:false,
      region:regionFromCaption(lines,idx,type,pageMetrics[pIdx],bodySize),
    });
  }));
  objects.push(...detectUncaptionedTables(pageLines,pageMetrics,bodySize,objects));
  return objects;
}

function compareLocation(aPage, aLine, bPage, bLine) {
  if (aPage !== bPage) return aPage - bPage;
  return (aLine ?? 0) - (bLine ?? 0);
}

function linesInRange(pageLines, startPage, startLine, endPage, endLine) {
  const out = [];
  for (let p = startPage; p <= endPage; p++) {
    const lines = pageLines[p - 1] || [];
    const from = p === startPage ? startLine : 0;
    const to = p === endPage ? endLine : lines.length;
    for (let i = from; i < to; i++) {
      const line = lines[i];
      if (line && !line.boilerplate) out.push({ ...line, page: p });
    }
  }
  return out;
}

function makeParagraphs(lines, bodySize) {
  const paras=[];
  let cur=null;
  const flush=()=>{
    if(!cur || !normalize(cur.text)){cur=null;return;}
    cur.text=normalize(cur.text);
    delete cur.lastX; delete cur.lastRight; delete cur.lastY; delete cur.lastColumn;
    paras.push(cur); cur=null;
  };
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    const prev=lines[i-1];
    const text=normalize(line.text);
    const isBullet=/^(?:[•▪◦‣]|[-–—]\s|\(?[A-Za-z0-9]{1,3}[.)]\s)/.test(text);
    const isCaption=/^(?:figure|fig\.?|table)\s+[A-Z0-9]/i.test(text);
    const endsSentence=/[.!?:;)]$/.test(cur?.text||'');
    const pageBreak=cur && line.page!==cur.pageEnd;
    const columnBreak=cur && line.column!==cur.lastColumn;
    const indentDelta=cur ? line.x-cur.lastX : 0;
    const strongIndent=Math.abs(indentDelta)>Math.max(26,bodySize*2.4);
    const largeGap=line.gapAbove>bodySize*1.65;
    const continuationIndent=cur && Math.abs(line.x-cur.lastX)<=Math.max(10,bodySize*.8);
    const shortPrev=cur && cur.text.length<90;
    const shouldBreak=!cur || isBullet || isCaption || columnBreak || largeGap || (strongIndent && endsSentence) || (pageBreak && endsSentence && !continuationIndent) || (shortPrev && endsSentence && line.x<=cur.lastX+4 && line.gapAbove>bodySize*.85);
    if(shouldBreak) flush();
    if(!cur){
      cur={id:`p:${line.page}:${line.index}`,text,pageStart:line.page,pageEnd:line.page,firstLine:line.index,lastLine:line.index,x:line.x,refs:[],listItem:isBullet,caption:isCaption,lastX:line.x,lastRight:line.right,lastY:line.y,lastColumn:line.column};
    }else{
      if(cur.text.endsWith('-') && /^[a-z]/.test(text)) cur.text=cur.text.slice(0,-1)+text;
      else cur.text+=` ${text}`;
      cur.pageEnd=line.page; cur.lastLine=line.index; cur.lastX=line.x; cur.lastRight=line.right; cur.lastY=line.y; cur.lastColumn=line.column;
    }
    if(isBullet || isCaption) flush();
  }
  flush();
  return paras;
}

function buildStructure(doc) {
  const overrides = doc.headingOverrides || {};
  const active = (doc.headingCandidates || []).map(c => {
    const o = overrides[c.key] || {};
    return { ...c, level: clamp(Number(o.level || c.level || 1), 1, 5), included: o.included !== false };
  }).filter(c => c.included);
  const seen = new Set();
  const structure = [];
  for (const c of active.sort((a,b) => a.page-b.page || a.lineIndex-b.lineIndex)) {
    const k = `${c.page}:${c.lineIndex}:${canonical(c.title)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    structure.push({ ...c, id: `s:${structure.length}:${c.page}:${c.lineIndex}` });
  }
  doc.structure = structure;

  const sections = [];
  const first = structure[0];
  if (first && compareLocation(1, 0, first.page, first.lineIndex) < 0) {
    const frontLines = linesInRange(doc.pageLines, 1, 0, first.page, first.lineIndex);
    const paras = makeParagraphs(frontLines, doc.bodySize || 10);
    if (paras.some(p => p.text.length > 20)) {
      sections.push({ id: 'front-matter', title: 'Front matter', level: 1, page: 1, endPage: first.page, confidence: 1, source: 'generated', identifier: null, paragraphs: paras, childIds: [], objectIds: [] });
    }
  }

  structure.forEach((h, idx) => {
    const next = structure[idx + 1];
    const startPage = h.page;
    const startLine = (h.lineIndex ?? 0) + 1;
    const endPage = next ? next.page : doc.pages;
    const endLine = next ? (next.lineIndex ?? 0) : (doc.pageLines[endPage - 1]?.length || 0);
    const contentLines = linesInRange(doc.pageLines, startPage, startLine, endPage, endLine);
    const paragraphs = makeParagraphs(contentLines, doc.bodySize || 10);
    sections.push({
      id: h.id, title: h.title, level: h.level, page: h.page,
      endPage: paragraphs.length ? Math.max(h.page, ...paragraphs.map(p => p.pageEnd)) : h.page,
      confidence: h.confidence, source: h.source, identifier: h.identifier,
      startLine, endLine: next ? endLine : (doc.pageLines[endPage - 1]?.length || 0),
      paragraphs, childIds: [], objectIds: [], headingKey: h.key,
    });
  });

  const byId = new Map(sections.map(s => [s.id, s]));
  const stack = [];
  for (const s of sections.filter(s => s.id !== 'front-matter')) {
    while (stack.length && stack[stack.length - 1].level >= s.level) stack.pop();
    if (stack.length) byId.get(stack[stack.length - 1].id)?.childIds.push(s.id);
    stack.push(s);
  }
  doc.sectionsModel = sections;

  const pageSection = new Array(doc.pages).fill(sections[0]?.id || null);
  let si = 0;
  for (let p = 1; p <= doc.pages; p++) {
    while (si + 1 < sections.length && sections[si + 1].page <= p) si++;
    pageSection[p - 1] = sections[si]?.id || null;
  }
  doc.pageSection = pageSection;
  doc.sections = pageSection.map(id => byId.get(id)?.title || '');
}

function assignObjects(doc) {
  const sections = doc.sectionsModel || [];
  for (const obj of (doc.objects || [])) {
    let best = null;
    for (const s of sections) {
      const startsBefore = compareLocation(s.page, s.startLine ?? 0, obj.page, obj.lineIndex) <= 0;
      const endsAfter = compareLocation(obj.page, obj.lineIndex, s.endPage, s.endLine ?? Number.MAX_SAFE_INTEGER) < 0;
      if (startsBefore && endsAfter) best = s;
    }
    obj.sectionId = best?.id || doc.pageSection?.[obj.page - 1] || null;
    if (obj.sectionId) {
      const section = sections.find(s => s.id === obj.sectionId);
      if (section && !section.objectIds.includes(obj.id)) section.objectIds.push(obj.id);
    }
  }
}

function buildTargetMap(doc) {
  const map = new Map();
  for (const s of (doc.sectionsModel || [])) {
    if (s.identifier) {
      map.set(`${s.identifier.type}:${s.identifier.key}`, { sectionId: s.id, page: s.page, title: s.title });
      if (s.identifier.type === 'section') map.set(`section:${s.identifier.key}`, { sectionId: s.id, page: s.page, title: s.title });
    }
  }
  for (const obj of (doc.objects || [])) map.set(obj.key, { sectionId: obj.sectionId, page: obj.page, title: obj.title, objectId: obj.id });
  return map;
}

function resolveReferences(doc) {
  const targets=buildTargetMap(doc);
  const single=/\b(section|sec\.?|chapter|appendix|article|figure|fig\.?|table)\s+([A-Z0-9]+(?:[.\-][A-Z0-9]+){0,6})\b/gi;
  const symbol=/§\s*([A-Z0-9]+(?:[.\-][A-Z0-9]+){0,6})\b/gi;
  const plural=/\b(sections?|secs?\.?|figures?|figs?\.?|tables?)\s+([A-Z0-9][A-Z0-9.\-]*(?:\s*(?:,|and|&)\s*[A-Z0-9][A-Z0-9.\-]*)+)/gi;
  const normalizeType=t=>{
    t=t.toLowerCase().replace(/\./g,'');
    if(t.startsWith('sec')) return 'section';
    if(t.startsWith('fig')) return 'figure';
    if(t.startsWith('table')) return 'table';
    return t.replace(/s$/,'');
  };
  for(const section of (doc.sectionsModel||[])){
    for(const para of section.paragraphs){
      const refs=[];
      const add=(start,end,label,type,key)=>{
        const target=targets.get(`${type}:${canonical(key)}`);
        if(!target) return;
        if(!target.objectId && target.sectionId===section.id && target.page===para.pageStart) return;
        if(target.objectId && canonical(target.title)===canonical(para.text)) return;
        refs.push({start,end,label,...target});
      };
      for(const m of para.text.matchAll(single)) add(m.index,m.index+m[0].length,m[0],normalizeType(m[1]),m[2]);
      for(const m of para.text.matchAll(symbol)) add(m.index,m.index+m[0].length,m[0],'section',m[1]);
      for(const m of para.text.matchAll(plural)){
        const type=normalizeType(m[1]);
        const keys=m[2].split(/\s*(?:,|and|&)\s*/i).filter(Boolean);
        const target=keys.map(k=>targets.get(`${type}:${canonical(k)}`)).find(Boolean);
        if(target) refs.push({start:m.index,end:m.index+m[0].length,label:m[0],...target});
      }
      para.refs=refs.sort((a,b)=>a.start-b.start).filter((r,i,arr)=>!i || r.start>=arr[i-1].end);
    }
  }
}

function rebuildDocumentModel(doc) {
  buildStructure(doc);
  doc.objects = detectObjects(doc.pageLines || [], doc.pageMetrics || [], doc.bodySize || 10);
  assignObjects(doc);
  resolveReferences(doc);
  const confidences = (doc.structure || []).filter(h => h.source !== 'bookmark').map(h => h.confidence || 0);
  doc.modelStats = {
    sections: doc.sectionsModel?.length || 0,
    headings: doc.structure?.length || 0,
    figures: doc.objects?.filter(o => o.type === 'figure').length || 0,
    tables: doc.objects?.filter(o => o.type === 'table').length || 0,
    inferredConfidence: confidences.length ? confidences.reduce((a,b) => a+b,0) / confidences.length : 1,
  };
  doc.parserVersion = PARSER_VERSION;
  return doc;
}

async function parsePdf(file, bytes, id, existingCreated = null) {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)) });
  try {
    const pdf = await loadingTask.promise;
    const pageLines = [];
    const pageTexts = [];
    const pageMetrics = [];
    let visibleChars = 0;

    for (let p = 1; p <= pdf.numPages; p++) {
      status(`Structuring ${file.name} · page ${p}/${pdf.numPages}`);
      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      pageMetrics.push({ width: viewport.width, height: viewport.height, rotation: viewport.rotation || 0 });
      const content = await page.getTextContent();
      const lines = groupItemsIntoLines(content.items, viewport.height, viewport.width);
      pageLines.push(lines);
      visibleChars += lines.reduce((n,l) => n + l.text.length, 0);
    }

    if (visibleChars < Math.max(30, pdf.numPages * 4)) {
      throw new Error('This looks image-only or scanned. PDFed currently supports born-digital PDFs only.');
    }

    markBoilerplate(pageLines);
    const bodySize = dominantBodySize(pageLines);
    pageLines.forEach(lines => pageTexts.push(normalize(lines.filter(l => !l.boilerplate).map(l => l.text).join('\n'))));
    const tocPages = detectTocPages(pageLines);
    const inferred = inferHeadingCandidates(pageLines, bodySize, tocPages);
    const bookmarks = await outlineCandidates(pdf, pageLines);
    const headingCandidates = mergeHeadingCandidates(bookmarks, inferred);
    let metadata = {};
    try { metadata = (await pdf.getMetadata())?.info || {}; } catch (_) {}

    const doc = {
      id, name: file.name, size: file.size || bytes.byteLength,
      created: existingCreated || Date.now(), updated: Date.now(), pages: pageTexts.length,
      bytes, pageTexts, pageLines, pageMetrics, bodySize, metadata, headingCandidates, tocPages: [...tocPages],
      headingOverrides: {}, parserVersion: PARSER_VERSION,
      favorite: false, collection: '', lastOpened: Date.now(), editState: null,
    };
    ensureEditState(doc);
    return rebuildDocumentModel(doc);
  } finally {
    try { await loadingTask.destroy(); } catch (_) {}
  }
}

async function ensureDocModel(doc) {
  if (doc?.parserVersion === PARSER_VERSION && doc.sectionsModel && doc.headingCandidates) return doc;
  status(`Upgrading ${doc.name} to the new document model…`);
  const reparsed = await parsePdf({ name: doc.name, size: doc.size }, doc.bytes, doc.id, doc.created);
  reparsed.headingOverrides = doc.headingOverrides || {};
  reparsed.favorite = !!doc.favorite;
  reparsed.collection = doc.collection || '';
  reparsed.lastOpened = doc.lastOpened || doc.created || Date.now();
  reparsed.editState = doc.editState || null;
  ensureEditState(reparsed);
  rebuildDocumentModel(reparsed);
  await dbPut(reparsed);
  return reparsed;
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
        await openDoc(id);
        continue;
      }
      const doc = await parsePdf(file, bytes, id);
      await dbPut(doc);
      await loadDocs();
      await openDoc(id);
      status(`Ready · ${doc.modelStats.sections} sections · ${doc.modelStats.figures} figures · ${doc.modelStats.tables} tables`);
    } catch (err) {
      console.error(err);
      status(`Could not import ${file.name}`);
      alert(`${file.name}\n\n${err.message || err}`);
    }
  }
}

async function loadDocs() {
  const all = await dbGetAll();
  state.docs = all.sort((a,b)=>(b.lastOpened||b.created||0)-(a.lastOpened||a.created||0)).map(d => ({
    id:d.id,name:d.name,pages:d.pages,size:d.size||0,
    structureCount:d.structure?.length||d.headingCandidates?.length||0,
    sectionCount:d.sectionsModel?.length||0,
    figureCount:d.objects?.filter(o=>o.type==='figure').length||0,
    tableCount:d.objects?.filter(o=>o.type==='table').length||0,
    parserVersion:d.parserVersion||1,created:d.created,updated:d.updated,lastOpened:d.lastOpened||d.created,
    favorite:!!d.favorite,collection:d.collection||'',
    annotationCount:d.editState?.annotations?.length||0,
    workingPages:d.editState?.pageOrder?.length||d.pages,
    dirty:!!d.editState?.dirty,
  }));
  const known=new Set(state.docs.map(d=>d.id));
  state.binderOrder=state.binderOrder.filter(id=>known.has(id));
  for(const d of state.docs) if(!state.binderOrder.includes(d.id)) state.binderOrder.push(d.id);
  renderDocs(); renderBinder();
}

function renderDocs() {
  const el=$('#docs');
  if(!state.docs.length){
    el.innerHTML='<div class="noDocs">No PDFs yet.<br>Open or drop a born-digital PDF to start.</div>'; return;
  }
  const collections=[...new Set(state.docs.map(d=>d.collection).filter(Boolean))].sort();
  let docs=state.docs.filter(d=>{
    if(state.libraryFilter==='favorites' && !d.favorite) return false;
    if(state.libraryFilter==='edited' && !d.dirty) return false;
    if(state.libraryFilter.startsWith('collection:') && d.collection!==state.libraryFilter.slice(11)) return false;
    if(state.libraryQuery && !canonical(`${d.name} ${d.collection}`).includes(canonical(state.libraryQuery))) return false;
    return true;
  });
  el.innerHTML=`<div class="libraryMiniTools">
      <input id="libraryQuery" type="search" placeholder="Filter library" value="${esc(state.libraryQuery)}">
      <div class="libraryFilterRow"><button class="miniFilter ${state.libraryFilter==='all'?'active':''}" data-lib-filter="all">All</button><button class="miniFilter ${state.libraryFilter==='favorites'?'active':''}" data-lib-filter="favorites">★</button><button class="miniFilter ${state.libraryFilter==='edited'?'active':''}" data-lib-filter="edited">Edited</button>${collections.slice(0,4).map(c=>`<button class="miniFilter ${state.libraryFilter===`collection:${c}`?'active':''}" data-lib-filter="collection:${esc(c)}">${esc(c)}</button>`).join('')}</div>
    </div>` + (docs.length ? docs.map(d=>`
    <div class="docCard ${state.current?.id===d.id?'active':''}" data-id="${d.id}">
      <button class="docStar ${d.favorite?'active':''}" data-star="${d.id}" title="${d.favorite?'Remove favorite':'Favorite'}">★</button>
      <b title="${esc(d.name)}">${esc(d.name)}</b>
      <span>${d.workingPages} pages · ${d.sectionCount||d.structureCount} sections${d.annotationCount?` · ${d.annotationCount} markups`:''}${d.dirty?' · edited':''}</span>
      ${d.collection?`<em>${esc(d.collection)}</em>`:''}
      <button class="docDelete" data-delete="${d.id}" title="Remove from this device">×</button>
    </div>`).join(''):'<div class="noDocs">Nothing matches this library filter.</div>');
  $('#libraryQuery')?.addEventListener('input',e=>{state.libraryQuery=e.target.value;renderDocs();});
  $$('[data-lib-filter]').forEach(b=>b.addEventListener('click',()=>{state.libraryFilter=b.dataset.libFilter;renderDocs();}));
  $$('[data-star]').forEach(btn=>btn.addEventListener('click',async e=>{e.stopPropagation();const d=await dbGet(btn.dataset.star);if(!d)return;d.favorite=!d.favorite;d.updated=Date.now();await dbPut(d);if(state.current?.id===d.id)state.current.favorite=d.favorite;await loadDocs();if(!state.current)renderLibraryHome();}));
  $$('.docCard').forEach(card=>card.addEventListener('click',e=>{if(e.target.closest('[data-delete],[data-star]'))return;openDoc(card.dataset.id);}));
  $$('[data-delete]').forEach(btn=>btn.addEventListener('click',async e=>{
    e.stopPropagation(); const id=btn.dataset.delete,d=state.docs.find(x=>x.id===id);
    if(!confirm(`Remove “${d?.name||'this PDF'}” from this browser?\n\nThe original file on your computer is not touched.`)) return;
    await dbDelete(id);
    if(state.current?.id===id){state.current=null;if(state.currentPdfTask){try{await state.currentPdfTask.destroy();}catch(_){}}state.currentPdf=null;state.currentPdfTask=null;renderLibraryHome();}
    await loadDocs();
  }));
}

function renderLibraryHome() {
  if(state.currentPdfTask){try{state.currentPdfTask.destroy();}catch(_){}}
  state.current=null; state.currentPdf=null; state.currentPdfTask=null;
  const pane=$('#docPane'); if(!pane)return;
  pane.classList.remove('empty');
  const recent=state.docs.slice(0,6), favorites=state.docs.filter(d=>d.favorite).slice(0,6);
  const collections=[...new Set(state.docs.map(d=>d.collection).filter(Boolean))];
  pane.innerHTML=`<div class="libraryHome">
    <div class="homeHero"><span class="eyebrow">Professional PDF workspace</span><h1>Your PDF library, remembered.</h1><p>PDFed keeps imported documents and their structure, markups, page plans, and organization on this device. Open once; keep working later.</p><button class="primary" data-home-open>Open PDFs</button></div>
    <div class="statGrid"><div><strong>${state.docs.length}</strong><span>Documents</span></div><div><strong>${state.docs.reduce((n,d)=>n+d.workingPages,0)}</strong><span>Working pages</span></div><div><strong>${state.docs.reduce((n,d)=>n+d.annotationCount,0)}</strong><span>Markups</span></div><div><strong>${collections.length}</strong><span>Collections</span></div></div>
    ${recent.length?`<section class="homeSection"><div class="homeSectionHead"><div><span class="eyebrow">Continue</span><h2>Recent documents</h2></div></div><div class="homeCards">${recent.map(homeDocCard).join('')}</div></section>`:''}
    ${favorites.length?`<section class="homeSection"><div class="homeSectionHead"><div><span class="eyebrow">Pinned</span><h2>Favorites</h2></div></div><div class="homeCards">${favorites.map(homeDocCard).join('')}</div></section>`:''}
  </div>`;
  $('[data-home-open]')?.addEventListener('click',()=>$('#fileInput').click());
  $$('[data-home-doc]').forEach(b=>b.addEventListener('click',()=>openDoc(b.dataset.homeDoc)));
  status('Library ready'); renderDocs();
}
function homeDocCard(d){return `<button class="homeDoc" data-home-doc="${d.id}"><div class="homeDocIcon">PDF</div><div><b>${esc(d.name)}</b><span>${d.workingPages} pages · ${d.sectionCount||d.structureCount} sections</span><small>${d.collection?`${esc(d.collection)} · `:''}${dateLabel(d.lastOpened)}</small></div></button>`;}
function renderEmpty(){ renderLibraryHome(); }

async function openDoc(id) {
  status('Opening…');
  let doc = await dbGet(id);
  if (!doc) return;
  doc = await ensureDocModel(doc);
  if (state.currentPdfTask) { try { await state.currentPdfTask.destroy(); } catch (_) {} }
  state.current = doc;
  ensureEditState(doc);
  doc.lastOpened=Date.now(); await dbPut(doc);
  state.currentPdfTask = pdfjsLib.getDocument({ data: new Uint8Array(doc.bytes.slice(0)) });
  state.currentPdf = await state.currentPdfTask.promise;
  state.page = 1;
  state.planIndex = null;
  state.mode = 'read';
  state.sideTab = 'outline';
  state.currentSectionId = doc.sectionsModel?.[0]?.id || null;
  $('#searchScope').value = 'current';
  $('#searchBox').placeholder = 'Search this PDF…';
  $('#searchBox').value = '';
  renderDocs();
  renderWorkspace();
  if (state.currentSectionId) await showSection(state.currentSectionId);
  else await showPage(1);
  status(`${doc.modelStats.sections} sections · ${doc.modelStats.figures} figures · ${doc.modelStats.tables} tables`);
}

function confidenceLabel(h) {
  if (h.source === 'bookmark') return '<span class="confidence bookmark">PDF</span>';
  const pct = Math.round((h.confidence || 0) * 100);
  const band = pct >= 85 ? 'high' : pct >= 70 ? 'medium' : 'low';
  return `<span class="confidence ${band}" title="Structure confidence">${pct}%</span>`;
}

function renderWorkspace() {
  const doc=state.current;if(!doc)return renderLibraryHome(); ensureEditState(doc);
  $('#docPane').classList.remove('empty');
  $('#docPane').innerHTML=`<div class="workspace">
    <aside class="outline">
      <div class="outlineTop"><div class="docTopline"><div><h2>${esc(doc.name)}</h2><small>${doc.pages} source pages · ${planFor(doc).length} working pages · ${doc.modelStats.sections} sections</small></div><button class="favoriteBig ${doc.favorite?'active':''}" id="favoriteDoc" title="Favorite">★</button></div>
        <div class="docMetaActions"><button id="setCollection">${doc.collection?`Collection: ${esc(doc.collection)}`:'＋ Collection'}</button><button id="exportCopy">Export revised PDF</button></div>
      </div>
      <div class="segmented modeSwitch"><button id="readMode" class="active">Reading</button><button id="sourceMode">Source + Markup</button></div>
      <div class="sideTabs" role="tablist"><button class="sideTab active" data-side="outline">Outline</button><button class="sideTab" data-side="pages">Pages</button><button class="sideTab" data-side="figures">Figures</button><button class="sideTab" data-side="tables">Tables</button><button class="sideTab" data-side="markups">Markups</button><button class="sideTab" data-side="review">Review</button></div>
      <div id="outlineBody" class="outlineBody"></div>
    </aside>
    <section class="reader" id="reader"><div id="pageBody"></div></section>
  </div>`;
  $('#readMode').addEventListener('click',()=>setMode('read')); $('#sourceMode').addEventListener('click',()=>setMode('source'));
  $('#favoriteDoc').addEventListener('click',async()=>{doc.favorite=!doc.favorite;doc.updated=Date.now();await dbPut(doc);await loadDocs();$('#favoriteDoc').classList.toggle('active',doc.favorite);});
  $('#setCollection').addEventListener('click',async()=>{const v=prompt('Collection name (leave blank to remove):',doc.collection||'');if(v===null)return;doc.collection=normalize(v);doc.updated=Date.now();await dbPut(doc);await loadDocs();renderWorkspace(); if(state.mode==='source')await showPage(state.page,state.planIndex); else if(state.currentSectionId)await showSection(state.currentSectionId);});
  $('#exportCopy').addEventListener('click',()=>openExportDialog());
  $$('.sideTab').forEach(btn=>btn.addEventListener('click',()=>{state.sideTab=btn.dataset.side;$$('.sideTab').forEach(b=>b.classList.toggle('active',b===btn));renderSidePanel();}));
  renderSidePanel();
}

function renderSidePanel() {
  const doc = state.current;
  const el = $('#outlineBody');
  if (!doc || !el) return;
  if (state.sideTab === 'pages') {
    const plan=planFor(doc);
    el.innerHTML=`<div class="pagePanelHead"><div><b>Page organizer</b><span>${plan.length} working pages · original preserved</span></div><button id="resetPages" ${!doc.editState?.dirty?'disabled':''}>Reset</button></div><div class="pagePlan">${plan.map((entry,idx)=>`<div class="pagePlanRow ${state.planIndex===idx?'active':''}" data-plan-row="${idx}" draggable="true"><button class="thumbOpen" data-plan-open="${idx}" title="Open page"><canvas class="pageThumb" data-thumb-index="${idx}"></canvas><span>${idx+1}</span></button><div class="pagePlanMeta"><b>Source page ${entry.sourcePage}</b><small>${entry.rotation?`${entry.rotation}° rotation · `:''}${annotationsFor(doc).filter(a=>a.pageUid===entry.uid).length} markups</small></div><div class="pageOps"><button data-page-up="${idx}" title="Move up">↑</button><button data-page-down="${idx}" title="Move down">↓</button><button data-page-rotate="${idx}" title="Rotate 90°">↻</button><button data-page-duplicate="${idx}" title="Duplicate">⧉</button><button data-page-extract="${idx}" title="Export this page">⇩</button><button data-page-delete="${idx}" title="Delete from working copy">×</button></div></div>`).join('')}</div>`;
    wirePagePanel(); hydratePageThumbnails(); return;
  }
  if (state.sideTab === 'markups') {
    const plan=planFor(doc),anns=annotationsFor(doc);
    const pageIndexByUid=new Map(plan.map((e,i)=>[e.uid,i]));
    const sorted=[...anns].sort((a,b)=>(pageIndexByUid.get(a.pageUid)??99999)-(pageIndexByUid.get(b.pageUid)??99999)||(a.created||0)-(b.created||0));
    el.innerHTML=`<div class="markupListHead"><div><b>Markups</b><span>${sorted.length} working annotation${sorted.length===1?'':'s'}</span></div></div>${sorted.length?`<div class="markupList">${sorted.map(a=>{const idx=pageIndexByUid.get(a.pageUid),label=a.type==='redact'?'Secure redaction':a.type[0].toUpperCase()+a.type.slice(1),detail=a.text?esc(a.text.slice(0,90)):`${Math.round(a.w||0)} × ${Math.round(a.h||0)}`;return `<button class="markupListRow ${a.type==='redact'?'redactionRow':''}" data-markup-open="${esc(a.id)}" data-markup-page="${idx??0}"><span class="markupTypeDot" style="background:${esc(a.color||defaultAnnotationColor(a.type))}"></span><div><b>${esc(label)}</b><span>${detail}</span><small>Working page ${(idx??0)+1} · source ${a.sourcePage}</small></div></button>`;}).join('')}</div>`:'<div class="noDocs">No markups yet. Open Source + Markup to add review notes, shapes, or redactions.</div>'}`;
    $$('[data-markup-open]').forEach(btn=>btn.addEventListener('click',async()=>{const idx=+btn.dataset.markupPage,e=plan[idx];if(!e)return;state.annotationTool='select';state.selectedAnnotationId=btn.dataset.markupOpen;state.planIndex=idx;await setMode('source');await showPage(e.sourcePage,idx);renderSidePanel();}));
    return;
  }

  if (state.sideTab === 'outline') {
    el.innerHTML = (doc.sectionsModel || []).map(s => `
      <button class="headingBtn ${state.currentSectionId === s.id ? 'active' : ''}" data-section="${esc(s.id)}" style="padding-left:${8 + (clamp(s.level,1,5)-1)*14}px">
        <span class="headingText">${esc(s.title)}</span>${s.id === 'front-matter' ? '' : confidenceLabel(s)}
      </button>`).join('') || '<div class="noDocs">No structure confidently detected. Search and Source view still work.</div>';
    $$('[data-section]').forEach(btn => btn.addEventListener('click', async () => {
      const id = btn.dataset.section;
      state.currentSectionId = id;
      if (state.mode === 'source') {
        const s = doc.sectionsModel.find(x => x.id === id);
        await showPage(s?.page || 1);
      } else await showSection(id);
      renderSidePanel();
    }));
    return;
  }

  if (state.sideTab === 'figures' || state.sideTab === 'tables') {
    const type = state.sideTab === 'figures' ? 'figure' : 'table';
    const objects = (doc.objects || []).filter(o => o.type === type);
    el.innerHTML = objects.length ? objects.map(o => {
      const section = doc.sectionsModel.find(s => s.id === o.sectionId);
      return `<button class="objectCard" data-object-id="${esc(o.id)}" data-object-page="${o.page}" data-object-section="${esc(o.sectionId || '')}">
        <span class="objectType">${type} ${esc(o.number)}</span>
        <b>${esc(o.caption || o.title)}</b>
        <small>${esc(section?.title || 'Unassigned')} · page ${o.page}</small>
      </button>`;
    }).join('') : `<div class="noDocs">No ${type}s were confidently identified in this document.</div>`;
    $$('[data-object-id]').forEach(btn => btn.addEventListener('click', async () => {
      state.currentSectionId = btn.dataset.objectSection || state.currentSectionId;
      const obj = (doc.objects || []).find(o => o.id === btn.dataset.objectId);
      if (obj) await showObject(obj.id);
      else { await setMode('source'); await showPage(+btn.dataset.objectPage); }
    }));
    return;
  }

  const candidates = doc.headingCandidates || [];
  el.innerHTML = `
    <div class="reviewIntro">PDFed keeps uncertain structure editable. Disable a false heading or change its level; the document model rebuilds immediately.</div>
    ${candidates.map(c => {
      const o = doc.headingOverrides?.[c.key] || {};
      const included = o.included !== false;
      const level = clamp(Number(o.level || c.level || 1), 1, 5);
      return `<div class="reviewRow ${included ? '' : 'disabled'}" data-review="${esc(c.key)}">
        <label class="reviewToggle"><input type="checkbox" data-include="${esc(c.key)}" ${included ? 'checked' : ''}><span>${esc(c.title)}</span></label>
        <div class="reviewMeta"><span>p. ${c.page}</span>${confidenceLabel(c)}<select data-level="${esc(c.key)}" aria-label="Heading level"><option ${level===1?'selected':''}>1</option><option ${level===2?'selected':''}>2</option><option ${level===3?'selected':''}>3</option><option ${level===4?'selected':''}>4</option><option ${level===5?'selected':''}>5</option></select></div>
      </div>`;
    }).join('') || '<div class="noDocs">No heading candidates were detected.</div>'}`;
  $$('[data-include]').forEach(input => input.addEventListener('change', () => applyHeadingOverride(input.dataset.include, { included: input.checked })));
  $$('[data-level]').forEach(select => select.addEventListener('change', () => applyHeadingOverride(select.dataset.level, { level: +select.value })));
}


function wirePagePanel(){
  const doc=state.current;if(!doc)return;
  $$('[data-plan-open]').forEach(b=>b.addEventListener('click',async()=>{state.planIndex=+b.dataset.planOpen;const e=planFor(doc)[state.planIndex];await setMode('source');await showPage(e.sourcePage,state.planIndex);renderSidePanel();}));
  const op=async(idx,kind)=>{
    const plan=planFor(doc); if(!plan[idx])return;
    if(kind==='up'&&idx>0)[plan[idx-1],plan[idx]]=[plan[idx],plan[idx-1]];
    if(kind==='down'&&idx<plan.length-1)[plan[idx+1],plan[idx]]=[plan[idx],plan[idx+1]];
    if(kind==='rotate')plan[idx].rotation=(plan[idx].rotation+90)%360;
    if(kind==='duplicate'){const original=plan[idx],c={...original,uid:uid('p')};plan.splice(idx+1,0,c);const copies=annotationsFor(doc).filter(a=>a.pageUid===original.uid).map(a=>({...a,id:uid('ann'),pageUid:c.uid,created:Date.now()}));doc.editState.annotations.push(...copies);}
    if(kind==='delete'){if(plan.length===1)return alert('A working PDF needs at least one page.');const removed=plan.splice(idx,1)[0];doc.editState.annotations=annotationsFor(doc).filter(a=>a.pageUid!==removed.uid);if(state.planIndex===idx)state.planIndex=null;}
    await saveCurrentEdits('Page plan saved locally'); renderSidePanel();
  };
  $$('[data-page-up]').forEach(b=>b.addEventListener('click',()=>op(+b.dataset.pageUp,'up'))); $$('[data-page-down]').forEach(b=>b.addEventListener('click',()=>op(+b.dataset.pageDown,'down')));
  $$('[data-page-rotate]').forEach(b=>b.addEventListener('click',()=>op(+b.dataset.pageRotate,'rotate'))); $$('[data-page-duplicate]').forEach(b=>b.addEventListener('click',()=>op(+b.dataset.pageDuplicate,'duplicate')));
  $$('[data-page-delete]').forEach(b=>b.addEventListener('click',()=>op(+b.dataset.pageDelete,'delete'))); $$('[data-page-extract]').forEach(b=>b.addEventListener('click',()=>exportWorkingCopy([planFor(doc)[+b.dataset.pageExtract]],`page_${+b.dataset.pageExtract+1}`)));
  $('#resetPages')?.addEventListener('click',async()=>{if(!confirm('Reset page order, rotations, deletions, duplicates, and markups for this document?'))return;doc.editState={pageOrder:Array.from({length:doc.pages},(_,i)=>({uid:uid('p'),sourcePage:i+1,rotation:0})),annotations:[],dirty:false};await dbPut(doc);await loadDocs();renderSidePanel();status('Working copy reset');});
  let dragIndex=null;
  $$('[data-plan-row]').forEach(row=>{row.addEventListener('dragstart',()=>{dragIndex=+row.dataset.planRow;row.classList.add('dragging');});row.addEventListener('dragend',()=>row.classList.remove('dragging'));row.addEventListener('dragover',e=>e.preventDefault());row.addEventListener('drop',async e=>{e.preventDefault();const to=+row.dataset.planRow;if(dragIndex===null||to===dragIndex)return;const plan=planFor(doc);const [m]=plan.splice(dragIndex,1);plan.splice(to,0,m);await saveCurrentEdits('Page order saved locally');renderSidePanel();});});
}
async function renderThumbnail(canvas,entry){
  if(!canvas||!entry||!state.currentPdf)return;const page=await state.currentPdf.getPage(entry.sourcePage);const base=page.getViewport({scale:1,rotation:(page.rotate||0)+(entry.rotation||0)});const scale=120/base.width;const vp=page.getViewport({scale,rotation:(base.rotation||0)});canvas.width=Math.max(1,Math.floor(vp.width));canvas.height=Math.max(1,Math.floor(vp.height));const t=page.render({canvasContext:canvas.getContext('2d',{alpha:false}),viewport:vp});try{await t.promise;}catch(_){}}
function hydratePageThumbnails(){
  if(state.thumbObserver){try{state.thumbObserver.disconnect();}catch(_){}}
  state.thumbObserver=new IntersectionObserver(entries=>{for(const e of entries){if(!e.isIntersecting)continue;const c=e.target,idx=+c.dataset.thumbIndex;state.thumbObserver.unobserve(c);renderThumbnail(c,planFor()[idx]);}},{root:$('#outline'),rootMargin:'180px'});
  $$('[data-thumb-index]').forEach(c=>state.thumbObserver.observe(c));
}
async function applyHeadingOverride(key, patch) {
  const doc = state.current;
  if (!doc) return;
  doc.headingOverrides ||= {};
  doc.headingOverrides[key] = { ...(doc.headingOverrides[key] || {}), ...patch };
  rebuildDocumentModel(doc);
  doc.updated = Date.now();
  await dbPut(doc);
  state.currentSectionId = doc.sectionsModel.find(s => s.headingKey === key)?.id || doc.sectionsModel?.[0]?.id || null;
  await loadDocs();
  renderWorkspace();
  if (state.mode === 'source') await showPage(state.page);
  else if (state.currentSectionId) await showSection(state.currentSectionId);
  status('Structure updated');
}

async function setMode(mode) {
  state.mode = mode;
  $('#readMode')?.classList.toggle('active', mode === 'read');
  $('#sourceMode')?.classList.toggle('active', mode === 'source');
  if (mode === 'source') {
    const section = state.current?.sectionsModel?.find(s => s.id === state.currentSectionId);
    await showPage(section?.page || state.page || 1);
  } else if (state.currentSectionId) await showSection(state.currentSectionId);
}

function linkifyParagraph(para) {
  if (!para.refs?.length) return esc(para.text);
  let cursor = 0, html = '';
  for (const ref of [...para.refs].sort((a,b) => a.start-b.start)) {
    if (ref.start < cursor) continue;
    html += esc(para.text.slice(cursor, ref.start));
    html += `<button class="xref" data-ref-section="${esc(ref.sectionId || '')}" data-ref-page="${ref.page}">${esc(para.text.slice(ref.start, ref.end))}</button>`;
    cursor = ref.end;
  }
  html += esc(para.text.slice(cursor));
  return html;
}

async function renderObjectRegion(canvas, obj) {
  if (!canvas || !obj?.region || !state.currentPdf) return;
  const pdfPage = await state.currentPdf.getPage(obj.page);
  const r = obj.region;
  const regionWidth = Math.max(40, r.x2-r.x1);
  const targetWidth = Math.min(760, Math.max(320, canvas.parentElement?.clientWidth || 620));
  const scale = clamp(targetWidth/regionWidth, .8, 2.2);
  const viewport = pdfPage.getViewport({scale});
  const off = document.createElement('canvas');
  off.width = Math.ceil(viewport.width); off.height = Math.ceil(viewport.height);
  const ctx = off.getContext('2d',{alpha:false});
  const task = pdfPage.render({canvasContext:ctx,viewport});
  await task.promise;
  const vr = viewport.convertToViewportRectangle([r.x1,r.y1,r.x2,r.y2]);
  const x=Math.max(0,Math.floor(Math.min(vr[0],vr[2]))), y=Math.max(0,Math.floor(Math.min(vr[1],vr[3])));
  const w=Math.max(1,Math.min(off.width-x,Math.ceil(Math.abs(vr[2]-vr[0]))));
  const h=Math.max(1,Math.min(off.height-y,Math.ceil(Math.abs(vr[3]-vr[1]))));
  canvas.width=w; canvas.height=h;
  canvas.style.aspectRatio=`${w} / ${h}`;
  canvas.getContext('2d',{alpha:false}).drawImage(off,x,y,w,h,0,0,w,h);
}

async function showObject(objectId) {
  const doc=state.current;
  const obj=(doc?.objects||[]).find(o=>o.id===objectId);
  if(!doc || !obj) return;
  const section=doc.sectionsModel.find(s=>s.id===obj.sectionId);
  state.currentSectionId=obj.sectionId || state.currentSectionId;
  state.mode='read';
  $('#readMode')?.classList.add('active'); $('#sourceMode')?.classList.remove('active');
  const body=$('#pageBody');
  if(!body) return;
  if($('#reader')) $('#reader').scrollTop=0;
  body.innerHTML=`<article class="paper objectHero">
    <div class="sectionTopline"><span>${esc(obj.type)} · page ${obj.page} · ${Math.round((obj.region?.confidence||obj.confidence||0)*100)}% region confidence</span><button class="sourceJump" data-object-source-page="${obj.page}">View full source ↗</button></div>
    <span class="eyebrow">${esc(obj.autoDetected?'Detected region':`${obj.type} ${obj.number}`)}</span>
    <h1 class="sectionTitle objectTitle">${esc(obj.caption||obj.title)}</h1>
    <div class="objectPreview"><canvas id="objectHeroCanvas" class="objectCanvas" aria-label="Source crop for ${esc(obj.title)}"></canvas></div>
    <div class="objectMeta"><b>In section</b><button data-back-section="${esc(obj.sectionId||'')}">${esc(section?.title||'Unassigned')}</button><span>PDFed renders this directly from the source page; the crop is inferred, not a rewritten image.</span></div>
  </article>`;
  $('[data-object-source-page]')?.addEventListener('click',async()=>{await setMode('source');await showPage(obj.page);});
  $('[data-back-section]')?.addEventListener('click',async e=>{if(e.currentTarget.dataset.backSection) await showSection(e.currentTarget.dataset.backSection);});
  try { await renderObjectRegion($('#objectHeroCanvas'),obj); } catch(e) { console.warn('Object preview failed',e); }
  renderSidePanel();
}

async function hydrateSectionObjectPreviews(objects=[]) {
  for(const obj of objects.slice(0,8)){
    const canvas=document.querySelector(`[data-object-preview="${CSS.escape(obj.id)}"] canvas`);
    if(!canvas) continue;
    try { await renderObjectRegion(canvas,obj); } catch(e) { console.warn('Preview failed',obj.id,e); }
  }
}

function sectionIndex(id) { return (state.current?.sectionsModel || []).findIndex(s => s.id === id); }

async function showSection(id) {
  const doc = state.current;
  if (!doc) return;
  const section = doc.sectionsModel.find(s => s.id === id) || doc.sectionsModel[0];
  if (!section) return showPage(state.page || 1);
  state.currentSectionId = section.id;
  state.page = section.page;
  const body = $('#pageBody');
  if (!body) return;
  if ($('#reader')) $('#reader').scrollTop = 0;

  const children = (section.childIds || []).map(cid => doc.sectionsModel.find(s => s.id === cid)).filter(Boolean);
  const objects = (section.objectIds || []).map(oid => doc.objects.find(o => o.id === oid)).filter(Boolean);
  const idx = sectionIndex(section.id);
  const pageRange = section.endPage > section.page ? `Pages ${section.page}–${section.endPage}` : `Page ${section.page}`;
  const confidence = section.source === 'bookmark' || section.id === 'front-matter' ? '' : ` · ${Math.round((section.confidence || 0) * 100)}% structure confidence`;
  body.innerHTML = `<article class="paper sectionPaper">
    <div class="sectionTopline"><span>${esc(pageRange)}${confidence}</span><button class="sourceJump" data-source-page="${section.page}">View source ↗</button></div>
    <h1 class="sectionTitle">${esc(section.title)}</h1>
    ${children.length ? `<div class="childLinks">${children.map(c => `<button data-child="${esc(c.id)}">${esc(c.title)}</button>`).join('')}</div>` : ''}
    <div class="sectionText">${section.paragraphs.length ? section.paragraphs.map(p => {
      const obj = objects.find(o => o.page === p.pageStart && canonical(o.title) === canonical(p.text));
      return `<p class="sectionParagraph ${obj ? 'objectCaption' : ''} ${p.listItem ? 'listItem' : ''}" data-source="${p.pageStart}">${linkifyParagraph(p)}${obj ? `<button class="captionSource" data-object-source="${obj.page}">source</button>` : ''}</p>`;
    }).join('') : '<p class="sectionParagraph mutedText">No body text was isolated between this heading and the next detected section.</p>'}</div>
    ${objects.length ? `<div class="sectionObjects"><span class="eyebrow">Detected here</span>${objects.map(o => `<button class="sectionObjectCard" data-object-open="${esc(o.id)}"><span>${esc(o.autoDetected?'Detected table':`${o.type} ${o.number}`)}</span><b>${esc(o.caption || o.title)}</b><div class="objectThumb" data-object-preview="${esc(o.id)}"><canvas class="objectCanvas"></canvas></div></button>`).join('')}</div>` : ''}
    <div class="sectionNav">
      <button data-section-step="-1" ${idx <= 0 ? 'disabled' : ''}>← Previous section</button>
      <span>${idx + 1} / ${doc.sectionsModel.length}</span>
      <button data-section-step="1" ${idx >= doc.sectionsModel.length - 1 ? 'disabled' : ''}>Next section →</button>
    </div>
  </article>`;

  $('[data-source-page]')?.addEventListener('click', async e => { await setMode('source'); await showPage(+e.currentTarget.dataset.sourcePage); });
  $$('[data-child]').forEach(btn => btn.addEventListener('click', () => showSection(btn.dataset.child)));
  $$('[data-object-open]').forEach(btn => btn.addEventListener('click', async () => { await showObject(btn.dataset.objectOpen); }));
  hydrateSectionObjectPreviews(objects);
  $$('[data-section-step]').forEach(btn => btn.addEventListener('click', () => {
    const next = doc.sectionsModel[idx + +btn.dataset.sectionStep];
    if (next) showSection(next.id);
  }));
  $$('.xref').forEach(btn => btn.addEventListener('click', async () => {
    const targetSection = btn.dataset.refSection;
    if (targetSection) {
      state.currentSectionId = targetSection;
      if (state.mode === 'read') await showSection(targetSection);
      else await showPage(+btn.dataset.refPage);
      renderSidePanel();
    } else {
      await setMode('source');
      await showPage(+btn.dataset.refPage);
    }
  }));
  renderSidePanel();
}

async function showPage(p, planIndex=null) {
  if(!state.current||!state.currentPdf)return;
  const sourcePage=clamp(Number.isFinite(+p)?+p:1,1,state.current.pages);
  state.page=sourcePage;
  const plan=planFor();
  let resolvedIndex=Number.isInteger(planIndex)&&plan[planIndex]?.sourcePage===sourcePage?planIndex:(Number.isInteger(state.planIndex)&&plan[state.planIndex]?.sourcePage===sourcePage?state.planIndex:plan.findIndex(e=>e.sourcePage===sourcePage));
  state.planIndex=resolvedIndex>=0?resolvedIndex:null;
  const entry=resolvedIndex>=0?plan[resolvedIndex]:{uid:`source_${sourcePage}`,sourcePage,rotation:0};
  const body=$('#pageBody');if(!body)return;if($('#reader'))$('#reader').scrollTop=0;
  const annotations=annotationsFor().filter(a=>a.pageUid===entry.uid);
  body.innerHTML=`<div class="sourceWorkspace">
    <div class="markupBar" aria-label="Markup tools"><div class="toolGroup"><span class="rotationBadge">${entry.rotation?`Export rotation ${entry.rotation}°`:'Original orientation'}</span><button class="markupTool ${state.annotationTool==='select'?'active':''}" data-tool="select">Pointer</button><button class="markupTool ${state.annotationTool==='highlight'?'active':''}" data-tool="highlight">Highlight</button><button class="markupTool ${state.annotationTool==='underline'?'active':''}" data-tool="underline">Underline</button><button class="markupTool ${state.annotationTool==='strikeout'?'active':''}" data-tool="strikeout">Strike</button><button class="markupTool ${state.annotationTool==='text'?'active':''}" data-tool="text">Text</button><button class="markupTool ${state.annotationTool==='note'?'active':''}" data-tool="note">Note</button><button class="markupTool ${state.annotationTool==='rect'?'active':''}" data-tool="rect">□</button><button class="markupTool ${state.annotationTool==='ellipse'?'active':''}" data-tool="ellipse">○</button><button class="markupTool ${state.annotationTool==='arrow'?'active':''}" data-tool="arrow">→</button><button class="markupTool ${state.annotationTool==='freehand'?'active':''}" data-tool="freehand">Draw</button><button class="markupTool dangerTool ${state.annotationTool==='redact'?'active':''}" data-tool="redact">Redact</button></div><div class="toolGroup toolRight"><button id="undoAnnotation" ${annotations.length?'':'disabled'}>Undo</button><button id="clearAnnotations" ${annotations.length?'':'disabled'}>Clear page</button><button class="primary compact" id="exportSource">Export revised PDF</button></div></div>
    <div id="annotationInspector" class="annotationInspector"></div>
    <div class="sourceWrap"><div class="pageStage" id="pageStage"><canvas id="sourceCanvas" class="sourceCanvas"></canvas><svg id="annotationLayer" class="annotationLayer ${state.annotationTool==='select'?'selectMode':''}" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label="Markup layer"></svg></div>
    <div class="pager sourcePager"><button id="prevPage" aria-label="Previous page">←</button><input id="pageInput" class="pageInput" inputmode="numeric" value="${Number.isInteger(state.planIndex)?state.planIndex+1:sourcePage}" aria-label="Working page number"><span>/ ${plan.length}</span><button id="nextPage" aria-label="Next page">→</button></div></div>
  </div>`;
  const pdfPage=await state.currentPdf.getPage(sourcePage);const base=pdfPage.getViewport({scale:1,rotation:(pdfPage.rotate||0)});const targetWidth=Math.min(1100,Math.max(650,($('#reader')?.clientWidth||900)-70));const scale=targetWidth/base.width;const viewport=pdfPage.getViewport({scale,rotation:base.rotation});
  const canvas=$('#sourceCanvas'),ctx=canvas.getContext('2d',{alpha:false}),ratio=Math.min(window.devicePixelRatio||1,2);canvas.width=Math.floor(viewport.width*ratio);canvas.height=Math.floor(viewport.height*ratio);canvas.style.width=`${Math.floor(viewport.width)}px`;canvas.style.height=`${Math.floor(viewport.height)}px`;ctx.setTransform(ratio,0,0,ratio,0,0);
  if(state.renderTask){try{state.renderTask.cancel();}catch(_){}}state.renderTask=pdfPage.render({canvasContext:ctx,viewport});try{await state.renderTask.promise;}catch(e){if(e?.name!=='RenderingCancelledException')throw e;}
  const stage=$('#pageStage');stage.style.width=canvas.style.width;stage.style.height=canvas.style.height;renderAnnotationLayer(entry);
  $$('.markupTool').forEach(b=>b.addEventListener('click',()=>{state.annotationTool=b.dataset.tool;state.selectedAnnotationId=null;showPage(sourcePage,state.planIndex);}));
  $('#undoAnnotation')?.addEventListener('click',async()=>{const anns=annotationsFor(),idx=[...anns].map((a,i)=>[a,i]).filter(([a])=>a.pageUid===entry.uid).pop()?.[1];if(idx!==undefined){anns.splice(idx,1);await saveCurrentEdits('Markup removed');await showPage(sourcePage,state.planIndex);}});
  $('#clearAnnotations')?.addEventListener('click',async()=>{if(!confirm('Clear all markups from this working page?'))return;state.current.editState.annotations=annotationsFor().filter(a=>a.pageUid!==entry.uid);await saveCurrentEdits('Page markups cleared');await showPage(sourcePage,state.planIndex);});
  $('#exportSource')?.addEventListener('click',()=>openExportDialog()); if(state.annotationTool==='select') wireAnnotationSelection(entry); else wireAnnotationLayer(entry); renderAnnotationInspector(entry);
  $('#prevPage').addEventListener('click',()=>{const i=Math.max(0,(state.planIndex??0)-1),e=plan[i];showPage(e.sourcePage,i);});$('#nextPage').addEventListener('click',()=>{const i=Math.min(plan.length-1,(state.planIndex??0)+1),e=plan[i];showPage(e.sourcePage,i);});
  $('#pageInput').addEventListener('change',()=>{const i=clamp(Number($('#pageInput').value)-1,0,plan.length-1),e=plan[i];showPage(e.sourcePage,i);});$('#pageInput').addEventListener('keydown',e=>{if(e.key==='Enter')e.currentTarget.blur();});
}
function annotationSvg(a){
  normalizeAnnotation(a);
  const x=a.x,y=a.y,w=a.w||0,h=a.h||0,color=a.color||defaultAnnotationColor(a.type),opacity=a.opacity??1,sw=a.lineWidth||3;
  const selected=state.selectedAnnotationId===a.id?' selected':'';
  const common=`data-ann="${esc(a.id)}" class="annObject${selected}"`;
  const stroke=`stroke:${esc(color)};stroke-width:${sw};opacity:${opacity}`;
  if(a.type==='highlight')return `<rect ${common} x="${x}" y="${y}" width="${w}" height="${h}" rx="2" style="fill:${esc(color)};fill-opacity:${opacity};stroke:none"/>`;
  if(a.type==='underline')return `<line ${common} x1="${x}" y1="${y+h}" x2="${x+w}" y2="${y+h}" style="${stroke}"/>`;
  if(a.type==='strikeout')return `<line ${common} x1="${x}" y1="${y+h/2}" x2="${x+w}" y2="${y+h/2}" style="${stroke}"/>`;
  if(a.type==='rect')return `<rect ${common} x="${x}" y="${y}" width="${w}" height="${h}" rx="2" style="fill:none;${stroke}"/>`;
  if(a.type==='ellipse')return `<ellipse ${common} cx="${x+w/2}" cy="${y+h/2}" rx="${Math.abs(w/2)}" ry="${Math.abs(h/2)}" style="fill:none;${stroke}"/>`;
  if(a.type==='arrow')return `<line ${common} x1="${x}" y1="${y}" x2="${x+w}" y2="${y+h}" style="${stroke}" marker-end="url(#arrowHead)"/>`;
  if(a.type==='freehand')return `<polyline ${common} points="${(a.points||[]).map(p=>`${p[0]},${p[1]}`).join(' ')}" style="fill:none;${stroke};stroke-linecap:round;stroke-linejoin:round"/>`;
  if(a.type==='text')return `<g ${common} style="opacity:${opacity}"><rect x="${x}" y="${y}" width="${Math.max(80,w||180)}" height="${Math.max(34,h||60)}" style="fill:#fff8d8;stroke:${esc(color)};stroke-width:${sw}"/><text x="${x+8}" y="${y+22}">${esc((a.text||'Text').slice(0,120))}</text></g>`;
  if(a.type==='note')return `<g ${common} style="opacity:${opacity}"><circle cx="${x}" cy="${y}" r="15" style="fill:${esc(color)};stroke:#6b5b13;stroke-width:2"/><text x="${x}" y="${y+5}" text-anchor="middle">N</text><title>${esc(a.text||'Note')}</title></g>`;
  if(a.type==='redact')return `<g ${common}><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1" style="fill:#111;fill-opacity:.82;stroke:#111;stroke-width:2"/><text x="${x+Math.max(8,w/2)}" y="${y+Math.max(16,h/2+5)}" text-anchor="middle" style="fill:white;font-size:13px;font-weight:900;letter-spacing:1px">REDACT</text></g>`;
  return '';
}
function renderAnnotationLayer(entry){
  const svg=$('#annotationLayer');if(!svg)return;const anns=annotationsFor().filter(a=>a.pageUid===entry.uid);
  svg.innerHTML=`<defs><marker id="arrowHead" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z"/></marker></defs>${anns.map(annotationSvg).join('')}`;
}
function annotationById(id,doc=state.current){return annotationsFor(doc).find(a=>a.id===id)||null;}
function moveAnnotation(a,dx,dy){
  if(!a)return;
  if(a.type==='freehand') a.points=(a.points||[]).map(([x,y])=>[clamp(x+dx,0,1000),clamp(y+dy,0,1000)]);
  a.x=clamp((a.x||0)+dx,0,1000); a.y=clamp((a.y||0)+dy,0,1000);
}
function wireAnnotationSelection(entry){
  const svg=$('#annotationLayer');if(!svg)return;
  const point=e=>{const r=svg.getBoundingClientRect();return [clamp((e.clientX-r.left)/r.width*1000,0,1000),clamp((e.clientY-r.top)/r.height*1000,0,1000)];};
  let dragging=null,start=null,last=null,moved=false;
  svg.addEventListener('pointerdown',e=>{
    const target=e.target.closest?.('[data-ann]');
    if(!target){state.selectedAnnotationId=null;renderAnnotationLayer(entry);renderAnnotationInspector(entry);return;}
    const id=target.getAttribute('data-ann'),a=annotationById(id);if(!a)return;
    state.selectedAnnotationId=id;renderAnnotationLayer(entry);renderAnnotationInspector(entry);
    dragging=a;start=last=point(e);moved=false;svg.setPointerCapture(e.pointerId);e.preventDefault();
  });
  svg.addEventListener('pointermove',e=>{if(!dragging||!last)return;const p=point(e),dx=p[0]-last[0],dy=p[1]-last[1];if(Math.abs(dx)+Math.abs(dy)>.2)moved=true;moveAnnotation(dragging,dx,dy);last=p;renderAnnotationLayer(entry);});
  svg.addEventListener('pointerup',async e=>{if(!dragging)return;try{svg.releasePointerCapture(e.pointerId);}catch(_){}const shouldSave=moved;dragging=null;start=last=null;if(shouldSave)await saveCurrentEdits('Markup moved');renderAnnotationLayer(entry);renderAnnotationInspector(entry);});
}
function renderAnnotationInspector(entry){
  const host=$('#annotationInspector');if(!host)return;
  const a=annotationById(state.selectedAnnotationId);
  if(!a||a.pageUid!==entry.uid){host.innerHTML='<span class="inspectorHint">Pointer mode: click a markup to select and drag it.</span>';return;}
  normalizeAnnotation(a);
  const textEditor=['text','note'].includes(a.type)?`<label class="inspectorText">Text<input id="annText" value="${esc(a.text||'')}"></label>`:'';
  const geometry=['highlight','underline','strikeout','rect','ellipse','arrow','redact'].includes(a.type)?`<span class="inspectorMeta">${Math.round(a.w||0)} × ${Math.round(a.h||0)}</span>`:'';
  host.innerHTML=`<div class="inspectorSelected"><b>${esc(a.type[0].toUpperCase()+a.type.slice(1))}</b>${geometry}${a.type==='redact'?'<span class="secureBadge">Secure on export</span>':''}</div>
    ${a.type!=='redact'?`<label>Color<input id="annColor" type="color" value="${esc(a.color)}"></label><label>Opacity<input id="annOpacity" type="range" min="0.08" max="1" step="0.02" value="${a.opacity}"></label>${!['highlight','note'].includes(a.type)?`<label>Width<input id="annWidth" type="range" min="1" max="10" step="1" value="${a.lineWidth}"></label>`:''}`:''}
    ${textEditor}<button id="duplicateAnnotation">Duplicate</button><button id="deleteAnnotation" class="dangerText">Delete</button>`;
  const patch=async data=>{Object.assign(a,data);normalizeAnnotation(a);await saveCurrentEdits('Markup updated');renderAnnotationLayer(entry);renderAnnotationInspector(entry);};
  $('#annColor')?.addEventListener('input',e=>{a.color=e.target.value;renderAnnotationLayer(entry);}); $('#annColor')?.addEventListener('change',e=>patch({color:e.target.value}));
  $('#annOpacity')?.addEventListener('input',e=>{a.opacity=+e.target.value;renderAnnotationLayer(entry);}); $('#annOpacity')?.addEventListener('change',e=>patch({opacity:+e.target.value}));
  $('#annWidth')?.addEventListener('input',e=>{a.lineWidth=+e.target.value;renderAnnotationLayer(entry);}); $('#annWidth')?.addEventListener('change',e=>patch({lineWidth:+e.target.value}));
  $('#annText')?.addEventListener('change',e=>patch({text:normalize(e.target.value)}));
  $('#duplicateAnnotation')?.addEventListener('click',async()=>{const copy={...a,id:uid('ann'),created:Date.now(),x:clamp((a.x||0)+18,0,1000),y:clamp((a.y||0)+18,0,1000),points:a.points?.map(([x,y])=>[clamp(x+18,0,1000),clamp(y+18,0,1000)])};annotationsFor().push(copy);state.selectedAnnotationId=copy.id;await saveCurrentEdits('Markup duplicated');renderAnnotationLayer(entry);renderAnnotationInspector(entry);});
  $('#deleteAnnotation')?.addEventListener('click',async()=>{state.current.editState.annotations=annotationsFor().filter(x=>x.id!==a.id);state.selectedAnnotationId=null;await saveCurrentEdits('Markup deleted');renderAnnotationLayer(entry);renderAnnotationInspector(entry);});
}
function wireAnnotationLayer(entry){
  const svg=$('#annotationLayer');if(!svg||state.annotationTool==='select')return;
  const point=e=>{const r=svg.getBoundingClientRect();return [clamp((e.clientX-r.left)/r.width*1000,0,1000),clamp((e.clientY-r.top)/r.height*1000,0,1000)];}; let start=null,pts=[];
  svg.addEventListener('pointerdown',e=>{e.preventDefault();svg.setPointerCapture(e.pointerId);start=point(e);pts=[start];if(['text','note'].includes(state.annotationTool)){const text=prompt(state.annotationTool==='note'?'Note text:':'Text:');if(text!==null&&normalize(text))commitAnnotation({type:state.annotationTool,x:start[0],y:start[1],w:state.annotationTool==='text'?220:0,h:state.annotationTool==='text'?70:0,text:normalize(text)},entry);start=null;}});
  svg.addEventListener('pointermove',e=>{if(!start||state.annotationTool!=='freehand')return;pts.push(point(e));});
  svg.addEventListener('pointerup',e=>{if(!start||['text','note'].includes(state.annotationTool))return;const end=point(e);let x=Math.min(start[0],end[0]),y=Math.min(start[1],end[1]),w=Math.abs(end[0]-start[0]),h=Math.abs(end[1]-start[1]);if(state.annotationTool==='freehand'){pts.push(end);commitAnnotation({type:'freehand',points:pts,x:start[0],y:start[1]},entry);}else if(w>3||h>3)commitAnnotation({type:state.annotationTool,x,y,w,h},entry);start=null;pts=[];});
}
async function commitAnnotation(data,entry){const ann=normalizeAnnotation({id:uid('ann'),pageUid:entry.uid,sourcePage:entry.sourcePage,created:Date.now(),...data});annotationsFor().push(ann);state.selectedAnnotationId=ann.id;state.annotationTool='select';await saveCurrentEdits(ann.type==='redact'?'Redaction saved locally':'Markup saved locally');await showPage(entry.sourcePage,planFor().findIndex(e=>e.uid===entry.uid));}
function openExportDialog(entries=null,suffix='revised') {
  const doc=state.current;if(!doc)return;
  const dialog=$('#exportDialog');if(!dialog)return exportWorkingCopy(entries,suffix);
  const base=doc.name.replace(/\.pdf$/i,'');
  state.exportPending={entries,suffix};
  $('#exportFilename').value=`${slugify(base)}_${suffix}.pdf`;
  const redactions=hasRedactions(doc) && (entries||planFor(doc)).some(e=>annotationsFor(doc).some(a=>a.pageUid===e.uid&&a.type==='redact'));
  const markups=$('#exportMarkups');markups.checked=true;markups.disabled=redactions;
  $('#redactionExportNote').hidden=!redactions;
  dialog.showModal();
}
async function getPdfJsDocument(doc,cache=new Map()) {
  if(cache.has(doc.id)) return cache.get(doc.id).pdf;
  const task=pdfjsLib.getDocument({data:new Uint8Array(doc.bytes.slice(0))});
  const pdf=await task.promise;cache.set(doc.id,{task,pdf});return pdf;
}
function canvasColor(hex,opacity=1){const [r,g,b]=hexRgb(hex).map(v=>Math.round(v*255));return `rgba(${r},${g},${b},${opacity})`;}
function drawCanvasAnnotation(ctx,a,W,H){
  normalizeAnnotation(a);const x=a.x/1000*W,y=a.y/1000*H,w=(a.w||0)/1000*W,h=(a.h||0)/1000*H,color=a.color||defaultAnnotationColor(a.type),lw=Math.max(1,(a.lineWidth||3)*W/1000);
  ctx.save();ctx.globalAlpha=a.opacity??1;ctx.lineWidth=lw;ctx.strokeStyle=color;ctx.fillStyle=color;ctx.lineCap='round';ctx.lineJoin='round';
  if(a.type==='highlight')ctx.fillRect(x,y,w,h);
  else if(a.type==='underline'){ctx.beginPath();ctx.moveTo(x,y+h);ctx.lineTo(x+w,y+h);ctx.stroke();}
  else if(a.type==='strikeout'){ctx.beginPath();ctx.moveTo(x,y+h/2);ctx.lineTo(x+w,y+h/2);ctx.stroke();}
  else if(a.type==='rect')ctx.strokeRect(x,y,w,h);
  else if(a.type==='ellipse'){ctx.beginPath();ctx.ellipse(x+w/2,y+h/2,Math.abs(w/2),Math.abs(h/2),0,0,Math.PI*2);ctx.stroke();}
  else if(a.type==='arrow'){ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+w,y+h);ctx.stroke();const ang=Math.atan2(h,w),len=Math.max(10,W*.012);ctx.beginPath();ctx.moveTo(x+w,y+h);ctx.lineTo(x+w-len*Math.cos(ang-.5),y+h-len*Math.sin(ang-.5));ctx.moveTo(x+w,y+h);ctx.lineTo(x+w-len*Math.cos(ang+.5),y+h-len*Math.sin(ang+.5));ctx.stroke();}
  else if(a.type==='freehand'){const pts=a.points||[];if(pts.length){ctx.beginPath();ctx.moveTo(pts[0][0]/1000*W,pts[0][1]/1000*H);for(const p of pts.slice(1))ctx.lineTo(p[0]/1000*W,p[1]/1000*H);ctx.stroke();}}
  else if(a.type==='text'){ctx.globalAlpha=.94;ctx.fillStyle='#fff8d8';ctx.fillRect(x,y,Math.max(W*.08,w),Math.max(H*.035,h));ctx.strokeStyle=color;ctx.strokeRect(x,y,Math.max(W*.08,w),Math.max(H*.035,h));ctx.globalAlpha=1;ctx.fillStyle='#171a1f';ctx.font=`${Math.max(12,W*.012)}px sans-serif`;ctx.fillText((a.text||'').slice(0,140),x+6,y+Math.max(16,H*.02),Math.max(W*.07,w-12));}
  else if(a.type==='note'){ctx.beginPath();ctx.arc(x,y,Math.max(8,W*.01),0,Math.PI*2);ctx.fill();ctx.globalAlpha=1;ctx.fillStyle='#111';ctx.font=`bold ${Math.max(10,W*.009)}px sans-serif`;ctx.textAlign='center';ctx.fillText('N',x,y+4);}
  else if(a.type==='redact'){ctx.globalAlpha=1;ctx.fillStyle='#000';ctx.fillRect(x,y,w,h);}
  ctx.restore();
}
async function rasterizePageWithMarkups(doc,entry,anns,pdfJsCache){
  const pdf=await getPdfJsDocument(doc,pdfJsCache),page=await pdf.getPage(entry.sourcePage),base=page.getViewport({scale:1,rotation:page.rotate||0}),scale=2;
  const vp=page.getViewport({scale,rotation:page.rotate||0}),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.ceil(vp.width));canvas.height=Math.max(1,Math.ceil(vp.height));const ctx=canvas.getContext('2d',{alpha:false});
  const task=page.render({canvasContext:ctx,viewport:vp});await task.promise;const ordered=[...anns.filter(a=>a.type!=='redact'),...anns.filter(a=>a.type==='redact')];for(const a of ordered)drawCanvasAnnotation(ctx,a,canvas.width,canvas.height);
  const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('Could not rasterize redacted page.')),'image/png'));
  return {png:new Uint8Array(await blob.arrayBuffer()),width:base.width,height:base.height};
}
async function appendWorkingEntry(out,src,doc,entry,font,rgb,{includeMarkups=true,pageNumber=null,pdfJsCache=new Map()}={}){
  const {degrees}=window.PDFLib,anns=includeMarkups?annotationsFor(doc).filter(a=>a.pageUid===entry.uid):[],redactions=anns.filter(a=>a.type==='redact');let page;
  if(redactions.length){
    const raster=await rasterizePageWithMarkups(doc,entry,anns,pdfJsCache),img=await out.embedPng(raster.png);page=out.addPage([raster.width,raster.height]);page.drawImage(img,{x:0,y:0,width:raster.width,height:raster.height});if(entry.rotation)page.setRotation(degrees(entry.rotation%360));
  }else{
    page=(await out.copyPages(src,[entry.sourcePage-1]))[0];out.addPage(page);const baseAngle=page.getRotation()?.angle||0;if(entry.rotation)page.setRotation(degrees((baseAngle+entry.rotation)%360));if(includeMarkups)applyAnnotationsToPdfPage(page,anns,font,rgb);
  }
  if(pageNumber!==null)page.drawText(String(pageNumber),{x:page.getWidth()-38,y:18,size:8,font,color:rgb(.38,.40,.44)});
  return page;
}
async function exportWorkingCopy(entries=null,suffix='revised',options={}){
  if(!window.PDFLib)return alert('PDF export library did not load. Check your internet connection and reload PDFed.'); const doc=state.current;if(!doc)return;
  const plan=(entries||planFor(doc)).filter(Boolean);if(!plan.length)return alert('There are no pages to export.');status('Building revised PDF…');
  const includeMarkups=options.includeMarkups!==false,{PDFDocument,StandardFonts,rgb}=window.PDFLib,src=await PDFDocument.load(doc.bytes.slice(0),{ignoreEncryption:true}),out=await PDFDocument.create(),font=await out.embedFont(StandardFonts.Helvetica),pdfJsCache=new Map();
  out.setTitle(doc.metadata?.Title||doc.name);out.setCreator('PDFed');out.setProducer(`PDFed ${APP_VERSION}`);
  for(let i=0;i<plan.length;i++){status(`Exporting page ${i+1}/${plan.length}…`);await appendWorkingEntry(out,src,doc,plan[i],font,rgb,{includeMarkups,pdfJsCache});}
  for(const v of pdfJsCache.values()){try{await v.task.destroy();}catch(_){}}
  const bytes=await out.save({useObjectStreams:true}),blob=new Blob([bytes],{type:'application/pdf'}),url=URL.createObjectURL(blob),base=doc.name.replace(/\.pdf$/i,''),filename=options.filename||`${slugify(base)}_${suffix}.pdf`;const a=document.createElement('a');a.href=url;a.download=filename.toLowerCase().endsWith('.pdf')?filename:`${filename}.pdf`;a.click();setTimeout(()=>URL.revokeObjectURL(url),15000);status(`Exported ${plan.length} page${plan.length===1?'':'s'}`);
}
function applyAnnotationsToPdfPage(page,anns,font,rgb){
  const W=page.getWidth(),H=page.getHeight(),xy=a=>({x:a.x/1000*W,y:H-(a.y/1000*H),w:(a.w||0)/1000*W,h:(a.h||0)/1000*H});
  for(const a0 of anns){const a=normalizeAnnotation(a0);if(a.type==='redact')continue;const p=xy(a),[rr,gg,bb]=hexRgb(a.color||defaultAnnotationColor(a.type)),color=rgb(rr,gg,bb),op=a.opacity??1,lw=Math.max(.7,(a.lineWidth||3)*.48);try{
    if(a.type==='highlight')page.drawRectangle({x:p.x,y:p.y-p.h,width:p.w,height:p.h,color,opacity:op,borderOpacity:0});
    else if(a.type==='underline')page.drawLine({start:{x:p.x,y:p.y-p.h},end:{x:p.x+p.w,y:p.y-p.h},thickness:lw,color,opacity:op});
    else if(a.type==='strikeout')page.drawLine({start:{x:p.x,y:p.y-p.h/2},end:{x:p.x+p.w,y:p.y-p.h/2},thickness:lw,color,opacity:op});
    else if(a.type==='rect')page.drawRectangle({x:p.x,y:p.y-p.h,width:p.w,height:p.h,borderWidth:lw,borderColor:color,borderOpacity:op,opacity:0});
    else if(a.type==='ellipse')page.drawEllipse({x:p.x+p.w/2,y:p.y-p.h/2,xScale:p.w/2,yScale:p.h/2,borderWidth:lw,borderColor:color,borderOpacity:op,opacity:0});
    else if(a.type==='arrow'){const x2=p.x+p.w,y2=p.y-p.h;page.drawLine({start:{x:p.x,y:p.y},end:{x:x2,y:y2},thickness:lw,color,opacity:op});const ang=Math.atan2(y2-p.y,x2-p.x),len=9;for(const off of [.55,-.55])page.drawLine({start:{x:x2,y:y2},end:{x:x2-len*Math.cos(ang+off),y:y2-len*Math.sin(ang+off)},thickness:lw,color,opacity:op});}
    else if(a.type==='freehand'){const pts=a.points||[];for(let i=1;i<pts.length;i++){const q1={x:pts[i-1][0]/1000*W,y:H-pts[i-1][1]/1000*H},q2={x:pts[i][0]/1000*W,y:H-pts[i][1]/1000*H};page.drawLine({start:q1,end:q2,thickness:lw,color,opacity:op});}}
    else if(a.type==='text'){page.drawRectangle({x:p.x,y:p.y-p.h,width:Math.max(80,p.w),height:Math.max(28,p.h),color:rgb(1,1,.88),borderColor:color,borderWidth:lw,opacity:.92});page.drawText((a.text||'').slice(0,140),{x:p.x+5,y:p.y-15,size:9,font,color:rgb(.12,.12,.14),maxWidth:Math.max(70,p.w-10)});}
    else if(a.type==='note'){page.drawCircle({x:p.x,y:p.y,size:9,color,borderColor:rgb(.35,.3,.08),borderWidth:.7,opacity:op});page.drawText('N',{x:p.x-3,y:p.y-3,size:7,font,color:rgb(.1,.1,.08)});}
  }catch(e){console.warn('Could not export annotation',a,e);}}
}

function makeSnippet(text, tokens, radius = 125) {
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
  for (const token of [...tokens].sort((a,b) => b.length - a.length)) {
    const safe = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(${safe})`, 'gi'), '<mark>$1</mark>');
  }
  return `${start ? '…' : ''}${out}${end < text.length ? '…' : ''}`;
}

function stemToken(token='') {
  let t=token.toLowerCase().replace(/[^a-z0-9§.-]/g,'');
  if(t.length>5 && t.endsWith('ing')) t=t.slice(0,-3);
  else if(t.length>4 && t.endsWith('ed')) t=t.slice(0,-2);
  else if(t.length>4 && t.endsWith('es')) t=t.slice(0,-2);
  else if(t.length>3 && t.endsWith('s')) t=t.slice(0,-1);
  return t;
}
function tokenMatches(text, token) {
  const low=text.toLowerCase();
  const stem=stemToken(token);
  return low.includes(token.toLowerCase()) || (stem.length>=3 && low.includes(stem));
}
function proximityBonus(text,tokens){
  const low=text.toLowerCase();
  const positions=tokens.map(t=>{
    const exact=low.indexOf(t.toLowerCase());
    return exact>=0?exact:low.indexOf(stemToken(t));
  }).filter(i=>i>=0);
  if(positions.length!==tokens.length) return 0;
  const span=Math.max(...positions)-Math.min(...positions);
  if(span<=40) return 12;
  if(span<=100) return 7;
  if(span<=220) return 3;
  return 0;
}
function searchDoc(doc,q){
  const normalized=normalize(q).toLowerCase();
  const quoted=[...q.matchAll(/"([^"]+)"/g)].map(m=>normalize(m[1]).toLowerCase()).filter(Boolean);
  const unquoted=q.replace(/"[^"]+"/g,' ');
  const tokens=normalize(unquoted).toLowerCase().split(/\s+/).filter(Boolean);
  const required=[...tokens,...quoted];
  if(!required.length) return [];
  const results=[];
  const objectTextBySection=new Map();
  for(const o of (doc.objects||[])){
    if(!o.sectionId) continue;
    objectTextBySection.set(o.sectionId,`${objectTextBySection.get(o.sectionId)||''} ${o.title} ${o.caption||''}`);
  }
  for(const section of (doc.sectionsModel||[])){
    const titleLow=section.title.toLowerCase();
    const objectText=(objectTextBySection.get(section.id)||'').toLowerCase();
    const paras=section.paragraphs||[];
    const allText=paras.map(p=>p.text).join(' ').toLowerCase();
    const combined=`${titleLow} ${objectText} ${allText}`;
    const matchesAll=required.every(t=> t.includes(' ') ? combined.includes(t) : tokenMatches(combined,t));
    if(!matchesAll) continue;
    let bestPara=null,bestScore=-1;
    for(const p of paras){
      const low=p.text.toLowerCase();
      let score=0;
      const matched=tokens.filter(t=>tokenMatches(low,t));
      score+=matched.length*4;
      if(tokens.length && matched.length===tokens.length) score+=10;
      if(normalized && low.includes(normalized)) score+=18;
      for(const phrase of quoted) if(low.includes(phrase)) score+=16;
      score+=proximityBonus(low,tokens);
      score+=tokens.reduce((n,t)=>n+Math.min(4,countOccurrences(low,stemToken(t)||t)),0);
      if(score>bestScore){bestScore=score;bestPara=p;}
    }
    let score=Math.max(0,bestScore);
    if(titleLow.includes(normalized)) score+=34;
    score+=tokens.filter(t=>tokenMatches(titleLow,t)).length*9;
    if(tokens.some(t=>tokenMatches(objectText,t))) score+=6;
    const snippetText=bestPara?.text || section.title;
    results.push({docId:doc.id,name:doc.name,sectionId:section.id,section:section.title,page:bestPara?.pageStart||section.page,score,snippet:makeSnippet(snippetText,tokens.length?tokens:quoted)});
  }
  return results.sort((a,b)=>b.score-a.score || a.page-b.page);
}

async function runSearch(q) {
  q = normalize(q);
  if (!q) {
    if (state.current) {
      renderSidePanel();
      if (state.mode === 'read' && state.currentSectionId) await showSection(state.currentSectionId);
      else if (state.mode === 'source') await showPage(state.page);
    }
    status(state.current ? `${state.current.modelStats.sections} sections · ${state.current.modelStats.figures} figures · ${state.current.modelStats.tables} tables` : '');
    return;
  }
  const scope = $('#searchScope').value;
  let results = [];
  if (scope === 'current' && state.current) results = searchDoc(state.current, q);
  else {
    status('Searching library…');
    const all = await dbGetAll();
    for (let doc of all) {
      doc = await ensureDocModel(doc);
      results.push(...searchDoc(doc, q));
    }
    results.sort((a,b) => b.score-a.score);
  }
  results = results.slice(0, 250);
  status(`${results.length}${results.length === 250 ? '+' : ''} section matches`);

  if (!state.current && results[0]) await openDoc(results[0].docId);
  if (!state.current) return;
  const outline = $('#outlineBody');
  if (!outline) return;
  state.sideTab = 'outline';
  $$('.sideTab').forEach(b => b.classList.toggle('active', b.dataset.side === 'outline'));
  let html = '';
  let lastDoc = null;
  for (const r of results) {
    if (scope === 'all' && r.name !== lastDoc) {
      html += `<div class="searchGroup">${esc(r.name)}</div>`;
      lastDoc = r.name;
    }
    html += `<div class="result" data-doc="${r.docId}" data-section-result="${esc(r.sectionId)}" data-page="${r.page}"><b>${esc(r.section)}</b><small>Source page ${r.page}</small><p>${r.snippet}</p></div>`;
  }
  outline.innerHTML = html || '<div class="noDocs">No matching sections.</div>';
  $$('[data-section-result]').forEach(r => r.addEventListener('click', async () => {
    const id = r.dataset.doc;
    const sectionId = r.dataset.sectionResult;
    if (state.current?.id !== id) await openDoc(id);
    state.currentSectionId = sectionId;
    await setMode('read');
    await showSection(sectionId);
  }));
}

function renderBinder() {
  const el=$('#binderDocs');if(!el)return;
  if(!state.docs.length){el.innerHTML='<div class="noDocs">Load some PDFs first.</div>';return;}
  const orderedDocs=state.binderOrder.map(id=>state.docs.find(d=>d.id===id)).filter(Boolean);
  el.innerHTML=orderedDocs.map((d,idx)=>{const meta=state.binderMeta[d.id]||{};return `<div class="binderRow pro" data-binder-id="${d.id}" data-binder-index="${idx}" draggable="true"><span class="dragHandle" title="Drag to reorder">⋮⋮</span><input type="checkbox" id="bind_${d.id}" value="${d.id}" ${meta.selected===false?'':'checked'}><label for="bind_${d.id}"><b>${esc(d.name)}</b><br><small>${d.workingPages||d.pages} pages · ${d.sectionCount||d.structureCount} sections</small></label><input class="binderRename" data-binder-title="${d.id}" value="${esc(meta.title||d.name.replace(/\.pdf$/i,''))}" aria-label="Binder display title"><div class="reorder"><button data-up="${idx}" title="Move up">↑</button><button data-down="${idx}" title="Move down">↓</button></div></div>`}).join('');
  $$('[data-up]').forEach(btn=>btn.addEventListener('click',()=>moveBinder(+btn.dataset.up,-1)));$$('[data-down]').forEach(btn=>btn.addEventListener('click',()=>moveBinder(+btn.dataset.down,1)));
  $$('[data-binder-title]').forEach(inp=>inp.addEventListener('input',()=>{state.binderMeta[inp.dataset.binderTitle]={...(state.binderMeta[inp.dataset.binderTitle]||{}),title:inp.value};renderBinderPreview();}));
  $$('#binderDocs input[type="checkbox"]').forEach(cb=>cb.addEventListener('change',()=>{state.binderMeta[cb.value]={...(state.binderMeta[cb.value]||{}),selected:cb.checked};renderBinderPreview();}));
  let drag=null;$$('[data-binder-index]').forEach(row=>{row.addEventListener('dragstart',()=>{drag=+row.dataset.binderIndex;row.classList.add('dragging');});row.addEventListener('dragend',()=>row.classList.remove('dragging'));row.addEventListener('dragover',e=>e.preventDefault());row.addEventListener('drop',e=>{e.preventDefault();const to=+row.dataset.binderIndex;if(drag===null||drag===to)return;const [id]=state.binderOrder.splice(drag,1);state.binderOrder.splice(to,0,id);renderBinder();});});renderBinderPreview();
}
function renderBinderPreview(){const result=$('#binderResult');if(!result)return;const selected=state.binderOrder.filter(id=>(state.binderMeta[id]?.selected)!==false).map(id=>state.docs.find(d=>d.id===id)).filter(Boolean);if(!selected.length){result.innerHTML='';return;}result.innerHTML=`<div class="binderPreview"><span class="eyebrow">Packet plan</span><b>${selected.length} documents · ${selected.reduce((n,d)=>n+(d.workingPages||d.pages),0)} source pages</b><p>${selected.map(d=>esc(state.binderMeta[d.id]?.title||d.name.replace(/\.pdf$/i,''))).join(' → ')}</p></div>`;}

function moveBinder(idx, delta) {
  const next = idx + delta;
  if (next < 0 || next >= state.binderOrder.length) return;
  [state.binderOrder[idx], state.binderOrder[next]] = [state.binderOrder[next], state.binderOrder[idx]];
  renderBinder();
}

function buildOutlineTree(entries) {
  const roots = [], stack = [];
  for (const entry of entries) {
    const node = { ...entry, children: [], ref: null };
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(node); else roots.push(node);
    stack.push(node);
  }
  return roots;
}

function addPdfOutlines(pdfDoc, entries, PDFLib) {
  if (!entries.length) return;
  const { PDFName, PDFHexString } = PDFLib;
  const ctx = pdfDoc.context;
  const roots = buildOutlineTree(entries);
  const rootRef = ctx.nextRef();
  const all = [];
  const allocate = nodes => nodes.forEach(n => { n.ref = ctx.nextRef(); all.push(n); allocate(n.children); });
  allocate(roots);
  const descendantCount = node => node.children.reduce((n,c) => n + 1 + descendantCount(c), 0);
  const assignNodes = (nodes, parentRef) => {
    nodes.forEach((node, idx) => {
      const dict = ctx.obj({
        Title: PDFHexString.fromText(node.title),
        Parent: parentRef,
        Dest: ctx.obj([pdfDoc.getPage(node.pageIndex).ref, PDFName.of('Fit')]),
      });
      if (idx > 0) dict.set(PDFName.of('Prev'), nodes[idx - 1].ref);
      if (idx < nodes.length - 1) dict.set(PDFName.of('Next'), nodes[idx + 1].ref);
      if (node.children.length) {
        dict.set(PDFName.of('First'), node.children[0].ref);
        dict.set(PDFName.of('Last'), node.children[node.children.length - 1].ref);
        dict.set(PDFName.of('Count'), ctx.obj(descendantCount(node)));
      }
      ctx.assign(node.ref, dict);
      assignNodes(node.children, node.ref);
    });
  };
  assignNodes(roots, rootRef);
  const rootDict = ctx.obj({ Type: PDFName.of('Outlines') });
  rootDict.set(PDFName.of('First'), roots[0].ref);
  rootDict.set(PDFName.of('Last'), roots[roots.length - 1].ref);
  rootDict.set(PDFName.of('Count'), ctx.obj(all.length));
  ctx.assign(rootRef, rootDict);
  pdfDoc.catalog.set(PDFName.of('Outlines'), rootRef);
  pdfDoc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

function setLinkAnnotations(page, links, pdfDoc, PDFLib) {
  if (!links.length) return;
  const { PDFName } = PDFLib;
  const ctx = pdfDoc.context;
  const refs = links.map(link => ctx.register(ctx.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Link'),
    Rect: ctx.obj([link.x1, link.y1, link.x2, link.y2]),
    Border: ctx.obj([0, 0, 0]),
    Dest: ctx.obj([pdfDoc.getPage(link.pageIndex).ref, PDFName.of('Fit')]),
  })));
  page.node.set(PDFName.of('Annots'), ctx.obj(refs));
}

async function buildBinder() {
  if (!window.PDFLib) return alert('Binder library did not load. Check your internet connection and reload the page.');
  const selected = $$('#binderDocs input[type="checkbox"]:checked').map(x => x.value);
  if (!selected.length) return alert('Select at least one PDF.');
  const ordered = state.binderOrder.filter(id => selected.includes(id));
  const docs = [];
  for (const id of ordered) {
    let d = await dbGet(id);
    if (d) { d = await ensureDocModel(d); ensureEditState(d); docs.push(d); }
  }
  const title = normalize($('#binderTitle').value) || 'Compiled Binder';
  const addDividers = $('#binderDividers')?.checked ?? true;
  const addPageNumbers = $('#binderPageNumbers')?.checked ?? false;
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
  const out = await PDFDocument.create();
  out.setTitle(title);
  out.setCreator('PDFed');
  out.setProducer('PDFed Binder');
  const font = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  const binderPdfJsCache = new Map();

  const indexRows = [];
  for (const d of docs) {
    indexRows.push({ type: 'doc', level: 1, title: normalize(state.binderMeta[d.id]?.title) || d.name.replace(/\.pdf$/i,''), doc: d });
    for (const h of (d.structure || []).filter(h => h.level <= 2).slice(0, 120)) {
      const workIndex = planFor(d).findIndex(e => e.sourcePage === h.page);
      if (workIndex >= 0) indexRows.push({ type: 'section', level: h.level + 1, title: h.title, workIndex, doc: d });
    }
  }
  const rowsPerPage = 33;
  const indexPageCount = Math.max(1, Math.ceil(indexRows.length / rowsPerPage));
  const prefixPages = 1 + indexPageCount;

  let cursor = prefixPages;
  const plan = new Map();
  for (const d of docs) {
    const dividerIndex = addDividers ? cursor++ : null;
    const sourceStartIndex = cursor;
    const workingPlan = planFor(d);
    cursor += workingPlan.length;
    plan.set(d.id, { dividerIndex, sourceStartIndex, workingPlan });
  }

  let page = out.addPage([612, 792]);
  page.drawText(title, { x: 54, y: 650, size: 28, font: bold, color: rgb(.08,.09,.11) });
  page.drawText('Compiled with PDFed', { x: 54, y: 618, size: 11, font, color: rgb(.42,.45,.50) });
  page.drawText(`${docs.length} documents · ${docs.reduce((n,d) => n + planFor(d).length, 0)} working pages`, { x: 54, y: 588, size: 12, font, color: rgb(.20,.22,.25) });

  const tocPages = [];
  for (let ip = 0; ip < indexPageCount; ip++) {
    page = out.addPage([612, 792]);
    tocPages.push(page);
    page.drawText(ip === 0 ? 'Binder Index' : 'Binder Index — continued', { x: 54, y: 738, size: 18, font: bold, color: rgb(.08,.09,.11) });
    let y = 704;
    const links = [];
    const rows = indexRows.slice(ip * rowsPerPage, (ip + 1) * rowsPerPage);
    for (const row of rows) {
      const p = plan.get(row.doc.id);
      const targetIndex = row.type === 'doc' ? (p.dividerIndex ?? p.sourceStartIndex) : p.sourceStartIndex + row.workIndex;
      const displayPage = targetIndex + 1;
      const indent = row.type === 'section' ? 14 * Math.max(1, row.level - 1) : 0;
      const size = row.type === 'doc' ? 10.5 : row.level === 2 ? 9.4 : 8.8;
      const useFont = row.type === 'doc' ? bold : font;
      const maxChars = row.type === 'doc' ? 70 : 82 - indent / 2;
      const label = row.title.length > maxChars ? row.title.slice(0, maxChars - 1) + '…' : row.title;
      page.drawText(label, { x: 54 + indent, y, size, font: useFont, color: rgb(.16,.18,.21) });
      page.drawText(String(displayPage), { x: 526, y, size, font, color: rgb(.36,.39,.43) });
      links.push({ x1: 50 + indent, y1: y - 3, x2: 555, y2: y + 12, pageIndex: targetIndex });
      y -= 19;
    }
    page.__pdfedLinks = links;
  }

  const outlineEntries = [];
  status('Building binder…');
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    const p = plan.get(d.id);
    status(`Building binder · ${i + 1}/${docs.length}`);
    if (addDividers) {
      const divider = out.addPage([612, 792]);
      divider.drawText(`Document ${i + 1}`, { x: 54, y: 690, size: 11, font, color: rgb(.42,.45,.50) });
      const displayName = normalize(state.binderMeta[d.id]?.title) || d.name.replace(/\.pdf$/i,'');
      const name = displayName.length > 70 ? displayName.slice(0, 69) + '…' : displayName;
      divider.drawText(name, { x: 54, y: 642, size: 24, font: bold, color: rgb(.08,.09,.11), maxWidth: 500, lineHeight: 30 });
      divider.drawText(`${planFor(d).length} working pages · ${d.modelStats.sections} detected sections`, { x: 54, y: 580, size: 11, font, color: rgb(.34,.37,.42) });
    }
    const src = await PDFDocument.load(d.bytes.slice(0), { ignoreEncryption: true });
    const workingPlan = p.workingPlan || planFor(d);
    for (let localIdx=0; localIdx<workingPlan.length; localIdx++) {
      const entry=workingPlan[localIdx];
      await appendWorkingEntry(out,src,d,entry,font,rgb,{includeMarkups:true,pageNumber:addPageNumbers?(p.sourceStartIndex+localIdx+1):null,pdfJsCache:binderPdfJsCache});
    }
    outlineEntries.push({ level: 1, title: normalize(state.binderMeta[d.id]?.title) || d.name.replace(/\.pdf$/i,''), pageIndex: p.dividerIndex ?? p.sourceStartIndex });
    for (const h of (d.structure || []).filter(h => h.level <= 3).slice(0, 350)) {
      const workIndex=workingPlan.findIndex(e=>e.sourcePage===h.page);
      if(workIndex>=0) outlineEntries.push({ level: clamp(h.level + 1, 2, 4), title: h.title, pageIndex: p.sourceStartIndex + workIndex });
    }
  }

  for (const v of binderPdfJsCache.values()) { try { await v.task.destroy(); } catch (_) {} }
  tocPages.forEach(p => setLinkAnnotations(p, p.__pdfedLinks || [], out, window.PDFLib));
  try { addPdfOutlines(out, outlineEntries, window.PDFLib); } catch (err) { console.warn('Could not write PDF outline tree', err); }

  const bytes = await out.save({ useObjectStreams: true });
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const filename = `${slugify(title)}.pdf`;
  $('#binderResult').innerHTML = `<div class="downloadCard"><b>Binder ready.</b> Clickable index and generated PDF bookmarks included. <a id="binderDownload" download="${esc(filename)}">Download ${esc(filename)}</a></div>`;
  $('#binderDownload').href = url;
  status('Binder ready');
}


function sectionPlainText(section={}) { return normalize((section.paragraphs||[]).map(p=>p.text).join(' ')); }
function tokenSet(text='') { return new Set(canonical(text).split(/[^a-z0-9§.-]+/).filter(t=>t.length>2)); }
function jaccardText(a='',b='') {
  const A=tokenSet(a),B=tokenSet(b);if(!A.size&&!B.size)return 1;if(!A.size||!B.size)return 0;
  let inter=0;for(const t of A)if(B.has(t))inter++;return inter/(A.size+B.size-inter);
}
function buildSectionComparison(a,b){
  const mapA=new Map(),mapB=new Map();
  for(const s of a.sectionsModel||[]){const k=canonical(s.title);if(k&&!mapA.has(k))mapA.set(k,s);}
  for(const s of b.sectionsModel||[]){const k=canonical(s.title);if(k&&!mapB.has(k))mapB.set(k,s);}
  const rows=[];
  for(const [k,sa] of mapA){
    const sb=mapB.get(k);
    if(!sb){rows.push({kind:'removed',title:sa.title,a:sa,b:null,similarity:0});continue;}
    const ta=sectionPlainText(sa),tb=sectionPlainText(sb),sim=jaccardText(ta,tb);
    const exact=canonical(ta)===canonical(tb);
    rows.push({kind:exact?'same':sim>=.94?'minor':'changed',title:sa.title,a:sa,b:sb,similarity:sim});
  }
  for(const [k,sb] of mapB)if(!mapA.has(k))rows.push({kind:'added',title:sb.title,a:null,b:sb,similarity:0});
  const rank={changed:0,added:1,removed:2,minor:3,same:4};
  rows.sort((x,y)=>(rank[x.kind]-rank[y.kind])||x.title.localeCompare(y.title));
  return rows;
}
function compareKindLabel(row){
  if(row.kind==='changed')return `Changed · ${Math.round(row.similarity*100)}% text overlap`;
  if(row.kind==='minor')return `Likely minor change · ${Math.round(row.similarity*100)}% text overlap`;
  if(row.kind==='added')return 'Added in revision';
  if(row.kind==='removed')return 'Removed from revision';
  return 'No material text change detected';
}
function renderCompare(){
  const a=$('#compareA'),b=$('#compareB'),result=$('#compareResult');if(!a||!b||!result)return;
  if(state.docs.length<2){a.innerHTML=b.innerHTML=state.docs.map(d=>`<option value="${d.id}">${esc(d.name)}</option>`).join('');result.innerHTML='<div class="compareEmpty">Import at least two PDFs to compare revisions.</div>';return;}
  if(!state.compareA||!state.docs.some(d=>d.id===state.compareA))state.compareA=state.docs[1]?.id||state.docs[0].id;
  if(!state.compareB||!state.docs.some(d=>d.id===state.compareB)||state.compareB===state.compareA)state.compareB=state.docs[0]?.id===state.compareA?state.docs[1].id:state.docs[0].id;
  const opts=id=>state.docs.map(d=>`<option value="${d.id}" ${d.id===id?'selected':''}>${esc(d.name)}</option>`).join('');a.innerHTML=opts(state.compareA);b.innerHTML=opts(state.compareB);
  a.onchange=()=>{state.compareA=a.value;state.compareData=null;if(state.compareA===state.compareB){const alt=state.docs.find(d=>d.id!==state.compareA);if(alt)state.compareB=alt.id;}renderCompare();};
  b.onchange=()=>{state.compareB=b.value;state.compareData=null;if(state.compareA===state.compareB){const alt=state.docs.find(d=>d.id!==state.compareB);if(alt)state.compareA=alt.id;}renderCompare();};
  result.innerHTML=state.compareData?renderCompareResultShell(state.compareData):'<div class="compareEmpty">Choose an original and a revision, then run Compare.</div>';
  if(state.compareData)wireCompareResult();
}
function renderCompareResultShell(data){
  const rows=data.rows||[],changed=rows.filter(r=>r.kind==='changed').length,minor=rows.filter(r=>r.kind==='minor').length,added=rows.filter(r=>r.kind==='added').length,removed=rows.filter(r=>r.kind==='removed').length;
  const visible=rows.filter(r=>r.kind!=='same');
  return `<div class="compareSummary"><div><strong>${changed}</strong><span>Changed</span></div><div><strong>${minor}</strong><span>Minor</span></div><div><strong>${added}</strong><span>Added</span></div><div><strong>${removed}</strong><span>Removed</span></div></div>
    <div class="compareWorkspace">
      <aside class="changeList"><div class="changeListHead"><b>Section changes</b><span>${visible.length} flagged · ${rows.length} matched/checked</span></div>${visible.length?visible.map((r,i)=>`<button class="changeRow ${data.selectedIndex===i?'active':''} ${r.kind}" data-change-index="${i}"><b>${esc(r.title)}</b><span>${esc(compareKindLabel(r))}</span><small>${r.a?`p. ${r.a.page}`:'—'} → ${r.b?`p. ${r.b.page}`:'—'}</small></button>`).join(''):'<div class="compareClean">No section-level text changes were detected.</div>'}</aside>
      <section class="compareSources"><div class="compareSourceHead"><div><b>${esc(data.a.name)}</b><span>Original · page <input id="comparePageA" value="${data.aPage}" inputmode="numeric"> / ${data.a.pages}</span></div><button id="syncComparePages" class="${data.sync?'active':''}">${data.sync?'Linked pages':'Link pages'}</button><div><b>${esc(data.b.name)}</b><span>Revision · page <input id="comparePageB" value="${data.bPage}" inputmode="numeric"> / ${data.b.pages}</span></div></div><div class="compareCanvasGrid"><div class="compareCanvasWrap"><canvas id="compareCanvasA"></canvas></div><div class="compareCanvasWrap"><canvas id="compareCanvasB"></canvas></div></div></section>
    </div>`;
}
async function renderCompareCanvas(canvas,doc,pageNo){
  if(!canvas||!doc)return;const task=pdfjsLib.getDocument({data:new Uint8Array(doc.bytes.slice(0))});try{const pdf=await task.promise,page=await pdf.getPage(clamp(pageNo,1,doc.pages)),base=page.getViewport({scale:1,rotation:page.rotate||0}),target=Math.max(320,Math.min(700,canvas.parentElement?.clientWidth||560)),scale=target/base.width,vp=page.getViewport({scale,rotation:page.rotate||0}),ratio=Math.min(window.devicePixelRatio||1,1.6);canvas.width=Math.floor(vp.width*ratio);canvas.height=Math.floor(vp.height*ratio);canvas.style.width=`${Math.floor(vp.width)}px`;canvas.style.height=`${Math.floor(vp.height)}px`;const ctx=canvas.getContext('2d',{alpha:false});ctx.setTransform(ratio,0,0,ratio,0,0);await page.render({canvasContext:ctx,viewport:vp}).promise;}finally{try{await task.destroy();}catch(_){}}}
async function renderCompareCanvases(){const d=state.compareData;if(!d)return;await Promise.all([renderCompareCanvas($('#compareCanvasA'),d.a,d.aPage),renderCompareCanvas($('#compareCanvasB'),d.b,d.bPage)]);}
function wireCompareResult(){
  const d=state.compareData;if(!d)return;
  const visible=d.rows.filter(r=>r.kind!=='same');
  $$('[data-change-index]').forEach(btn=>btn.addEventListener('click',async()=>{const idx=+btn.dataset.changeIndex,row=visible[idx];d.selectedIndex=idx;if(row.a)d.aPage=row.a.page;if(row.b)d.bPage=row.b.page;$('#compareResult').innerHTML=renderCompareResultShell(d);wireCompareResult();await renderCompareCanvases();}));
  const setPage=async(which,value)=>{const key=which==='A'?'aPage':'bPage',doc=which==='A'?d.a:d.b;d[key]=clamp(+value||1,1,doc.pages);if(d.sync){const otherKey=which==='A'?'bPage':'aPage',other=which==='A'?d.b:d.a;d[otherKey]=clamp(d[key],1,other.pages);}$('#compareResult').innerHTML=renderCompareResultShell(d);wireCompareResult();await renderCompareCanvases();};
  $('#comparePageA')?.addEventListener('change',e=>setPage('A',e.target.value));$('#comparePageB')?.addEventListener('change',e=>setPage('B',e.target.value));
  $('#syncComparePages')?.addEventListener('click',async()=>{d.sync=!d.sync;if(d.sync)d.bPage=clamp(d.aPage,1,d.b.pages);$('#compareResult').innerHTML=renderCompareResultShell(d);wireCompareResult();await renderCompareCanvases();});
  renderCompareCanvases();
}
async function runCompareDocuments(){
  const aId=$('#compareA')?.value,bId=$('#compareB')?.value;if(!aId||!bId||aId===bId)return alert('Choose two different PDFs.');status('Comparing document structure…');
  let a=await dbGet(aId),b=await dbGet(bId);if(!a||!b)return;a=await ensureDocModel(a);b=await ensureDocModel(b);const rows=buildSectionComparison(a,b);const first=rows.find(r=>r.kind!=='same');state.compareA=aId;state.compareB=bId;state.compareData={a,b,rows,aPage:first?.a?.page||1,bPage:first?.b?.page||1,sync:false,selectedIndex:0};renderCompare();status(`Compare ready · ${rows.filter(r=>r.kind!=='same').length} flagged sections`);
}

function switchView(view) {
  $$('.nav').forEach(n => n.classList.toggle('active', n.dataset.view === view));
  $$('.view').forEach(v => v.classList.remove('active'));
  $(`#${view}View`).classList.add('active');
  if (view === 'binder') renderBinder();
  if (view === 'compare') renderCompare();
  if (view === 'library') renderLibraryHome();
}

function wireUi() {
  const pick = () => $('#fileInput').click();
  $('#openBtn').addEventListener('click', pick);
  $('#libraryOpenBtn').addEventListener('click', pick);
  $('#emptyOpenBtn').addEventListener('click', pick);
  $('#fileInput').addEventListener('change', async e => { await importFiles(e.target.files); e.target.value = ''; });
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
  $('#runCompare').addEventListener('click', runCompareDocuments);
  $('#confirmExport').addEventListener('click', async () => {
    const pending=state.exportPending||{};const filename=normalize($('#exportFilename').value)||'PDFed_revised.pdf';const includeMarkups=$('#exportMarkups').checked||$('#exportMarkups').disabled;
    $('#exportDialog').close();state.exportPending=null;await exportWorkingCopy(pending.entries||null,pending.suffix||'revised',{filename,includeMarkups});
  });
  $('#exportDialog').addEventListener('close',()=>{if(!$('#exportDialog').open)state.exportPending=null;});

  let dragDepth = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('#dropOverlay').classList.add('show'); });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('dragleave', e => { e.preventDefault(); dragDepth--; if (dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').classList.remove('show'); } });
  window.addEventListener('drop', async e => {
    e.preventDefault(); dragDepth = 0; $('#dropOverlay').classList.remove('show');
    if (e.dataTransfer?.files?.length) await importFiles(e.dataTransfer.files);
  });
  window.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); pick(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && state.current) { e.preventDefault(); openExportDialog(); return; }
    if (!state.current || ['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName)) return;
    if (state.mode === 'source') {
      const plan=planFor();
      if (e.key === 'ArrowLeft') { const i=Math.max(0,(state.planIndex??0)-1),p=plan[i]; if(p) showPage(p.sourcePage,i); }
      if (e.key === 'ArrowRight') { const i=Math.min(plan.length-1,(state.planIndex??0)+1),p=plan[i]; if(p) showPage(p.sourcePage,i); }
    }
  });
}

(async function init() {
  wireUi();
  await loadDocs();
  renderLibraryHome();
})();
