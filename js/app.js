'use strict';
/* =====================================================================
 * Worksheet Studio — offline build, MVC architecture
 *
 *   Model       source text -> structured worksheet data (pure logic,
 *               no DOM). Holds application state.
 *   View        everything the user sees: typeset blocks (text, tables,
 *               graphs, figures, compact grid/column layouts), page
 *               layout, preview scaling, status line, and PDF rendering.
 *   Controller  connects UI events to Model updates and View renders.
 *
 * Graphs and figures live in js/graph.js and js/figure.js; shared helpers
 * (inline formatting, expression compiler, picture layout) in js/core.js.
 * =================================================================== */

/* =====================================================================
 * MODEL
 * =================================================================== */
const Model = (() => {
  const { WorksheetError } = WSCore;
  const PROBLEM_RE = /^\s*([*★⋆]\s*)?(?:Problem|Question|Q|#)?\s*(\d+)\s*[.):]\s*(.*)$/i;
  const ANSWER_HEADER_RE = /^\s*(answer\s*key|answers|solutions?)\s*:?\s*$/i;
  const GRAPH_OPEN_RE = /^\s*\[graph\]\s*$/i, GRAPH_CLOSE_RE = /^\s*\[\/graph\]\s*$/i;
  const FIGURE_OPEN_RE = /^\s*\[figure\]\s*$/i, FIGURE_CLOSE_RE = /^\s*\[\/figure\]\s*$/i;
  // [grid 4] / [columns 3, norule] ... [/grid] / [/columns]
  const LAYOUT_OPEN_RE = /^\s*\[\s*(grid|columns|column|cols)\s*[:=]?\s*(\d+)\s*[,;]?\s*([^\]]*)\]\s*$/i;
  const LAYOUT_CLOSE_RE = /^\s*\[\/\s*(grid|columns|column|cols)\s*\]\s*$/i;

  // application state
  const state = {
    worksheet: null,       // { title, subtitle, problems[], answers[] }
    spacing: 'standard',   // workspace under each problem: none|compact|standard|large
    pageCount: 0
  };

  /** '[grid 4, plain, space: compact]' -> layout options (null for [columns 1]). */
  function parseLayout(m, id) {
    const kind = m[1].toLowerCase() === 'grid' ? 'grid' : 'columns';
    const n = parseInt(m[2], 10);
    if (n < 1 || n > 4) throw new WorksheetError(`[${m[1]} ${n}]: use 1 to 4 columns (4 max)`);
    const lay = { kind, n, boxed: true, rule: true, space: null, id };
    let opts = m[3].trim();
    const sm = opts.match(/\b(?:space|workspace)\s*[:=]?\s*(none|compact|standard|large)\b/i);
    if (sm) {
      lay.space = sm[1].toLowerCase();
      opts = opts.slice(0, sm.index) + opts.slice(sm.index + sm[0].length);
    }
    for (const w of opts.toLowerCase().split(/[\s,;]+/)) {
      if (!w) continue;
      if (['plain', 'noborder', 'noborders', 'unboxed'].includes(w)) lay.boxed = false;
      else if (['boxed', 'border', 'borders', 'lines'].includes(w)) lay.boxed = true;
      else if (['norule', 'nolines'].includes(w)) lay.rule = false;
      else if (w === 'rule') lay.rule = true;
      else {
        throw new WorksheetError(`[${m[1]} ${n}]: unknown option '${w}' (boxed, plain, rule, norule, ` +
                                 'space: none|compact|standard|large)');
      }
    }
    return kind === 'columns' && n === 1 ? null : lay;  // [columns 1] = normal layout
  }

  function parse(text) {
    const lines = text.split(/\r\n|\r|\n/);
    let title = null, subtitle = null, mode = 'head', current = null;
    let inBlock = null;   // close-tag regex of the [graph]/[figure] block we're inside
    let layout = null, layoutCount = 0;
    const problems = [], answers = [];
    const close = () => {
      if (current) (current.isAnswer ? answers : problems).push(current);
      current = null;
    };
    for (const raw of lines) {
      // lines inside a [graph]/[figure] block belong to the current problem
      // verbatim, even if one happens to look like "2." or "Answers"
      if (inBlock) {
        if (current) current.lines.push(raw);
        if (inBlock.test(raw)) inBlock = null;
        continue;
      }
      const lo = raw.match(LAYOUT_OPEN_RE), lc = LAYOUT_CLOSE_RE.test(raw);
      if (lo || lc) {
        close();
        if (mode === 'head' && title) mode = 'problems';
        layout = lo ? parseLayout(lo, ++layoutCount) : null;
        continue;
      }
      if (ANSWER_HEADER_RE.test(raw)) { close(); mode = 'answers'; layout = null; continue; }
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
        current = { num: +m[2], star: !!m[1], lines: m[3].trim() ? [m[3]] : [],
                    isAnswer: mode === 'answers', layout };
      } else if (current) {
        current.lines.push(raw);
        if (GRAPH_OPEN_RE.test(raw)) inBlock = GRAPH_CLOSE_RE;
        else if (FIGURE_OPEN_RE.test(raw)) inBlock = FIGURE_CLOSE_RE;
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

  return { state, parse, load, hasWorksheet, slug,
           GRAPH_OPEN_RE, GRAPH_CLOSE_RE, FIGURE_OPEN_RE, FIGURE_CLOSE_RE };
})();

/* =====================================================================
 * VIEW
 * =================================================================== */
const View = (() => {
  const { inlineFormat, fail } = WSCore;
  const PAGE_W = 816, PAGE_H = 1056;                 // US Letter @ 96 dpi
  const PAD_TOP = 44, PAD_BOTTOM = 52;
  const HEADER_H = 30;
  const CONTENT_H = PAGE_H - PAD_TOP - PAD_BOTTOM - HEADER_H;
  const PART_RE = /^\s*\(?([a-h])[).]\s+(.*)$/;
  const TABLE_ROW_RE = /^\s*\|/;
  const SEP_CELL_RE = /^:?-+:?$/;
  const SPACING_PX = { none: 0, compact: 70, standard: 120, large: 185 };
  const SECTION_GAP = 14;                            // below a grid / columns section
  const { GRAPH_OPEN_RE, GRAPH_CLOSE_RE, FIGURE_OPEN_RE, FIGURE_CLOSE_RE } = Model;

  const dom = {
    pages: () => document.getElementById('pages'),
    measure: () => document.getElementById('measure'),
    status: () => document.getElementById('status'),
    panel: () => document.querySelector('.preview-panel')
  };

  /* ---------- tables ---------- */
  /** Split '| a | $|x|$ | b |' into cells; pipes inside $...$ or written \| are kept. */
  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = [];
    let buf = '', inMath = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length && (s[i + 1] === '|' || s[i + 1] === '$')) {
        buf += s[i + 1] === '$' ? '\\$' : '|';
        i++;
        continue;
      }
      if (c === '$') inMath = !inMath;
      if (c === '|' && !inMath) { cells.push(buf.trim()); buf = ''; }
      else buf += c;
    }
    cells.push(buf.trim());
    return cells;
  }

  const visibleLen = cell => cell.replace(/\\[A-Za-z]+|[{}$*\\]/g, '').length;

  /**
   * Consecutive '| a | b |' lines -> a boxed, centered table. A second row
   * of dashes (|---|:--:|---:|) makes row 1 a shaded header and sets each
   * column's alignment; without it every row is a body row, centered.
   * Empty body cells are widened so students have room to write in them.
   */
  function renderTable(rows, opts) {
    const grid = rows.map(splitRow);
    let header = null, aligns = [], body = grid;
    if (grid.length >= 2 && grid[1].some(c => c) &&
        grid[1].every(c => !c || SEP_CELL_RE.test(c.replace(/ /g, '')))) {
      header = grid[0];
      aligns = grid[1].map(c => {
        c = c.replace(/ /g, '');
        if (!c || (c.startsWith(':') && c.endsWith(':'))) return 'center';
        return c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : 'center';
      });
      body = grid.slice(2);
    }
    const all = (header ? [header] : []).concat(body);
    const ncols = Math.max(...all.map(r => r.length));
    const pad = r => r.concat(Array(ncols - r.length).fill(''));
    if (header) header = pad(header);
    body = body.map(pad);
    aligns = aligns.concat(Array(ncols).fill('center')).slice(0, ncols);
    const rowsAll = (header ? [header] : []).concat(body);
    const widths = aligns.map((_, i) => Math.max(3, ...rowsAll.map(r => visibleLen(r[i]))));
    // long text columns wrap to the page width (LaTeX's tabularx X columns)
    const wide = widths.reduce((s, w) => s + w, 0) + 3 * ncols > 88;
    const wrap = widths.map(w => wide && (w > 14 || widths.every(v => v <= 14)));
    const style = i => {
      let a = aligns[i];
      if (wrap[i] && a === 'center' && widths[i] > 14) a = 'left';
      return ` style="text-align:${a}"` + (wrap[i] ? ' class="wrap"' : '');
    };
    const cell = (txt, i, th) => th
      ? `<th${style(i)}>${txt ? inlineFormat(txt, opts) : ''}</th>`
      : (txt ? `<td${style(i)}>${inlineFormat(txt, opts)}</td>` : '<td class="blank"></td>');
    let html = '';
    if (header) html += '<tr>' + header.map((c, i) => cell(c, i, true)).join('') + '</tr>';
    for (const r of body) html += '<tr>' + r.map((c, i) => cell(c, i, false)).join('') + '</tr>';
    return `<div class="ws-tablewrap"><table class="ws-table ${wide ? 'wide' : 'ws-fit'}">${html}</table></div>`;
  }

  /* ---------- problem bodies ---------- */
  /**
   * Interleaved paragraphs, (a)(b) part lists, [graph]/[figure] blocks
   * (consecutive ones sit side by side), and | pipe | tables.
   * opts.display: typeset inline math display-size (compact layouts).
   */
  function renderBody(lines, opts) {
    const out = [];
    let parts = null, para = [], pics = [];
    const fmt = s => inlineFormat(s, opts);
    const flushPara = () => {
      if (para.length) { out.push('<p>' + para.map(fmt).join(' ') + '</p>'); para = []; }
    };
    const flushParts = () => {
      if (!parts) return;
      // continue the lettering when a graph/table/paragraph interrupted the list
      const start = parts[0][0].charCodeAt(0) - 97;
      out.push('<div class="parts">' + parts.map(([, p], i) =>
        '<div class="part"><span class="part-label">(' + String.fromCharCode(97 + start + i) +
        ')</span><div class="part-body">' + fmt(p) + '</div></div>').join('') + '</div>');
      parts = null;
    };
    const flushPics = () => {
      if (!pics.length) return;
      out.push('<div class="ws-pics">' + pics.map(([kind, body]) =>
        kind === 'figure' ? WSFigure.render(body) : WSGraph.render(body)).join('') + '</div>');
      pics = [];
    };
    for (let i = 0; i < lines.length;) {
      const ln = lines[i];
      const isGraph = GRAPH_OPEN_RE.test(ln);
      if (isGraph || FIGURE_OPEN_RE.test(ln)) {
        const kind = isGraph ? 'graph' : 'figure', closeRe = isGraph ? GRAPH_CLOSE_RE : FIGURE_CLOSE_RE;
        flushParts();
        flushPara();
        let j = i + 1;
        while (j < lines.length && !closeRe.test(lines[j])) j++;
        if (j >= lines.length) fail(`a [${kind}] block is missing its closing [/${kind}] line`);
        pics.push([kind, lines.slice(i + 1, j)]);
        i = j + 1;
        continue;
      }
      if (GRAPH_CLOSE_RE.test(ln) || FIGURE_CLOSE_RE.test(ln)) {
        const kind = GRAPH_CLOSE_RE.test(ln) ? 'graph' : 'figure';
        fail(`found [/${kind}] without a matching [${kind}] above it`);
      }
      if (TABLE_ROW_RE.test(ln)) {
        flushPics();
        flushParts();
        flushPara();
        const rows = [];
        while (i < lines.length && TABLE_ROW_RE.test(lines[i])) rows.push(lines[i++]);
        out.push(renderTable(rows, opts));
        continue;
      }
      if (ln.trim()) flushPics();
      const pm = ln.match(PART_RE);
      if (pm) { flushPara(); (parts = parts || []).push([pm[1], pm[2]]); }
      else if (!ln.trim()) { flushParts(); flushPara(); }
      else { flushParts(); para.push(ln.trim()); }
      i++;
    }
    flushPics();
    flushParts();
    flushPara();
    return out.join('');
  }

  function el(className, html) {
    const d = document.createElement('div');
    d.className = className;
    d.innerHTML = html;
    return d;
  }

  const STAR = '<span class="star">&#9733;</span>';

  /* ---------- compact layouts: [grid N] and [columns N] ---------- */
  // number labels sit on the first text line's baseline, or at the top when
  // the body opens with a graph, figure, or table
  const opensWithBlock = body => /^<div class="ws-(pics|tablewrap)"/.test(body);

  /** "12. body" hanging-number item used inside grids and columns. */
  function compactItem(num, star, body) {
    if (star) body = body.startsWith('<p>') ? '<p>' + STAR + ' ' + body.slice(3) : STAR + ' ' + body;
    return '<div class="ws-citem' + (opensWithBlock(body) ? ' top' : '') + '">' +
           '<span class="ws-cnum">' + num + '.</span><div class="ws-cbody">' + body + '</div></div>';
  }

  const workspace = px => px ? '<span class="workspace" style="height:' + px + 'px"></span>' : '';

  /**
   * Cells laid out left to right, n per row. Each row is its own block, so
   * the grid can break across pages between rows (never inside one).
   */
  function gridRows(items, n, boxed, spacePx, pad) {
    const rows = [];
    for (let i = 0; i < items.length; i += n) {
      const cells = items.slice(i, i + n).map(it =>
        '<div class="ws-gcell" style="flex-basis:' + (100 / n) + '%">' + it + workspace(spacePx) + '</div>');
      const cls = 'ws-gridblock' + (i === 0 ? ' first' : '') + (i + n >= items.length ? ' last' : '');
      rows.push(el(cls, '<div class="ws-grow' + (boxed ? ' boxed' : '') + (pad ? '' : ' tight') + '">' +
                        cells.join('') + '</div>'));
    }
    return rows;
  }

  /* ---------- block construction ---------- */
  /**
   * Returns { worksheet, answers }: lists of units for the paginator. A unit
   * is { el } (an unbreakable block) or { cols: { n, rule, items } } (a
   * [columns N] section the paginator flows down N columns, page by page).
   */
  function buildBlocks(data, spacing) {
    const spacingPx = SPACING_PX[spacing] || 0;
    const worksheet = [], answers = [];

    let tb = '<div class="ws-title">' + inlineFormat(data.title) + '</div>';
    if (data.subtitle) tb += '<div class="ws-subtitle">' + inlineFormat(data.subtitle) + '</div>';
    tb += '<hr class="ws-rule">' +
          '<div class="ws-namedate"><span>Name: <span class="blank" style="width:190px"></span></span>' +
          '<span>Date: <span class="blank" style="width:120px"></span></span></div>';
    worksheet.push({ el: el('ws-titleblock', tb) });

    // consecutive problems from one [grid]/[columns] block form a segment
    const segs = [];
    for (const p of data.problems) {
      const last = segs[segs.length - 1];
      if (p.layout && last && last.lay && last.lay.id === p.layout.id) last.items.push(p);
      else segs.push({ lay: p.layout, items: [p] });
    }
    for (const { lay, items } of segs) {
      if (!lay) {
        for (const p of items) {
          worksheet.push({ el: el('problem',
            '<span class="problem-head">Problem ' + p.num + '.</span> ' +
            (p.star ? STAR + ' ' : '') + renderBody(p.lines) + workspace(spacingPx)) });
        }
        continue;
      }
      const space = lay.space ? SPACING_PX[lay.space] : spacingPx;
      const cells = items.map(p => compactItem(p.num, p.star, renderBody(p.lines, { display: true })));
      if (lay.kind === 'grid') {
        worksheet.push(...gridRows(cells, lay.n, lay.boxed, space, true).map(e => ({ el: e })));
      } else {
        worksheet.push({ cols: { n: lay.n, rule: lay.rule,
                                 items: cells.map(c => el('ws-colitem', c + workspace(space))) } });
      }
    }

    if (data.answers.length) {
      answers.push({ el: el('ak-title', 'Answer Key') });
      // answers to problems that sat in a grid/columns block (or answers
      // written inside their own) are packed n across, like their problems
      const probLayout = new Map(data.problems.map(p => [p.num, p.layout]));
      const asegs = [];
      for (const a of [...data.answers].sort((x, y) => x.num - y.num)) {
        const lay = a.layout || probLayout.get(a.num) || null;
        const key = lay ? (a.layout ? 'a' : 'p') + lay.id : null;
        const last = asegs[asegs.length - 1];
        if (key && last && last.key === key) last.items.push(a);
        else asegs.push({ key, lay, items: [a] });
      }
      for (const { lay, items } of asegs) {
        if (!lay) {
          for (const a of items) {
            const body = renderBody(a.lines);
            answers.push({ el: el('ak-item' + (opensWithBlock(body) ? ' top' : ''),
              '<span class="ak-num">' + a.num + '.</span><div class="ak-body">' + body + '</div>') });
          }
        } else {
          const cells = items.map(a => compactItem(a.num, false, renderBody(a.lines, { display: true })));
          answers.push(...gridRows(cells, lay.n, false, 0, false).map(e => ({ el: e })));
        }
      }
    }
    return { worksheet, answers };
  }

  /* ---------- pagination ---------- */
  /**
   * Lay units out offscreen at their real width (answers inside a mock
   * answer box) so pictures can be anchored and fitted, then record each
   * unit's height (and each column item's height).
   */
  function measure(units, wrapClass) {
    const surface = dom.measure();
    surface.innerHTML = '';
    let host = surface;
    if (wrapClass) host = surface.appendChild(el(wrapClass, ''));
    for (const u of units) {
      if (u.el) host.appendChild(u.el);
      else {
        const mock = el('ws-cols', '');
        for (let k = 0; k < u.cols.n; k++) mock.appendChild(el('ws-col', ''));
        u.cols.items.forEach(it => mock.firstChild.appendChild(it));
        host.appendChild(mock);
      }
    }
    WSCore.layout(surface);
    for (const u of units) {
      if (u.el) u.h = u.el.offsetHeight;
      else u.cols.hs = u.cols.items.map(it => it.offsetHeight);
    }
    surface.innerHTML = '';
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

  /**
   * Greedy newspaper fill of items[from..] into at most n columns of height
   * cap. Returns { cols: [[index...]...], end, height }.
   */
  function fillColumns(hs, from, n, cap) {
    const cols = [[]];
    let acc = 0, height = 0, j = from;
    for (; j < hs.length; j++) {
      if (acc + hs[j] > cap && acc > 0) {
        if (cols.length === n) break;
        cols.push([]);
        acc = 0;
      }
      cols[cols.length - 1].push(j);
      acc += hs[j];
      height = Math.max(height, acc);
    }
    return { cols, end: j, height };
  }

  function paginate(title, worksheetUnits, answerUnits) {
    const container = dom.pages();
    container.innerHTML = '';
    let pageNum = 0, used = 0, body = null;

    const startPage = () => {
      pageNum += 1;
      const p = newPage(title, pageNum);
      container.appendChild(p.page);
      body = p.body;
      used = 0;
    };
    const append = (block, h) => {
      if (!used) block.classList.add('page-first');  // e.g. re-draw a grid's top border
      body.appendChild(block);
      used += h;
    };

    measure(worksheetUnits);
    for (const u of worksheetUnits) {
      if (u.el) {
        if (!body || (used && used + u.h > CONTENT_H)) startPage();
        append(u.el, u.h);
        continue;
      }
      // [columns N]: fill columns to the page bottom, balance the last chunk
      const { n, rule, items, hs } = u.cols;
      let i = 0;
      while (i < items.length) {
        if (!body) startPage();
        const room = CONTENT_H - used - SECTION_GAP;
        let fit = fillColumns(hs, i, n, room);
        if (used && hs[i] > room) { startPage(); continue; }
        if (fit.end === items.length) {
          let lo = Math.max(...hs.slice(i)), hi = Math.max(lo, fit.height);
          for (let k = 0; k < 30 && hi - lo > 0.5; k++) {
            const mid = (lo + hi) / 2;
            if (fillColumns(hs, i, n, mid).end === items.length) hi = mid; else lo = mid;
          }
          fit = fillColumns(hs, i, n, hi);
        }
        const chunk = el('ws-cols' + (rule ? ' rule' : ''), '');
        for (let k = 0; k < n; k++) {
          const col = chunk.appendChild(el('ws-col', ''));
          for (const j of fit.cols[k] || []) col.appendChild(items[j]);
        }
        append(chunk, fit.height + SECTION_GAP);
        i = fit.end;
        if (i < items.length) startPage();
      }
    }

    if (answerUnits.length) {
      measure(answerUnits, 'ak-box');
      const BOX_PAD = 34;               // vertical padding + border of .ak-box
      let box = null;
      startPage();
      for (const u of answerUnits) {
        const isTitle = u.el.classList.contains('ak-title');
        if (used + u.h + (isTitle || box ? 0 : BOX_PAD) > CONTENT_H) {
          startPage();
          box = null;
        }
        if (isTitle) {
          append(u.el, u.h);
        } else {
          if (!box) {
            box = el('ak-box', '');
            body.appendChild(box);
            used += BOX_PAD;
          }
          box.appendChild(u.el);
          used += u.h;
        }
      }
    }
    return pageNum;
  }

  /* ---------- top-level renders ---------- */
  /** Render the full worksheet preview. Returns page count. */
  function render(data, spacing) {
    const { worksheet, answers } = buildBlocks(data, spacing);
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
        onProgress && onProgress('Rendering page ' + (i + 1) + ' of ' + pages.length + '…');
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
    try {
      const data = Model.load(srcEl().value, spacingEl().value);
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
    } catch (e) {
      // bad [graph] / [figure] / table / layout source: say which line and why
      downloadBtn().disabled = true;
      if (e instanceof WSCore.WorksheetError) View.setStatus('Input error: ' + e.message, true);
      else {
        console.error(e);
        View.setStatus('Could not render the worksheet: ' + e.message, true);
      }
    }
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
