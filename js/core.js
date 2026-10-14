'use strict';
/* =====================================================================
 * Worksheet Studio — shared core
 *
 *   Errors        WorksheetError: bad [graph]/[figure]/table/layout
 *                 source; the message names the offending line.
 *   Text          inline formatting (KaTeX math + **bold** / *italic*)
 *                 and small string helpers shared by every block type.
 *   Expressions   a safe compiler for "2x^2 - 3", "|x - 2|",
 *                 "\frac{1}{2}x", "sin x" ... (no eval: a small
 *                 recursive-descent parser over whitelisted tokens).
 *   Options       the "[red, dashed, label: $f$]" bracket at the end of
 *                 a [graph] / [figure] line.
 *   Canvas        a picture builder: SVG layers for strokes and fills,
 *                 plus HTML labels (so they can hold KaTeX math) that a
 *                 layout pass positions once the browser can measure
 *                 them, the way TikZ anchors its nodes.
 * =================================================================== */
const WSCore = (() => {
  class WorksheetError extends Error {
    constructor(msg) { super(msg); this.name = 'WorksheetError'; }
  }
  const fail = msg => { throw new WorksheetError(msg); };

  const IN = 96;                 // CSS px per inch (pages are US Letter @ 96 dpi)
  const PT = 96 / 72.27;         // CSS px per TeX point

  /* ---------------------------------------------------------------
   * Text
   * ------------------------------------------------------------- */
  const escapeHTML = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // An escaped literal dollar sign ("\$", e.g. currency) is swapped for this
  // placeholder before math spans are found, so it can never pair up with a
  // real math delimiter. Math is rendered in this single pass via
  // katex.renderToString — there is no later auto-render scan of the DOM.
  const DOLLAR = '\u0000DOLLAR\u0000';
  const MATH_SPLIT_RE = /(\${1,2}[^$]*\${1,2})/g;
  const MATH_TOKEN_RE = /\u0000M(\d+)\u0000/g;
  const BOLD_RE = /\*\*(.+?)\*\*/g;
  const ITALIC_RE = /(^|[\s(])\*(?!\s)([^*]+?)(?<!\s)\*(?!\*)/g;
  let degreeHTML = null;   // a typeset ^\circ: KaTeX's text font has no good ° glyph

  /**
   * Format one raw line: HTML-escape and apply markdown outside $...$,
   * typeset math with KaTeX.
   *
   * Math spans are swapped for placeholder tokens first so **bold** and
   * *italic* are applied to the line as a whole — a bold span that encloses
   * inline math (**Step 1: solve $x$.**) keeps its markers together instead
   * of being sliced apart at the math boundary.
   *
   * opts.display: typeset inline math in display style (full-size \frac),
   * used for the short problems inside [grid] / [columns] layouts.
   */
  function inlineFormat(line, opts) {
    const displayStyle = !!(opts && opts.display);
    const store = [];
    const degree = () => {
      store.push(degreeHTML = degreeHTML || katex.renderToString('{}^{\\circ}', { throwOnError: false }));
      return '\u0000M' + (store.length - 1) + '\u0000';
    };
    const pieces = line.replace(/\\\$/g, DOLLAR).split(MATH_SPLIT_RE).map(seg => {
      if (!seg) return '';
      if (seg.startsWith('$')) {
        const display = seg.startsWith('$$');
        let body = (display ? seg.slice(2, -2) : seg.slice(1, -1))
          .split(DOLLAR).join('\\$').replace(/°/g, '^{\\circ}');
        if (displayStyle && !display) body = '\\displaystyle ' + body;
        store.push(katex.renderToString(body, { throwOnError: false, displayMode: display }));
        return '\u0000M' + (store.length - 1) + '\u0000';
      }
      return escapeHTML(seg).split(DOLLAR).join('$').replace(/°/g, degree);
    });
    return pieces.join('')
      .replace(BOLD_RE, '<b>$1</b>')
      .replace(ITALIC_RE, '$1<i>$2</i>')
      .replace(MATH_TOKEN_RE, (_, i) => store[+i]);
  }

  /** Split on sep, ignoring separators inside (), {}, [], $...$ or quotes. */
  function splitTop(s, sep = ',') {
    const parts = [];
    let buf = '', depth = 0, inMath = false, quote = null;
    for (const c of s) {
      if (quote) quote = c === quote ? null : quote;
      else if ((c === '"' || c === "'") && !inMath && depth === 0 && !buf) quote = c;
      else if (c === '$') inMath = !inMath;
      else if ('([{'.includes(c) && !inMath) depth++;
      else if (')]}'.includes(c) && !inMath) depth--;
      else if (c === sep && depth === 0 && !inMath) { parts.push(buf); buf = ''; continue; }
      buf += c;
    }
    parts.push(buf);
    return parts;
  }

  function matchParen(s, i) {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === '(') depth++;
      else if (s[j] === ')' && --depth === 0) return j;
    }
    return fail(`unbalanced parentheses in '${s}'`);
  }

  /** Compact number for messages: 2.5, -3, 0.3333. */
  function num(v) {
    const s = v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    return s === '-0' || s === '' ? '0' : s;
  }

  /** Python's round(): halves go to the even neighbour. */
  function pyRound(v) {
    const r = Math.round(v);
    return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
  }

  /** Python-style strip of any of `chars` from both ends. */
  function stripChars(s, chars) {
    let a = 0, b = s.length;
    while (a < b && chars.includes(s[a])) a++;
    while (b > a && chars.includes(s[b - 1])) b--;
    return s.slice(a, b);
  }

  /* ---------------------------------------------------------------
   * Exact fractions (for pi-multiple tick labels): Python's
   * Fraction(float).limit_denominator, on BigInts.
   * ------------------------------------------------------------- */
  const babs = n => (n < 0n ? -n : n);
  const bgcd = (a, b) => { a = babs(a); b = babs(b); while (b) [a, b] = [b, a % b]; return a; };
  const bfloordiv = (a, b) => { const q = a / b; return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q; };

  function floatToFrac(v) {
    if (v === 0) return [0n, 1n];
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, v);
    const hi = dv.getUint32(0), lo = dv.getUint32(4);
    const exp = (hi >>> 20) & 0x7ff;
    let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
    let e;
    if (exp === 0) e = -1074;
    else { mant |= 1n << 52n; e = exp - 1075; }
    let n = (hi >>> 31 ? -1n : 1n) * mant, d = 1n;
    if (e > 0) n <<= BigInt(e); else d <<= BigInt(-e);
    const g = bgcd(n, d);
    return [n / g, d / g];
  }

  function limitDenominator(v, maxden) {
    const [N, D] = floatToFrac(v);
    const M = BigInt(maxden);
    if (D <= M) return [N, D];
    let p0 = 0n, q0 = 1n, p1 = 1n, q1 = 0n, n = N, d = D;
    for (;;) {
      const a = bfloordiv(n, d);
      const q2 = q0 + a * q1;
      if (q2 > M) break;
      [p0, q0, p1, q1] = [p1, q1, p0 + a * p1, q2];
      [n, d] = [d, n - a * d];
    }
    const k = bfloordiv(M - q0, q1);
    return 2n * d * (q0 + k * q1) <= D ? [p1, q1] : [p0 + k * p1, q0 + k * q1];
  }

  /* ---------------------------------------------------------------
   * Expression compiler
   * ------------------------------------------------------------- */
  const FUNCS = {
    sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs,
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    sec: v => 1 / Math.cos(v), csc: v => 1 / Math.sin(v), cot: v => 1 / Math.tan(v),
    arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan,
    ln: Math.log, log: Math.log10, exp: Math.exp, floor: Math.floor, ceil: Math.ceil
  };
  const CONSTS = { pi: Math.PI, e: Math.E };
  // longest name first, so "sec" wins over "e" and "exp" over "e"
  const NAMES = [...Object.keys(FUNCS), ...Object.keys(CONSTS), 'x']
    .sort((a, b) => b.length - a.length);

  function braceGroup(s, i) {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}' && --depth === 0) return [s.slice(i + 1, j), j + 1];
    }
    return fail(`unbalanced braces in '${s}'`);
  }

  /** Rewrite \frac{a}{b} and \sqrt[n]{a} into plain parenthesised math. */
  function expandLatex(s) {
    let out = '', i = 0;
    while (i < s.length) {
      const rest = s.slice(i);
      let m = rest.match(/^\\[dt]?frac\s*(?=\{)/);
      if (m) {
        let [a, j] = braceGroup(s, i + m[0].length);
        while (j < s.length && s[j] === ' ') j++;
        if (j >= s.length || s[j] !== '{') fail('\\frac needs two {...} groups');
        let b;
        [b, j] = braceGroup(s, j);
        out += `((${expandLatex(a)})/(${expandLatex(b)}))`;
        i = j;
        continue;
      }
      m = rest.match(/^\\sqrt\s*(?:\[([^\]]*)\])?\s*(?=\{)/);
      if (m) {
        let [a, j] = braceGroup(s, i + m[0].length);
        a = expandLatex(a);
        const n = (m[1] || '').trim();
        if (!n || n === '2') out += `sqrt(${a})`;
        else if (n === '3') out += `cbrt(${a})`;
        else out += `((${a})^(1/(${n})))`;
        i = j;
        continue;
      }
      out += s[i];
      i++;
    }
    return out;
  }

  function delatex(src) {
    let s = src.replace(/\$/g, '');
    for (const [a, b] of [['−', '-'], ['·', '*'], ['×', '*'], ['÷', '/'],
                          ['π', 'pi'], ['²', '^2'], ['³', '^3']]) {
      s = s.split(a).join(b);
    }
    s = s.replace(/\\(?:left|right|big|Big)\b/g, '');
    s = s.replace(/\\[,;:! ]|\\quad\b/g, ' ');
    s = s.replace(/\\(?:cdot|times)\b/g, '*');
    s = s.replace(/\\div\b/g, '/');
    s = expandLatex(s);
    s = s.replace(/\\([A-Za-z]+)/g, ' $1 ');           // \pi -> pi, \sin -> sin
    return s.replace(/\{/g, '(').replace(/\}/g, ')');
  }

  function tokenize(s, src) {
    const toks = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      const rest = s.slice(i);
      let m = rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
      if (m) { toks.push(['num', m[0]]); i += m[0].length; continue; }
      if (/[A-Za-z]/.test(c)) {
        const word = rest.match(/^[A-Za-z]+/)[0];
        for (let j = 0; j < word.length;) {
          const name = NAMES.find(n => word.startsWith(n, j));
          if (!name) fail(`unknown name '${word}' in '${src}' (the variable must be x)`);
          toks.push([name === 'x' ? 'x' : name in CONSTS ? 'const' : 'func', name]);
          j += name.length;
        }
        i += word.length;
        continue;
      }
      if (rest.startsWith('**')) { toks.push(['op', '^']); i += 2; continue; }
      if ('+-*/^'.includes(c)) toks.push(['op', c]);
      else if (c === '(') toks.push(['lp', c]);
      else if (c === ')') toks.push(['rp', c]);
      else if (c === '|') toks.push(['bar', c]);
      else fail(`unexpected character '${c}' in '${src}'`);
      i++;
    }
    return toks;
  }

  /**
   * Compile a math expression in x into a function number -> number|null.
   * Accepts implicit multiplication (2x, 3(x+1), (x+1)(x-2)), ^ powers,
   * |x| bars, sqrt/cbrt/abs/trig/ln/log/exp/floor/ceil, pi and e, and common
   * LaTeX (\frac, \sqrt, \cdot, \pi). Returns null wherever the expression
   * is undefined, so a plot leaves a gap there.
   */
  function compileExpr(src, allowX = true) {
    const toks = tokenize(delatex(src), src);
    if (!allowX && toks.some(t => t[0] === 'x')) {
      fail(`'${src}' must be a number, not an expression in x`);
    }

    // "sin x" / "sqrt 2" -> sin(x) / sqrt(2)
    const fixed = [];
    for (let k = 0; k < toks.length; k++) {
      fixed.push(toks[k]);
      if (toks[k][0] !== 'func') continue;
      const nxt = toks[k + 1];
      if (nxt && ['num', 'x', 'const'].includes(nxt[0])) {
        fixed.push(['lp', '('], nxt, ['rp', ')']);
        k++;
      } else if (!nxt || nxt[0] !== 'lp') {
        fail(`'${toks[k][1]}' needs its argument in parentheses, e.g. ${toks[k][1]}(x)`);
      }
    }

    // absolute-value bars + implicit multiplication
    const valueEnd = new Set(['num', 'x', 'const', 'rp', 'barclose']);
    const valueStart = new Set(['num', 'x', 'const', 'func', 'lp', 'baropen']);
    const out = [];
    let prev = null, openBars = 0;
    for (let [kind, text] of fixed) {
      if (kind === 'bar') {
        // a bar closes only if one is open and it follows a complete value
        if (openBars && valueEnd.has(prev)) { kind = 'barclose'; openBars--; }
        else { kind = 'baropen'; openBars++; }
      }
      if (valueEnd.has(prev) && valueStart.has(kind)) out.push(['op', '*']);
      if (kind === 'baropen') out.push(['func', 'abs'], ['lp', '(']);
      else if (kind === 'barclose') out.push(['rp', ')']);
      else out.push([kind, text]);
      prev = kind;
    }

    // recursive descent with Python's precedence: + - < * / < unary < ^ (right assoc)
    const bad = () => fail(`can't read the expression '${src}'`);
    let pos = 0;
    const peek = () => out[pos];
    const isOp = (t, chars) => t && t[0] === 'op' && chars.includes(t[1]);
    function parseSum() {
      let node = parseProduct();
      while (isOp(peek(), '+-')) {
        const op = out[pos++][1], a = node, b = parseProduct();
        node = op === '+' ? x => a(x) + b(x) : x => a(x) - b(x);
      }
      return node;
    }
    function parseProduct() {
      let node = parseUnary();
      while (isOp(peek(), '*/')) {
        const op = out[pos++][1], a = node, b = parseUnary();
        node = op === '*' ? x => a(x) * b(x) : x => a(x) / b(x);
      }
      return node;
    }
    function parseUnary() {
      if (isOp(peek(), '+-')) {
        const op = out[pos++][1], a = parseUnary();
        return op === '-' ? x => -a(x) : a;
      }
      return parsePower();
    }
    function parsePower() {
      const base = parsePrimary();
      if (isOp(peek(), '^')) {
        pos++;
        const ex = parseUnary();
        return x => Math.pow(base(x), ex(x));
      }
      return base;
    }
    function parsePrimary() {
      const t = out[pos++];
      if (!t) bad();
      if (t[0] === 'num') { const v = parseFloat(t[1]); return () => v; }
      if (t[0] === 'x') return x => x;
      if (t[0] === 'const') { const v = CONSTS[t[1]]; return () => v; }
      if (t[0] === 'lp') {
        const inner = parseSum();
        if (!out[pos] || out[pos][0] !== 'rp') bad();
        pos++;
        return inner;
      }
      if (t[0] === 'func') {
        const f = FUNCS[t[1]];
        if (!out[pos] || out[pos][0] !== 'lp') bad();
        pos++;
        const arg = parseSum();
        if (!out[pos] || out[pos][0] !== 'rp') bad();
        pos++;
        return x => f(arg(x));
      }
      return bad();
    }
    const root = parseSum();
    if (pos !== out.length) bad();

    return xv => {
      let v;
      try { v = root(xv); } catch { return null; }
      return Number.isFinite(v) ? v : null;
    };
  }

  function constValue(src) {
    const v = compileExpr(src, false)(0);
    if (v === null) fail(`'${src}' is not a real number`);
    return v;
  }

  /* ---------------------------------------------------------------
   * Options: "[red, dashed, label: $f(x)$]" at the end of a line
   * ------------------------------------------------------------- */
  const COLORS = {
    navy: '#19468C', blue: '#2E86DE', red: '#C0392B', green: '#1E8449',
    orange: '#D35400', purple: '#7D3C98', gold: '#B8892B',
    gray: '#7F8C8D', grey: '#7F8C8D', black: '#000000'
  };
  const FIG_FLAGS = {
    flip: 'flip', mirror: 'flip', fill: 'shade', shade: 'shade', shaded: 'shade',
    filled: 'shade', hidden: 'hidden', hide: 'hidden', nolabel: 'nolabel',
    nolabels: 'nolabel', unlabeled: 'nolabel', lengths: 'lengths', angles: 'angles',
    reflex: 'reflex', right: 'right', nodots: 'nodots', nocenter: 'nocenter', noarc: 'noarc'
  };

  /**
   * 'y = x^2 [red, dashed, label: $f$]' -> ['y = x^2', {color, style, label}].
   * figure=true also accepts the [figure] annotation options: ticks: n,
   * arcs: n, parallel: n, and flags like flip, fill, hidden, lengths.
   */
  function splitOpts(line, figure = false) {
    const m = line.match(/^(.*?)\s*\[([^[\]]*)\]\s*$/);
    if (!m) return [line, {}];
    const opts = {};
    for (let piece of splitTop(m[2], ',')) {
      piece = piece.trim();
      if (!piece) continue;
      const km = piece.match(/^(label|colou?r)\s*[:=]\s*(.*)$/i);
      const low = piece.toLowerCase();
      if (figure) {
        const cm = low.match(/^(ticks?|arcs?|parallel|arrows?)\s*(?:[:=]\s*(\d+))?$/);
        if (cm) {
          const key = { tick: 'ticks', arc: 'arcs', arrow: 'parallel', arrows: 'parallel' }[cm[1]] || cm[1];
          const n = cm[2] ? parseInt(cm[2], 10) : 1;
          if (n < 0 || n > 4) fail(`${key}: use 0 to 4`);
          opts[key] = n;
          continue;
        }
        const flag = FIG_FLAGS[low.replace(/ /g, '')];
        if (flag) {
          if (flag === 'noarc') opts.arcs = 0; else opts[flag] = true;
          continue;
        }
      }
      if (km) {
        const key = km[1].toLowerCase(), val = km[2].trim();
        if (key === 'label') opts.label = stripChars(val, '"\'');
        else if (val.toLowerCase() in COLORS) opts.color = COLORS[val.toLowerCase()];
        else fail(`unknown color '${val}' (use: ${Object.keys(COLORS).join(', ')})`);
      } else if ('"\''.includes(piece[0]) && piece[piece.length - 1] === piece[0]) {
        opts.label = piece.slice(1, -1);
      } else if (low in COLORS) {
        opts.color = COLORS[low];
      } else if (['dashed', 'dotted', 'solid'].includes(low)) {
        opts.style = low;
      } else if (['thick', 'thin'].includes(low)) {
        opts.weight = low;
      } else if (['noshade', 'no shade', 'unshaded', 'nofill', 'no fill'].includes(low)) {
        opts.shade = false;
      } else {
        const extra = figure ? 'ticks: n, arcs: n, parallel: n, flip, fill, hidden, nolabel, lengths, ' +
                               'angles, reflex, right, nodots, ' : '';
        fail(`unknown option '${piece}' (colors, dashed, dotted, thick, thin, noshade, ${extra}label: ...)`);
      }
    }
    return [m[1], opts];
  }

  function onOff(val, key) {
    const v = val.trim().toLowerCase();
    if (['on', 'yes', 'true', 'show'].includes(v)) return true;
    if (['off', 'no', 'false', 'none', 'hide'].includes(v)) return false;
    return fail(`${key}: expected on/off, got '${val}'`);
  }

  /** 'small' | 'medium' | 'large' | '3.5in' | '8cm' -> inches */
  function parseSize(val, sizes, example) {
    const low = val.toLowerCase();
    if (low in sizes) return sizes[low];
    const m = low.match(/^([\d.]+)\s*(in|cm)?$/);
    if (!m || isNaN(parseFloat(m[1]))) fail(`size: use small, medium, large, or e.g. ${example}`);
    return parseFloat(m[1]) / (m[2] === 'cm' ? 2.54 : 1);
  }

  /* ---------------------------------------------------------------
   * Canvas: SVG layers + HTML labels, coordinates in CSS px (y down)
   * ------------------------------------------------------------- */
  let uid = 0;
  const f2 = v => (Math.round(v * 100) / 100).toString();

  /** Stroke/fill attributes; dash patterns and widths are given in TeX pt. */
  function strokeAttrs(color, widthPt, style) {
    const dash = { dashed: [4, 2.5], dotted: [0.9, 2.2] }[style];
    return `stroke="${color}" stroke-width="${f2(widthPt * PT)}" ` +
      'stroke-linecap="round" stroke-linejoin="round"' +
      (dash ? ` stroke-dasharray="${f2(dash[0] * PT)} ${f2(dash[1] * PT)}"` : '');
  }

  class Canvas {
    constructor() {
      this.id = ++uid;
      this.ext = [Infinity, Infinity, -Infinity, -Infinity];
      this.layers = {};         // SVG fragments by layer key
      this.labels = [];
    }
    grow(x, y, pad = 0) {
      const e = this.ext;
      e[0] = Math.min(e[0], x - pad); e[1] = Math.min(e[1], y - pad);
      e[2] = Math.max(e[2], x + pad); e[3] = Math.max(e[3], y + pad);
    }
    add(svg, layer = 0) { (this.layers[layer] = this.layers[layer] || []).push(svg); }
    body(layer) { return (this.layers[layer] || []).join(''); }

    /** Polyline / polygon. st: {color, width (pt), style, fill, fillOpacity, closed} */
    path(pts, st, layer = 0) {
      if (pts.length < 2 || !(st.color || st.fill)) return;
      const pad = (st.color ? (st.width || 0.9) * PT / 2 : 0) + 1;
      pts.forEach(([x, y]) => this.grow(x, y, pad));
      const d = 'M' + pts.map(([x, y]) => f2(x) + ' ' + f2(y)).join('L') + (st.closed ? 'Z' : '');
      const fill = st.fill
        ? `fill="${st.fill}"` + (st.fillOpacity !== undefined ? ` fill-opacity="${st.fillOpacity}"` : '')
        : 'fill="none"';
      const stroke = st.color ? strokeAttrs(st.color, st.width || 0.9, st.style) : 'stroke="none"';
      this.add(`<path d="${d}" ${fill} ${stroke}/>`, layer);
    }
    /** Filled dot; open dots are white with a colored ring. Radius in pt. */
    dot(x, y, color, rPt, open = false, layer = 0) {
      const r = rPt * PT;
      this.grow(x, y, r + 1);
      this.add(open
        ? `<circle cx="${f2(x)}" cy="${f2(y)}" r="${f2(r)}" fill="#fff" stroke="${color}" stroke-width="${f2(0.9 * PT)}"/>`
        : `<circle cx="${f2(x)}" cy="${f2(y)}" r="${f2(r)}" fill="${color}"/>`, layer);
    }
    /**
     * TikZ "Stealth" arrow tip at (x, y) pointing along (dx, dy) (px, y down).
     * Returns how far (px) the line should stop short of the tip.
     */
    arrowHead(x, y, dx, dy, color, lenPt, widPt, layer = 0) {
      const L = Math.hypot(dx, dy) || 1;
      const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
      const len = lenPt * PT, half = widPt * PT / 2, inset = 0.325 * len;
      const bx = x - ux * len, by = y - uy * len;
      const pts = [[x, y], [bx + nx * half, by + ny * half],
                   [x - ux * (len - inset), y - uy * (len - inset)], [bx - nx * half, by - ny * half]];
      pts.forEach(([px, py]) => this.grow(px, py, 1));
      this.add(`<path d="M${pts.map(p => f2(p[0]) + ' ' + f2(p[1])).join('L')}Z" fill="${color}"/>`, layer);
      return len - inset;
    }
    /**
     * A text node anchored like TikZ: the point `anchor` of the label's
     * box (compass name or an angle in degrees, y up) sits at (x, y).
     * spec: {x, y, html, anchor, color, size ('small'|'tiny'), bg (opacity),
     *        sep (inner sep, pt), osep (outer sep, pt), dx/dy (shift, pt, y up),
     *        bold, rot, layer, cls, rel}
     */
    label(spec) { this.labels.push(spec); }

    /**
     * Two SVG layers with the labels interleaved: bodies[0], labels of
     * layer 0, bodies[1], labels of layer 1 (later = on top).
     */
    html(cls, bodies = [this.body(0), this.body(1)]) {
      let [x0, y0, x1, y1] = this.ext;
      if (!(x1 >= x0)) [x0, y0, x1, y1] = [0, 0, 1, 1];
      x0 = Math.floor(x0); y0 = Math.floor(y0); x1 = Math.ceil(x1); y1 = Math.ceil(y1);
      const w = x1 - x0, h = y1 - y0;
      // A plain div carries the position: html2canvas inlines an SVG's computed
      // styles before rasterizing it, so left/top on the <svg> itself would
      // shift the drawing inside the exported image.
      const svg = body => `<div class="ws-svgbox" style="left:${x0}px;top:${y0}px">` +
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
        `<g transform="translate(${-x0} ${-y0})">${body}</g></svg></div>`;
      const lbl = l => {
        const st = [`font-size:${l.size === 'tiny' ? 10.6 : 13.3}px`,
                    `padding:${f2((l.sep === undefined ? 3.33 : l.sep) * PT)}px`];
        if (l.color && l.color !== '#000000') st.push(`color:${l.color}`);
        if (l.bg) st.push(`background:rgba(255,255,255,${l.bg})`);
        if (l.bold) st.push('font-weight:700');
        const data = [`data-x="${f2(l.x)}"`, `data-y="${f2(l.y)}"`, `data-a="${l.anchor ?? 'center'}"`];
        if (l.osep) data.push(`data-o="${f2(l.osep * PT)}"`);
        if (l.dx) data.push(`data-dx="${f2(l.dx * PT)}"`);
        if (l.dy) data.push(`data-dy="${f2(l.dy * PT)}"`);
        if (l.rot) data.push(`data-rot="${l.rot}"`);
        if (l.rel) data.push(`data-rel="${l.rel}"`);
        return `<div class="ws-lbl${l.cls ? ' ' + l.cls : ''}" ${data.join(' ')} style="${st.join(';')}">${l.html}</div>`;
      };
      const layer = i => this.labels.filter(l => (l.layer || 0) === i).map(lbl).join('');
      return `<div class="ws-pic${cls ? ' ' + cls : ''}" data-ext="${x0} ${y0} ${x1} ${y1}">` +
        '<div class="ws-pic-canvas">' +
        svg(bodies[0]) + layer(0) + (bodies[1] ? svg(bodies[1]) : '') + layer(1) +
        '</div></div>';
    }
  }

  /* ---------------------------------------------------------------
   * Layout pass. Runs while blocks sit in the live DOM (the offscreen
   * measuring surface): measures every label, anchors it, sizes each
   * picture to the union of its drawing and labels, then shrinks any
   * picture or narrow table that is wider than its container (never
   * enlarges) — the website's version of LaTeX's \resizebox fit.
   * Shrinking rescales coordinates and font sizes rather than using CSS
   * transforms, which html2canvas does not reproduce reliably.
   * ------------------------------------------------------------- */
  const COMPASS = {
    center: [0, 0], north: [0, 1], south: [0, -1], east: [1, 0], west: [-1, 0],
    'north east': [1, 1], 'north west': [-1, 1], 'south east': [1, -1], 'south west': [-1, -1]
  };

  /** Offset (y up) from a box's centre to its anchor point. */
  function anchorOffset(anchor, hw, hh) {
    if (anchor in COMPASS) return [COMPASS[anchor][0] * hw, COMPASS[anchor][1] * hh];
    const a = parseFloat(anchor) * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a);
    const t = Math.min(Math.abs(dx) > 1e-9 ? hw / Math.abs(dx) : Infinity,
                       Math.abs(dy) > 1e-9 ? hh / Math.abs(dy) : Infinity);
    return [t * dx, t * dy];
  }

  function layoutPics(root) {
    const pics = Array.from(root.querySelectorAll('.ws-pic:not(.ws-laid)'));
    // read: every label's natural size (one forced layout for the batch)
    const infos = pics.map(pic => {
      const canvas = pic.firstElementChild;
      const lbls = Array.from(canvas.children).filter(c => c.classList.contains('ws-lbl'));
      return { pic, canvas, lbls, sizes: lbls.map(l => [l.offsetWidth, l.offsetHeight]) };
    });
    // compute + write: label positions, picture extents
    for (const info of infos) {
      const ext = info.pic.dataset.ext.split(' ').map(Number);
      let [bx0, by0, bx1, by1] = ext;
      const rects = [];
      const place = (l, [w, h], rx, ry) => {
        const d = l.dataset, o = parseFloat(d.o || 0);
        const rot = parseFloat(d.rot || 0);
        const [bw, bh] = rot % 180 ? [h, w] : [w, h];
        const [ox, oy] = anchorOffset(d.a, bw / 2 + o, bh / 2 + o);
        const cx = rx - ox + parseFloat(d.dx || 0), cy = ry + oy - parseFloat(d.dy || 0);
        l.style.left = f2(cx - w / 2) + 'px';
        l.style.top = f2(cy - h / 2) + 'px';
        if (rot) l.style.transform = `rotate(${-rot}deg)`;
        const r = [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2];
        rects.push(r);
        return r;
      };
      const pending = [];
      let xtickBottom = null, ytickLeft = null;
      info.lbls.forEach((l, i) => {
        if (l.dataset.rel) { pending.push(i); return; }
        const r = place(l, info.sizes[i], parseFloat(l.dataset.x), parseFloat(l.dataset.y));
        if (l.classList.contains('ws-tick-x')) xtickBottom = Math.max(xtickBottom ?? -Infinity, r[3]);
        if (l.classList.contains('ws-tick-y')) ytickLeft = Math.min(ytickLeft ?? Infinity, r[0]);
      });
      // graph axis labels that hang off the tick labels ("near ticklabel")
      for (const i of pending.filter(i => info.lbls[i].dataset.rel !== 'title')) {
        const l = info.lbls[i], d = l.dataset;
        let x = parseFloat(d.x), y = parseFloat(d.y);
        if (d.rel === 'below-xticks' && xtickBottom !== null) y = Math.max(y, xtickBottom);
        if (d.rel === 'left-of-yticks' && ytickLeft !== null) x = Math.min(x, ytickLeft);
        place(l, info.sizes[i], x, y);
      }
      for (const r of rects) {
        bx0 = Math.min(bx0, r[0]); by0 = Math.min(by0, r[1]);
        bx1 = Math.max(bx1, r[2]); by1 = Math.max(by1, r[3]);
      }
      // figure titles sit above everything else
      for (const i of pending.filter(i => info.lbls[i].dataset.rel === 'title')) {
        const r = place(info.lbls[i], info.sizes[i], (bx0 + bx1) / 2, by0);
        bx0 = Math.min(bx0, r[0]); by0 = Math.min(by0, r[1]);
        bx1 = Math.max(bx1, r[2]);
      }
      info.box = [Math.floor(bx0), Math.floor(by0), Math.ceil(bx1), Math.ceil(by1)];
      info.pic.classList.add('ws-laid');
    }
    // read: available widths; write: fit-to-width scale
    const avail = infos.map(info => contentWidth(info.pic.parentElement));
    infos.forEach((info, k) => {
      const [x0, y0, x1, y1] = info.box;
      const w = x1 - x0, h = y1 - y0;
      const s = avail[k] > 0 && w > avail[k] ? avail[k] / w : 1;
      if (s < 1) scalePic(info, s);
      info.canvas.style.left = f2(-x0 * s) + 'px';
      info.canvas.style.top = f2(-y0 * s) + 'px';
      info.pic.style.width = f2(w * s) + 'px';
      info.pic.style.height = f2(h * s) + 'px';
    });
  }

  /** Shrink a laid-out picture by s: SVG viewports, label positions and fonts. */
  function scalePic(info, s) {
    const px = v => f2(parseFloat(v) * s) + 'px';
    for (const box of info.canvas.querySelectorAll(':scope > .ws-svgbox')) {
      const svg = box.firstElementChild;
      svg.setAttribute('width', f2(parseFloat(svg.getAttribute('width')) * s));
      svg.setAttribute('height', f2(parseFloat(svg.getAttribute('height')) * s));
      box.style.left = px(box.style.left);
      box.style.top = px(box.style.top);
    }
    for (const l of info.lbls) {
      const st = l.style;
      st.left = px(st.left);
      st.top = px(st.top);
      st.fontSize = px(st.fontSize);
      st.padding = px(st.padding);
    }
  }

  function contentWidth(el) {
    if (!el) return 0;
    const cs = getComputedStyle(el);
    return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  }

  /** Shrink narrow tables (.ws-fit) wider than their container by scaling the font. */
  function layoutFits(root) {
    const fits = Array.from(root.querySelectorAll('.ws-fit:not(.ws-laid)'));
    const dims = fits.map(f => [f.offsetWidth, contentWidth(f.parentElement),
                                parseFloat(getComputedStyle(f).fontSize)]);
    fits.forEach((f, k) => {
      const [w, avail, size] = dims[k];
      f.classList.add('ws-laid');
      if (avail > 0 && w > avail) f.style.fontSize = f2(size * avail / w * 0.98) + 'px';
    });
  }

  function layout(root) {
    layoutPics(root);
    layoutFits(root);
  }

  return {
    WorksheetError, fail, IN, PT, escapeHTML, inlineFormat, splitTop, matchParen, num,
    pyRound, stripChars, limitDenominator, compileExpr, constValue, COLORS, splitOpts, onOff,
    parseSize, strokeAttrs, Canvas, layout
  };
})();
