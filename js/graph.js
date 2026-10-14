'use strict';
/* =====================================================================
 * Worksheet Studio — [graph] ... [/graph] blocks
 *
 * A coordinate plane with axes, grid, tick numbers, and any mix of
 * functions, shaded inequalities, piecewise pieces with endpoint dots,
 * points, segments, vectors, lines, polygons, circles, and free text.
 * Parsed from one line per item, drawn as SVG (strokes/fills) plus
 * KaTeX-typeset HTML labels.
 *
 *   WSGraph.render(lines) -> HTML string for one picture
 * =================================================================== */
const WSGraph = (() => {
  const C = WSCore;
  const { fail, WorksheetError, PT, IN } = C;

  const COLOR_CYCLE = ['navy', 'red', 'green', 'orange', 'purple'].map(k => C.COLORS[k]);
  const SIZE_IN = { small: 1.7, medium: 3.0, large: 4.2 };
  const REL = '(<=|>=|=<|=>|≤|≥|\\\\leq?|\\\\geq?|<|>|=)';
  const SETTING_RE = /^(x|y|xstep|ystep|step|grid|numbers|xlabel|ylabel|size|title)\s*:\s*(.*)$/i;
  const CURVE_RE = new RegExp('^(y|[A-Za-z]\\s*\\(\\s*x\\s*\\))\\s*' + REL + '\\s*(.+)$');
  const VLINE_RE = new RegExp('^x\\s*' + REL + '\\s*(.+)$');
  const REL_SPLIT_RE = new RegExp(REL);
  const SHAPE_RE = /^(open\s+point|points?|segment|vector|line|polygon|circle|text)\b\s*(.*)$/i;
  const FILLER = new Set(['to', 'and', 'from', 'through', 'center', 'centre', 'at', 'with', 'vertices']);
  const ANCHOR8 = ['west', 'south west', 'south', 'south east', 'east', 'north east', 'north', 'north west'];

  const GRID = '#D4D4D4', AXIS = '#262626', TICK = '#4D4D4D', BLACK = '#000000';

  const normRel = op => ({
    '=<': '<=', '=>': '>=', '≤': '<=', '≥': '>=',
    '\\le': '<=', '\\leq': '<=', '\\ge': '>=', '\\geq': '>='
  }[op] || op);

  /* ---------------------------------------------------------------
   * Parsing
   * ------------------------------------------------------------- */
  function parseRange(val, what) {
    val = C.stripChars(val.trim(), '[]');
    const parts = val.split(/\s*(?:\bto\b|\.\.|,)\s*/).filter(p => p.trim());
    if (parts.length !== 2) fail(`${what} range should look like '-5 to 5', got '${val}'`);
    const lo = C.constValue(parts[0]), hi = C.constValue(parts[1]);
    if (!(lo < hi)) fail(`${what} range '${val}': the first number must be smaller`);
    return [lo, hi];
  }

  /** 'A(1,2) B (3, 4) to (5,6)' -> [['A',1,2], ['B',3,4], [null,5,6]], leftover words */
  function scanCoords(s) {
    const coords = [], words = [];
    let name = null, i = 0;
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c) || c === ',') { i++; continue; }
      if (c === '(') {
        const j = C.matchParen(s, i);
        const parts = C.splitTop(s.slice(i + 1, j), ',');
        if (parts.length !== 2) fail(`expected a point like (2, -3), got '${s.slice(i, j + 1)}'`);
        coords.push([name, C.constValue(parts[0]), C.constValue(parts[1])]);
        name = null;
        i = j + 1;
        continue;
      }
      const rest = s.slice(i);
      let m = rest.match(/^(?:\$[^$]*\$|[A-Za-z][A-Za-z0-9_']*)/);
      if (m) {
        if (name) words.push(name);
        name = FILLER.has(m[0].toLowerCase()) ? null : m[0];
        i += m[0].length;
        continue;
      }
      m = rest.match(/^[^\sA-Za-z(,$]+/);
      if (name) { words.push(name); name = null; }
      const tok = m ? m[0] : c;
      if (!['--', '-', '->'].includes(tok)) words.push(tok);
      i += tok.length;
    }
    if (name) words.push(name);
    return [coords, words];
  }

  /** '-2 <= x < 3' -> [lo, loClosed, hi, hiClosed]; a missing side is null. */
  function parseDomain(src) {
    const toks = src.split(REL_SPLIT_RE).map(t => t.trim());
    if (![3, 5].includes(toks.length) || !toks.filter((_, k) => k % 2 === 0).includes('x')) {
      fail(`domain '${src}' should look like '-2 <= x < 3' or 'x >= 0'`);
    }
    let lo = null, hi = null, loC = true, hiC = true;
    const pos = toks.indexOf('x');
    for (const side of [-1, 1]) {
      const k = pos + 2 * side;
      if (k < 0 || k >= toks.length) continue;
      let op = normRel(toks[pos + side]);
      const val = C.constValue(toks[k]);
      // read as "x OP val" (flip the operator when val is on the left)
      if (side === -1) op = { '<': '>', '<=': '>=', '>': '<', '>=': '<=' }[op] || op;
      if (op === '>' || op === '>=') { lo = val; loC = op === '>='; }
      else if (op === '<' || op === '<=') { hi = val; hiC = op === '<='; }
      else fail(`domain '${src}' uses '=' — use <, <=, > or >=`);
    }
    return [lo, loC, hi, hiC];
  }

  function parseGraph(lines) {
    const g = {
      x: [-10, 10], y: [-10, 10], xstep: null, ystep: null, grid: true, numbers: true,
      xlabel: '$x$', ylabel: '$y$', size: SIZE_IN.medium, title: null, items: []
    };
    let stepBoth = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const sm = line.match(SETTING_RE);
        if (sm) {
          const key = sm[1].toLowerCase(), val = sm[2].trim();
          if (key === 'x' || key === 'y') g[key] = parseRange(val, key);
          else if (['xstep', 'ystep', 'step'].includes(key)) {
            const v = C.constValue(val);
            if (v <= 0) fail('step must be positive');
            if (key === 'step') stepBoth = v; else g[key] = v;
          } else if (key === 'grid' || key === 'numbers') g[key] = C.onOff(val, key);
          else if (key === 'xlabel' || key === 'ylabel') {
            g[key] = ['none', 'off', ''].includes(val.toLowerCase()) ? null : val;
          } else if (key === 'size') g.size = C.parseSize(val, SIZE_IN, '3.5in');
          else g.title = val;
          continue;
        }

        const [body, opts] = C.splitOpts(line);
        const item = { opts, src: line };
        const cm = body.match(CURVE_RE), vm = body.match(VLINE_RE), shp = body.match(SHAPE_RE);
        if (cm && !shp) {
          const expr = cm[3];
          const fm = expr.match(/\s+for\s+/);
          const fx = fm ? expr.slice(0, fm.index) : expr;
          Object.assign(item, { kind: 'curve', rel: normRel(cm[2]), f: C.compileExpr(fx), domain: null });
          if (fm) item.domain = parseDomain(expr.slice(fm.index + fm[0].length));
        } else if (vm && !shp) {
          Object.assign(item, { kind: 'vline', rel: normRel(vm[1]), c: C.constValue(vm[2]) });
        } else if (shp) {
          const kind = shp[1].toLowerCase().replace(/\s+/g, ' ');
          let rest = shp[2], radius = null;
          if (kind === 'circle') {
            const rm = rest.match(/\bradius\s*[:=]?\s*(.+)$/i);
            if (!rm) fail('circle needs a radius: circle (0, 0) radius 3');
            radius = C.constValue(rm[1]);
            rest = rest.slice(0, rm.index);
          }
          const [coords, words] = scanCoords(rest);
          const need = { point: 1, 'open point': 1, points: 1, segment: 2, vector: 2,
                         line: 2, polygon: 3, circle: 1, text: 1 }[kind];
          const exact = ['point', 'open point', 'text', 'circle', 'segment', 'vector', 'line'].includes(kind);
          if (coords.length < need || (exact && coords.length > need)) {
            fail(`'${kind}' takes ${need} point(s), found ${coords.length}`);
          }
          Object.assign(item, { kind, coords, radius });
          if (kind === 'text') {
            item.text = C.stripChars(rest.replace(/^\s*[A-Za-z]?\s*\([^)]*\)\s*:?\s*/, '').trim(), '"\'');
            if (!item.text) fail('text needs something to write: text (2, 3) Hello');
          } else if (words.length) {
            fail(`didn't understand '${words.join(' ')}'`);
          }
        } else {
          fail('expected a setting (x: -5 to 5), an equation (y = 2x + 1), ' +
               'or point / points / segment / vector / line / polygon / circle / text');
        }
        g.items.push(item);
      } catch (e) {
        if (e instanceof WorksheetError) throw new WorksheetError(`[graph] line '${line}': ${e.message}`);
        throw e;
      }
    }
    if (stepBoth) {
      g.xstep = g.xstep || stepBoth;
      g.ystep = g.ystep || stepBoth;
    }
    return g;
  }

  /* ---------------------------------------------------------------
   * Curve sampling: gaps at undefined points, breaks at jumps/asymptotes
   * ------------------------------------------------------------- */
  /** Bisect toward the edge of f's domain; return [x, f(x)] on the good side. */
  function refineEdge(f, goodX, badX) {
    let gy = f(goodX);
    for (let i = 0; i < 45; i++) {
      const m = (goodX + badX) / 2, fm = f(m);
      if (fm === null) badX = m;
      else { goodX = m; gy = fm; }
    }
    return [goodX, gy];
  }

  /** True if f is discontinuous between x0 and x1 (asymptote or step). */
  function jumps(f, x0, y0, x1, y1, ylo, yhi) {
    const yr = yhi - ylo;
    if ((y0 > yhi && y1 > yhi) || (y0 < ylo && y1 < ylo)) return false;
    if (Math.abs(y1 - y0) < 0.02 * yr) return false;
    let a = x0, fa = y0, b = x1, fb = y1;
    for (let i = 0; i < 45; i++) {
      const m = (a + b) / 2, fm = f(m);
      if (fm === null) return true;
      if (Math.abs(fm - fa) >= Math.abs(fb - fm)) { b = m; fb = fm; }
      else { a = m; fa = fm; }
      if (Math.abs(fb - fa) < 1e-3 * yr) return false;  // continuous, just steep
    }
    return true;
  }

  /** Sample f on [lo, hi] into continuous runs of [x, y]. */
  function sampleRuns(f, lo, hi, ylo, yhi, n = 600) {
    const runs = [];
    let cur = [], prevBad = null;
    for (let i = 0; i <= n; i++) {
      const x = lo + (hi - lo) * i / n, y = f(x);
      if (y === null) {
        if (cur.length) {
          cur.push(refineEdge(f, cur[cur.length - 1][0], x));
          runs.push(cur);
          cur = [];
        }
        prevBad = x;
        continue;
      }
      if (!cur.length && prevBad !== null) cur.push(refineEdge(f, x, prevBad));
      const last = cur[cur.length - 1];
      if (last && jumps(f, last[0], last[1], x, y, ylo, yhi)) { runs.push(cur); cur = []; }
      cur.push([x, y]);
      prevBad = null;
    }
    if (cur.length) runs.push(cur);
    return runs.filter(r => r.length >= 2);
  }

  /** Clip a polyline to lo <= y <= hi; returns the visible pieces. */
  function clipY(run, lo, hi) {
    const pieces = [];
    let cur = [];
    for (let k = 0; k + 1 < run.length; k++) {
      const [x0, y0] = run[k], [x1, y1] = run[k + 1];
      const dy = y1 - y0;
      let t0, t1;
      if (dy === 0) [t0, t1] = lo <= y0 && y0 <= hi ? [0, 1] : [1, 0];
      else {
        const ta = (lo - y0) / dy, tb = (hi - y0) / dy;
        t0 = Math.max(0, Math.min(ta, tb));
        t1 = Math.min(1, Math.max(ta, tb));
      }
      if (t0 > t1) {
        if (cur.length >= 2) pieces.push(cur);
        cur = [];
        continue;
      }
      const a = [x0 + t0 * (x1 - x0), y0 + t0 * dy], b = [x0 + t1 * (x1 - x0), y0 + t1 * dy];
      const last = cur[cur.length - 1];
      if (last && Math.abs(last[0] - a[0]) < 1e-12 && Math.abs(last[1] - a[1]) < 1e-12) cur.push(b);
      else {
        if (cur.length >= 2) pieces.push(cur);
        cur = [a, b];
      }
    }
    if (cur.length >= 2) pieces.push(cur);
    return pieces;
  }

  /** Ramer-Douglas-Peucker in window-normalised units (keeps the SVG small). */
  function simplify(pts, xr, yr, eps = 6e-4) {
    if (pts.length < 3) return pts;
    const keep = pts.map(() => false);
    keep[0] = keep[pts.length - 1] = true;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [i, j] = stack.pop();
      const ax = pts[i][0] / xr, ay = pts[i][1] / yr, bx = pts[j][0] / xr, by = pts[j][1] / yr;
      const dx = bx - ax, dy = by - ay, norm = Math.hypot(dx, dy) || 1e-12;
      let best = -1, idx = null;
      for (let k = i + 1; k < j; k++) {
        const d = Math.abs(dy * (pts[k][0] / xr - ax) - dx * (pts[k][1] / yr - ay)) / norm;
        if (d > best) { best = d; idx = k; }
      }
      if (idx !== null && best > eps) {
        keep[idx] = true;
        stack.push([i, idx], [idx, j]);
      }
    }
    return pts.filter((_, k) => keep[k]);
  }

  /* ---------------------------------------------------------------
   * Axis ticks
   * ------------------------------------------------------------- */
  function piFrac(v, maxden = 24) {
    const [p, q] = C.limitDenominator(v / Math.PI, maxden);
    return Math.abs(Number(p) / Number(q) * Math.PI - v) < 1e-9 * Math.max(1, Math.abs(v)) ? [p, q] : null;
  }

  function autoStep(lo, hi) {
    const span = hi - lo;
    // bounds like -2pi..2pi get pi-fraction ticks instead of integer ticks
    if (piFrac(lo) && piFrac(hi) && (Math.abs(lo) % 1 || Math.abs(hi) % 1)) {
      for (const q of [6, 4, 2, 1, 0.5]) if (span / (Math.PI / q) <= 16) return Math.PI / q;
    }
    // classic worksheet grids (-10..10, -5..5, 0..8) get one line per unit
    if (Number.isInteger(lo) && Number.isInteger(hi) && span >= 4 && span <= 24) return 1;
    const raw = span / 12;
    const k = Math.floor(Math.log10(raw));
    for (const mult of k >= 0 ? [1, 2, 5, 10] : [1, 2.5, 5, 10]) {
      if (mult * 10 ** k >= raw * (1 - 1e-9)) return mult * 10 ** k;
    }
    return 10 ** (k + 1);
  }

  function tickLabel(v, step, piMode, commas = false) {
    if (piMode) {
      const [P, Q] = C.limitDenominator(v / Math.PI, 48);
      const p = Number(P), q = Number(Q);
      if (p === 0) return '$0$';
      const sign = p < 0 ? '-' : '';
      const n = Math.abs(p) === 1 ? '\\pi' : `${Math.abs(p)}\\pi`;
      return q === 1 ? `$${sign}${n}$` : `$${sign}${n}/${q}$`;
    }
    const stepTxt = step.toFixed(10).replace(/0+$/, '');
    const decimals = stepTxt.includes('.') ? stepTxt.split('.')[1].length : 0;
    let s = v.toFixed(decimals);
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    if (s === '-0' || s === '') s = '0';
    const neg = s.startsWith('-');
    let [intpart, frac = ''] = s.replace(/^-+/, '').split('.');
    if (commas && intpart.length > 3) {
      const groups = [];
      for (let i = intpart.length; i > 0; i -= 3) groups.unshift(intpart.slice(Math.max(0, i - 3), i));
      intpart = groups.join('{,}');
    }
    return `$${neg ? '-' : ''}${intpart}${frac ? '.' + frac : ''}$`;
  }

  /**
   * Tick positions + labels ('' = no number). Labels are thinned (every
   * 2nd, 5th, ...) only as much as needed to keep them from colliding
   * along an axis lengthIn inches long.
   */
  function ticks(lo, hi, step, lengthIn, horizontal, hideZero, showNumbers) {
    const k0 = Math.ceil(lo / step - 1e-9), k1 = Math.floor(hi / step + 1e-9);
    const piMode = piFrac(step, 12) !== null && Math.abs(step - Math.round(step)) > 1e-9;
    let need = 0.2;
    if (horizontal) {
      const chars = Math.max(...[k0, k1].map(k =>
        tickLabel(k * step, step, piMode).replace(/[${}\\]|pi/g, 'x').length));
      need = 0.055 * chars + 0.1;
    }
    const commas = Math.max(Math.abs(lo), Math.abs(hi)) >= 10000;  // then 9{,}000 matches 12{,}000
    const spacing = lengthIn * step / (hi - lo);
    let every = 1;
    for (every of [1, 2, 4, 5, 10, 20, 50, 100]) if (spacing * every >= need) break;
    const out = [];
    for (let k = k0; k <= k1; k++) {
      const show = showNumbers && k % every === 0 && !(hideZero && k === 0);
      out.push([k * step, show ? tickLabel(k * step, step, piMode, commas) : '']);
    }
    return out;
  }

  /* ---------------------------------------------------------------
   * Rendering
   * ------------------------------------------------------------- */
  const lineStyle = (o, color, dashed = false) => ({
    color, width: { thick: 1.6, thin: 0.7 }[o.weight] || 1.1,
    style: o.style || (dashed ? 'dashed' : 'solid')
  });

  const pointName = name =>
    name.replace(/'+$/, '').length <= 2 && !name.startsWith('$') ? `$${name}$` : name;

  function render(lines) {
    const g = parseGraph(lines);
    const [xmin, xmax] = g.x, [ymin, ymax] = g.y;
    const xr = xmax - xmin, yr = ymax - ymin;
    const W = g.size, ratio = yr / xr;
    const H = ratio >= 0.5 && ratio <= 1.5 ? W * ratio : W * 0.75;
    const Wp = W * IN, Hp = H * IN;
    const X = x => (x - xmin) / xr * Wp, Y = y => (ymax - y) / yr * Hp;
    const P = ([x, y]) => [X(x), Y(y)];

    const xstep = g.xstep || autoStep(xmin, xmax), ystep = g.ystep || autoStep(ymin, ymax);
    const xMid = ymin < 0 && 0 < ymax;  // x-axis drawn through the interior
    const yMid = xmin < 0 && 0 < xmax;
    const xAxisAt0 = ymin <= 0 && 0 <= ymax, yAxisAt0 = xmin <= 0 && 0 <= xmax;
    const origin = xAxisAt0 && yAxisAt0;
    const xt = ticks(xmin, xmax, xstep, W, true, origin && xMid, g.numbers);
    const yt = ticks(ymin, ymax, ystep, H, false, origin, g.numbers);

    const cv = new C.Canvas();
    const axY = xMid ? Y(0) : Hp, axX = yMid ? X(0) : 0;
    const label = (x, y, text, color, anchor) => cv.label({
      x: X(x), y: Y(y), html: C.inlineFormat(text), anchor, color,
      bg: 0.85, sep: 1.5, osep: 2, layer: 1
    });

    // ---- background: grid, ticks, axes, tick numbers ------------------
    if (g.grid) {
      for (const [v] of xt) cv.path([[X(v), 0], [X(v), Hp]], { color: GRID, width: 0.35 });
      for (const [v] of yt) cv.path([[0, Y(v)], [Wp, Y(v)]], { color: GRID, width: 0.35 });
    }
    const tk = 1.5 * PT;
    for (const [v] of xt) cv.path([[X(v), axY - tk], [X(v), axY + tk]], { color: TICK, width: 0.5 });
    for (const [v] of yt) cv.path([[axX - tk, Y(v)], [axX + tk, Y(v)]], { color: TICK, width: 0.5 });
    const axis = (x0, y0, x1, y1, both) => {
      const L = Math.hypot(x1 - x0, y1 - y0), ux = (x1 - x0) / L, uy = (y1 - y0) / L, ext = 6 * PT;
      const sx = both ? x0 - ux * ext : x0, sy = both ? y0 - uy * ext : y0;
      const ex = x1 + ux * ext, ey = y1 + uy * ext;
      const back1 = cv.arrowHead(ex, ey, ux, uy, AXIS, 4.5, 3.6);
      const back0 = both ? cv.arrowHead(sx, sy, -ux, -uy, AXIS, 4.5, 3.6) : 0;
      cv.path([[sx + ux * back0, sy + uy * back0], [ex - ux * back1, ey - uy * back1]],
              { color: AXIS, width: 0.7 });
    };
    axis(0, axY, Wp, axY, xmin < 0);
    axis(axX, Hp, axX, 0, ymin < 0);
    const tickLbl = (x, y, html, anchor, cls) => cv.label({
      x, y, html: C.inlineFormat(html), anchor, size: 'tiny', bg: 0.9, sep: 1, cls
    });
    for (const [v, t] of xt) if (t) tickLbl(X(v), axY + tk, t, 'north', 'ws-tick-x');
    for (const [v, t] of yt) if (t) tickLbl(axX - tk, Y(v), t, 'east', 'ws-tick-y');

    // ---- axis labels and title ----------------------------------------
    const { xlabel, ylabel } = g;
    const conventional = !xMid && !yMid && [xlabel, ylabel].some(lab =>
      lab && lab.replace(/\$|\\[A-Za-z]+|[{}]/g, '').length > 3);
    if (conventional) {
      // long labels on a first-quadrant graph sit centered along the axes
      if (xlabel) cv.label({ x: Wp / 2, y: axY, html: C.inlineFormat(xlabel), anchor: 'north',
                             rel: 'below-xticks', cls: 'ws-axis-label', layer: 1 });
      if (ylabel) cv.label({ x: axX, y: Hp / 2, html: C.inlineFormat(ylabel), anchor: 'east',
                             rot: 90, rel: 'left-of-yticks', cls: 'ws-axis-label', layer: 1 });
    } else {
      // short labels sit just past the arrow tips
      if (xlabel) cv.label({ x: Wp, y: axY, html: C.inlineFormat(xlabel), anchor: 'west',
                             dx: 7, dy: -0.5, cls: 'ws-axis-label', layer: 1 });
      if (ylabel) cv.label({ x: axX, y: 0, html: C.inlineFormat(ylabel), anchor: 'south',
                             dy: 6, cls: 'ws-axis-label', layer: 1 });
    }
    if (g.title) {
      cv.label({ x: Wp / 2, y: 0, html: C.inlineFormat(g.title), anchor: 'south', bold: true,
                 color: C.COLORS.navy, dy: 6 + (ylabel && !conventional ? 16 : 3), cls: 'ws-title', layer: 1 });
    }

    // ---- plot items -----------------------------------------------------
    const fills = [], draws = [], dots = [], pending = [];
    let cycle = 0;
    const band = [ymin - 0.01 * yr, ymax + 0.01 * yr];
    const curveLabel = (pieces, color, text) => { if (pieces.length && text) pending.push([pieces, color, text]); };

    function addCurve(f, rel, domain, o, color) {
      let lo = xmin, hi = xmax, loC = null, hiC = null;
      if (domain) {
        const [dlo, dlc, dhi, dhc] = domain;
        if (dlo !== null) { lo = Math.max(lo, dlo); loC = dlo >= xmin ? dlc : null; }
        if (dhi !== null) { hi = Math.min(hi, dhi); hiC = dhi <= xmax ? dhc : null; }
        if (lo >= hi) return;
      }
      const runs = sampleRuns(f, lo, hi, ymin, ymax);
      const strict = rel === '<' || rel === '>';
      if (rel !== '=' && o.shade !== false) {
        const top = rel === '>' || rel === '>=' ? ymax : ymin;
        for (const run of runs) {
          const clamped = run.map(([x, y]) => [x, Math.min(Math.max(y, ymin), ymax)]);
          const poly = simplify(clamped, xr, yr).concat([[run[run.length - 1][0], top], [run[0][0], top]]);
          fills.push([poly, { fill: color, fillOpacity: 0.16, closed: true }]);
        }
      }
      const pieces = [];
      for (const run of runs) for (const p of clipY(run, band[0], band[1])) pieces.push(simplify(p, xr, yr));
      for (const p of pieces) draws.push([p, lineStyle(o, color, strict)]);
      for (const [xe, closed] of [[lo, loC], [hi, hiC]]) {
        if (closed === null) continue;
        let ye = f(xe);
        if (ye === null) ye = f(xe + (xe === lo ? 1e-9 : -1e-9));
        if (ye !== null && ymin <= ye && ye <= ymax) dots.push({ x: xe, y: ye, color, open: !closed, r: 2.1 });
      }
      curveLabel(pieces, color, o.label);
    }

    let prevPiece = null;  // color of the previous "for"-restricted curve, if it was one
    for (const it of g.items) {
      const o = it.opts, kind = it.kind;
      const isPiece = kind === 'curve' && it.domain !== null;
      let color;
      if (['point', 'open point', 'points', 'text'].includes(kind)) color = o.color || BLACK;
      else if (isPiece && prevPiece && !o.color) color = prevPiece;  // one piecewise function
      else color = o.color || COLOR_CYCLE[cycle++ % COLOR_CYCLE.length];
      prevPiece = isPiece ? color : null;

      if (kind === 'curve') {
        addCurve(it.f, it.rel, it.domain, o, color);
      } else if (kind === 'vline' || (kind === 'line' && Math.abs(it.coords[0][1] - it.coords[1][1]) < 1e-12)) {
        const c = kind === 'vline' ? it.c : it.coords[0][1];
        const rel = it.rel || '=';
        if (xmin <= c && c <= xmax) draws.push([[[c, ymin], [c, ymax]], lineStyle(o, color, rel === '<' || rel === '>')]);
        if (rel !== '=' && o.shade !== false) {
          const [a, b] = rel === '>' || rel === '>=' ? [Math.max(c, xmin), xmax] : [xmin, Math.min(c, xmax)];
          if (a < b) fills.push([[[a, ymin], [b, ymin], [b, ymax], [a, ymax]], { fill: color, fillOpacity: 0.16, closed: true }]);
        }
        if (o.label && xmin <= c && c <= xmax) label(c, ymin + 0.9 * yr, o.label, color, 'west');
      } else if (kind === 'line') {
        const [[, x1, y1], [, x2, y2]] = it.coords;
        const m = (y2 - y1) / (x2 - x1);
        addCurve(xv => m * (xv - x1) + y1, '=', null, o, color);
      } else if (['point', 'open point', 'points'].includes(kind)) {
        for (const [name, px, py] of it.coords) {
          if (!(xmin <= px && px <= xmax && ymin <= py && py <= ymax)) continue;
          dots.push({ x: px, y: py, color, open: kind === 'open point', r: 2.1 });
          const text = (kind !== 'points' ? o.label : null) || (name ? pointName(name) : null);
          if (text) {
            const h = px > xmin + 0.8 * xr ? 'east' : 'west';
            const v = py > ymin + 0.88 * yr ? 'north' : 'south';
            label(px, py, text, BLACK, `${v} ${h}`);
          }
        }
      } else if (kind === 'segment' || kind === 'vector') {
        const [[, x1, y1], [, x2, y2]] = it.coords;
        draws.push([[[x1, y1], [x2, y2]], lineStyle(o, color), kind === 'vector']);
        for (const [name, px, py] of it.coords) {
          if (kind === 'segment') dots.push({ x: px, y: py, color, open: false, r: 1.7 });
          if (name) {
            const [ox, oy] = px === x1 && py === y1 ? [px - x2, py - y2] : [px - x1, py - y1];
            const ang = Math.atan2(oy / yr * H, ox / xr * W) * (180 / Math.PI);
            label(px, py, pointName(name), BLACK, ANCHOR8[((C.pyRound(ang / 45) % 8) + 8) % 8]);
          }
        }
        if (o.label) curveLabel([[[x1, y1], [x2, y2]]], color, o.label);
      } else if (kind === 'polygon') {
        const pts = it.coords.map(([, px, py]) => [px, py]);
        const st = lineStyle(o, color);
        if (o.shade !== false) fills.push([pts, Object.assign({ fill: color, fillOpacity: 0.10, closed: true }, st)]);
        else draws.push([pts, Object.assign({ closed: true }, st)]);
        const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
        const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        for (const [name, px, py] of it.coords) {
          if (!name) continue;
          dots.push({ x: px, y: py, color, open: false, r: 1.6 });
          const ang = Math.atan2((py - cy) / yr * H, (px - cx) / xr * W) * (180 / Math.PI);
          label(px, py, pointName(name), BLACK, ANCHOR8[((C.pyRound(ang / 45) % 8) + 8) % 8]);
        }
        if (o.label) label(cx, cy, o.label, color, 'center');
      } else if (kind === 'circle') {
        const [, hx, hy] = it.coords[0], r = it.radius;
        const pts = [];
        for (let k = 0; k < 180; k++) {
          pts.push([hx + r * Math.cos(2 * Math.PI * k / 180), hy + r * Math.sin(2 * Math.PI * k / 180)]);
        }
        draws.push([pts, Object.assign({ closed: true }, lineStyle(o, color))]);
        if (o.label) {
          const a = 40 * (Math.PI / 180);
          label(hx + r * Math.cos(a), hy + r * Math.sin(a), o.label, color, 'south west');
        }
      } else if (kind === 'text') {
        const [, tx, ty] = it.coords[0];
        cv.label({ x: X(tx), y: Y(ty), html: C.inlineFormat(it.text), color, layer: 1 });
      }
    }

    // curve labels go last, once every dot is known
    const taken = [];
    for (const [pieces, color, text] of pending) {
      const len2 = p => Math.hypot((p[p.length - 1][0] - p[0][0]) / xr, (p[p.length - 1][1] - p[0][1]) / yr);
      let best = pieces[0];
      for (const p of pieces) if (len2(p) > len2(best)) best = p;
      const seg = [];
      for (let k = 0; k + 1 < best.length; k++) {
        seg.push(Math.hypot((best[k + 1][0] - best[k][0]) / xr, (best[k + 1][1] - best[k][1]) / yr));
      }
      const total = seg.reduce((s, d) => s + d, 0) || 1e-9;
      const slopeOf = (a, b) => (b[1] - a[1]) / yr * xr / ((b[0] - a[0]) || 1e-12);
      const at = frac => {
        const target = frac * total;
        let acc = 0;
        for (let k = 0; k < seg.length; k++) {
          const a = best[k], b = best[k + 1], d = seg[k];
          if (acc + d >= target && d > 0) {
            const t = (target - acc) / d;
            return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), slopeOf(a, b)];
          }
          acc += d;
        }
        const a = best[best.length - 2], b = best[best.length - 1];
        return [b[0], b[1], slopeOf(a, b)];
      };
      const clearance = (px, py) => {
        // normalised distance to the nearest thing a label shouldn't cover
        const d = [Math.min(px - xmin, xmax - px) / xr * 1.5, Math.min(py - ymin, ymax - py) / yr * 1.5];
        for (const q of dots.map(t => [t.x, t.y]).concat(taken)) d.push(Math.hypot((px - q[0]) / xr, (py - q[1]) / yr));
        if (yAxisAt0) d.push(Math.abs(px) / xr);
        if (xAxisAt0) d.push(Math.abs(py) / yr);
        return Math.min(...d);
      };
      let spot = null, bestC = -Infinity;
      for (const fr of [0.5, 0.4, 0.6, 0.3, 0.7, 0.25, 0.75, 0.85]) {
        const c = at(fr), v = clearance(c[0], c[1]);
        if (v > bestC) { bestC = v; spot = c; }
      }
      const [px, py, slope] = spot;
      taken.push([px, py]);
      // the open side of the curve: up-left of a rising curve, up-right of a
      // falling one (flipped below near the top edge)
      let h = slope > 0 ? 'east' : 'west', v = 'south';
      if (py > ymin + 0.85 * yr) { v = 'north'; h = slope > 0 ? 'west' : 'east'; }
      label(px, py, text, color, `${v} ${h}`);
    }

    // ---- assemble: fills and strokes clipped to the window --------------
    const saved = cv.ext.slice();
    for (const [pts, st] of fills) cv.path(pts.map(P), st, 'fill');
    for (const [pts, st, arrow] of draws) {
      let px = pts.map(P);
      if (arrow) {  // vector: Stealth tip at the second point
        const [a, b] = px, dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
        const back = cv.arrowHead(b[0], b[1], dx, dy, st.color, 6, 4.5, 'draw');
        px = [a, [b[0] - dx / L * back, b[1] - dy / L * back]];
      }
      cv.path(px, st, 'draw');
    }
    cv.ext = saved;  // clipped content never enlarges the picture
    cv.grow(0, 0);
    cv.grow(Wp, Hp);
    dots.sort((a, b) => (a.open ? 0 : 1) - (b.open ? 0 : 1));
    for (const d of dots) cv.dot(X(d.x), Y(d.y), d.color, d.r, d.open, 'dot');

    const clip = `wsclip${cv.id}`;
    const top = `<defs><clipPath id="${clip}"><rect x="0" y="0" width="${Wp}" height="${Hp}"/></clipPath></defs>` +
      `<g clip-path="url(#${clip})">${cv.body('fill')}${cv.body('draw')}</g>${cv.body('dot')}`;
    return cv.html('ws-graph', [cv.body(0), top]);
  }

  return { render, parseGraph, ticks, autoStep };
})();
