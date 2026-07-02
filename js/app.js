'use strict';
/* =====================================================================
 * Worksheet Studio — offline build, MVC architecture
 *
 *   Model       source text -> structured worksheet data (pure logic,
 *               no DOM). Holds application state.
 *   View        everything the user sees: typeset blocks, page layout,
 *               preview scaling, status line, and PDF rendering.
 *   Controller  connects UI events to Model updates and View renders.
 * =================================================================== */

/* =====================================================================
 * MODEL
 * =================================================================== */
const Model = (() => {
  const PROBLEM_RE = /^\s*([*\u2605\u22C6]\s*)?(?:Problem|Question|Q|#)?\s*(\d+)\s*[.):]\s*(.*)$/i;
  const ANSWER_HEADER_RE = /^\s*(answer\s*key|answers|solutions?)\s*:?\s*$/i;

  // application state
  const state = {
    worksheet: null,   // { title, subtitle, problems[], answers[] }
    spacing: 120,      // workspace px under each problem
    pageCount: 0
  };

  function parse(text) {
    const lines = text.split(/\r?\n/);
    let title = null, subtitle = null, mode = 'head', current = null;
    const problems = [], answers = [];
    const close = () => {
      if (current) (current.isAnswer ? answers : problems).push(current);
      current = null;
    };
    for (const raw of lines) {
      if (ANSWER_HEADER_RE.test(raw)) { close(); mode = 'answers'; continue; }
      const m = raw.match(PROBLEM_RE);
      if (mode === 'head') {
        if (m && title) { mode = 'problems'; }
        else if (raw.trim()) {
          if (title === null) title = raw.trim();
          else if (subtitle === null) subtitle = raw.trim();
          continue;
        } else continue;
      }
      if (m) {
        close();
        current = { num: +m[2], star: !!m[1],
                    lines: m[3].trim() ? [m[3]] : [],
                    isAnswer: mode === 'answers' };
      } else if (current) {
        current.lines.push(raw);
      }
    }
    close();
    return { title: title || 'Worksheet', subtitle, problems, answers };
  }

  /** Parse source and store it as current state. Returns the data. */
  function load(text, spacing) {
    state.worksheet = parse(text);
    state.spacing = spacing;
    return state.worksheet;
  }

  const hasWorksheet = () => !!(state.worksheet && state.worksheet.problems.length);

  /** Filename-safe slug of the current title. */
  function slug() {
    if (!state.worksheet) return 'worksheet';
    return state.worksheet.title.replace(/\$[^$]*\$/g, '')
      .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'worksheet';
  }

  return { state, parse, load, hasWorksheet, slug };
})();

/* =====================================================================
 * VIEW
 * =================================================================== */
const View = (() => {
  const PAGE_W = 816, PAGE_H = 1056;                 // US Letter @ 96 dpi
  const PAD_TOP = 44, PAD_BOTTOM = 52;
  const HEADER_H = 30;
  const CONTENT_H = PAGE_H - PAD_TOP - PAD_BOTTOM - HEADER_H;
  const PART_RE = /^\s*\(?([a-h])[).]\s+(.*)$/;

  const dom = {
    pages: () => document.getElementById('pages'),
    measure: () => document.getElementById('measure'),
    status: () => document.getElementById('status'),
    panel: () => document.querySelector('.preview-panel')
  };

  /* ---------- text formatting ---------- */
  const escapeHTML = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // markdown only outside $...$ spans; math left raw for KaTeX
  // Placeholder for an escaped literal dollar sign ("\$", e.g. currency).
  // Math is rendered in THIS single pass via katex.renderToString — there is
  // no second auto-render scan of the DOM, so a literal $ in the output can
  // never be re-interpreted as a math delimiter later.
  const DOLLAR_PLACEHOLDER = '\u0000DOLLAR\u0000';

  function inlineFormat(s) {
    const protectedStr = s.replace(/\\\$/g, DOLLAR_PLACEHOLDER);
    return protectedStr.split(/(\${1,2}[^$]*\${1,2})/g).map(seg => {
      if (seg.startsWith('$')) {
        const display = seg.startsWith('$$');
        const body = (display ? seg.slice(2, -2) : seg.slice(1, -1))
          .split(DOLLAR_PLACEHOLDER).join('\\$');
        return katex.renderToString(body, { throwOnError: false, displayMode: display });
      }
      return escapeHTML(seg)
        .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
        .replace(/(^|[\s(])\*(?!\s)([^*]+?)(?<!\s)\*(?!\*)/g, '$1<i>$2</i>')
        .split(DOLLAR_PLACEHOLDER).join('$');
    }).join('');
  }

  function renderBody(lines) {
    let html = '', parts = null, para = [];
    const flushPara = () => {
      if (para.length) { html += '<p>' + para.map(inlineFormat).join(' ') + '</p>'; para = []; }
    };
    const flushParts = () => {
      if (parts) {
        html += '<ol class="parts" type="a">' + parts.map(p => '<li>' + inlineFormat(p) + '</li>').join('') + '</ol>';
        parts = null;
      }
    };
    for (const ln of lines) {
      const pm = ln.match(PART_RE);
      if (pm) { flushPara(); (parts = parts || []).push(pm[2]); }
      else if (!ln.trim()) { flushParts(); flushPara(); }
      else { flushParts(); para.push(ln.trim()); }
    }
    flushParts(); flushPara();
    return html;
  }

  function el(className, html) {
    const d = document.createElement('div');
    d.className = className;
    d.innerHTML = html;
    return d;
  }

  /* ---------- block construction ---------- */
  function buildBlocks(data, spacingPx) {
    const worksheet = [], answers = [];

    let tb = '<div class="ws-title">' + inlineFormat(data.title) + '</div>';
    if (data.subtitle) tb += '<div class="ws-subtitle">' + inlineFormat(data.subtitle) + '</div>';
    tb += '<hr class="ws-rule">' +
          '<div class="ws-namedate"><span>Name: <span class="blank" style="width:190px"></span></span>' +
          '<span>Date: <span class="blank" style="width:120px"></span></span></div>';
    worksheet.push(el('ws-titleblock', tb));

    for (const p of data.problems) {
      worksheet.push(el('problem',
        '<span class="problem-head">Problem ' + p.num + '.</span> ' +
        (p.star ? '<span class="star">&#9733;</span> ' : '') +
        renderBody(p.lines) +
        (spacingPx ? '<span class="workspace" style="height:' + spacingPx + 'px"></span>' : '')));
    }

    if (data.answers.length) {
      answers.push(el('ak-title', 'Answer Key'));
      for (const a of [...data.answers].sort((x, y) => x.num - y.num)) {
        answers.push(el('ak-item',
          '<span class="ak-num">' + a.num + '.</span><div>' + renderBody(a.lines) + '</div>'));
      }
    }

    return { worksheet, answers };
  }

  /* ---------- pagination ---------- */
  function measureHeights(blocks) {
    const surface = dom.measure();
    surface.innerHTML = '';
    blocks.forEach(b => surface.appendChild(b));
    const heights = blocks.map(b => b.offsetHeight);
    surface.innerHTML = '';
    return heights;
  }

  function newPage(title, pageNum) {
    const page = document.createElement('div');
    page.className = 'page';
    const head = document.createElement('div');
    head.className = 'page-header';
    head.innerHTML = '<span>' + inlineFormat(title) + '</span><span>Page ' + pageNum + '</span>';
    const body = document.createElement('div');
    body.className = 'page-body';
    page.appendChild(head);
    page.appendChild(body);
    return { page, body };
  }

  function paginate(title, worksheetBlocks, answerBlocks) {
    const container = dom.pages();
    container.innerHTML = '';
    let pageNum = 0, used = Infinity, body = null;

    const startPage = () => {
      pageNum += 1;
      const p = newPage(title, pageNum);
      container.appendChild(p.page);
      body = p.body;
      used = 0;
    };

    const wsHeights = measureHeights(worksheetBlocks);
    worksheetBlocks.forEach((block, i) => {
      if (used + wsHeights[i] > CONTENT_H) startPage();
      body.appendChild(block);
      used += wsHeights[i];
    });

    if (answerBlocks.length) {
      const akHeights = measureHeights(answerBlocks);
      const BOX_PAD = 34;               // vertical padding + border of .ak-box
      let box = null;
      startPage();
      answerBlocks.forEach((block, i) => {
        const h = akHeights[i];
        const isTitle = block.classList.contains('ak-title');
        if (used + h + (isTitle ? 0 : (box ? 0 : BOX_PAD)) > CONTENT_H) {
          startPage();
          box = null;
        }
        if (isTitle) {
          body.appendChild(block);
          used += h;
        } else {
          if (!box) {
            box = document.createElement('div');
            box.className = 'ak-box';
            body.appendChild(box);
            used += BOX_PAD;
          }
          box.appendChild(block);
          used += h;
        }
      });
    }
    return pageNum;
  }

  /* ---------- top-level renders ---------- */
  /** Render the full worksheet preview. Returns page count. */
  function render(data, spacingPx) {
    const { worksheet, answers } = buildBlocks(data, spacingPx);
    const n = paginate(data.title, worksheet, answers);
    fit();
    return n;
  }

  /** Scale fixed-width pages down to fit the preview panel. */
  function fit() {
    const pagesEl = dom.pages();
    const avail = dom.panel().clientWidth - 48;
    const scale = Math.min(1, avail / PAGE_W);
    pagesEl.style.transform = 'scale(' + scale + ')';
    pagesEl.style.transformOrigin = 'top left';
    pagesEl.style.width = PAGE_W + 'px';
    pagesEl.style.margin = scale < 1 ? '0' : '0 auto';
    const n = pagesEl.querySelectorAll('.page').length;
    pagesEl.style.height = n ? (n * (PAGE_H + 26) * scale) + 'px' : 'auto';
  }

  function setStatus(msg, isError) {
    const s = dom.status();
    s.textContent = msg;
    s.className = isError ? 'error' : '';
  }

  /** Render the visible preview pages into a letter-size PDF. */
  async function exportPdf(filename, onProgress) {
    const pages = Array.from(document.querySelectorAll('#pages .page'));
    if (!pages.length) throw new Error('Nothing to export — generate a worksheet first.');

    await document.fonts.ready;              // KaTeX fonts before rasterizing
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'in', format: 'letter', orientation: 'portrait' });

    const pagesEl = dom.pages();
    const savedTransform = pagesEl.style.transform;
    pagesEl.style.transform = 'scale(1)';    // capture at full resolution
    try {
      for (let i = 0; i < pages.length; i++) {
        onProgress && onProgress('Rendering page ' + (i + 1) + ' of ' + pages.length + '\u2026');
        const canvas = await html2canvas(pages[i], {
          scale: 2, backgroundColor: '#ffffff', logging: false,
          windowWidth: document.documentElement.scrollWidth
        });
        if (i > 0) pdf.addPage();
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, 8.5, 11);
      }
      pdf.save(filename + '.pdf');
    } finally {
      pagesEl.style.transform = savedTransform;
    }
  }

  return { render, fit, setStatus, exportPdf };
})();

/* =====================================================================
 * CONTROLLER
 * =================================================================== */
const Controller = (() => {
  const srcEl = () => document.getElementById('src');
  const spacingEl = () => document.getElementById('spacing');
  const generateBtn = () => document.getElementById('generateBtn');
  const downloadBtn = () => document.getElementById('downloadBtn');

  function generate() {
    const data = Model.load(srcEl().value, +spacingEl().value);
    if (!data.problems.length) {
      View.setStatus('No problems found — start lines with "Problem 1." or "1."', true);
      downloadBtn().disabled = true;
      return;
    }
    const nPages = View.render(data, Model.state.spacing);
    Model.state.pageCount = nPages;
    downloadBtn().disabled = false;
    View.setStatus(data.problems.length + ' problem' + (data.problems.length > 1 ? 's' : '') +
                   (data.answers.length ? ' · answer key' : '') + ' · ' +
                   nPages + ' page' + (nPages > 1 ? 's' : ''));
  }

  async function download() {
    if (!Model.hasWorksheet()) return;
    downloadBtn().disabled = true;
    generateBtn().disabled = true;
    try {
      await View.exportPdf(Model.slug(), View.setStatus);
      View.setStatus('PDF downloaded.');
    } catch (e) {
      View.setStatus('PDF export failed: ' + e.message, true);
    } finally {
      downloadBtn().disabled = false;
      generateBtn().disabled = false;
    }
  }

  function init() {
    generateBtn().addEventListener('click', generate);
    downloadBtn().addEventListener('click', download);
    window.addEventListener('resize', View.fit);
    // KaTeX fonts change block heights; generate after fonts settle
    document.fonts.ready.then(generate);
  }

  return { init };
})();

window.addEventListener('DOMContentLoaded', Controller.init);
