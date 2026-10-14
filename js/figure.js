'use strict';
/* =====================================================================
 * Worksheet Studio — [figure] ... [/figure] blocks
 *
 * A to-scale geometry diagram with no axes. Shapes are placed by exact
 * coordinates or constructed from measurements (SSS / SAS / ASA
 * triangles, rectangles by width and height, ...); every point is
 * computed in a true-to-scale frame and the whole drawing is then scaled
 * uniformly to the requested size, so a 3-4-5 triangle really is 3-4-5
 * and a 60-degree angle looks like 60 degrees. Annotations (side labels,
 * angle measures, congruence ticks, angle arcs, right-angle squares,
 * parallel arrows) have fixed paper sizes, so they look the same at any
 * figure size.
 *
 *   WSFigure.render(lines) -> HTML string for one picture
 * =================================================================== */
const WSFigure = (() => {
  const C = WSCore;
  const { fail, WorksheetError, PT, IN } = C;

  const SIZE_IN = { small: 1.6, medium: 2.5, large: 3.5 };
  const PNAME = "[A-Z](?:_?\\d+)?'*";                         // A, B', P1, P_1, A1'
  const PNAME_RUN_RE = new RegExp(`^(?:${PNAME})+(?![A-Za-z])`);
  const PNAME_ONE_RE = new RegExp(PNAME, 'g');
  const PNAME_FULL_RE = new RegExp(`^${PNAME}$`);
  const REF_FILLER = new Set(['to', 'and', 'from', 'through', 'of', 'on']);
  const NUMTOK = '[^\\s,\\]]+';
  const SETTING_RE = /^(size|title|labels|grid|rotate|rotation)\s*:\s*(.*)$/i;
  const KINDS = [
    'points', 'point', 'right triangle', 'triangle', 'rectangle', 'square', 'parallelogram',
    'rhombus', 'trapezoid', 'trapezium', 'regular', 'polygon', 'quadrilateral', 'pentagon',
    'hexagon', 'circle', 'arc', 'sector', 'segment', 'line', 'ray', 'vector', 'side',
    'right angle', 'angle', 'text'
  ];
  const KIND_RE = new RegExp('^(' + KINDS.map(k => k.replace(/ /g, '\\s+')).join('|') + ')\\b\\s*(.*)$', 'i');
  const MEASURED_COUNT = { triangle: 3, 'right triangle': 3, rectangle: 4, square: 4,
                           parallelogram: 4, rhombus: 4, trapezoid: 4, trapezium: 4 };
  const SHAPES = ['triangle', 'right triangle', 'rectangle', 'square', 'parallelogram', 'rhombus',
                  'trapezoid', 'trapezium', 'regular', 'polygon', 'quadrilateral', 'pentagon', 'hexagon'];
  const BLACK = '#000000';

  // same rounding as Python's math.radians / math.degrees, so ties in label
  // placement break the same way as in the LaTeX version
  const DEG = 180 / Math.PI, RAD = Math.PI / 180;
  const rad = d => d * RAD;
  const ang = (dx, dy) => Math.atan2(dy, dx) * DEG;
  /** Python's float %: exact fmod, shifted into the divisor's sign. */
  const mod = (a, n) => {
    const r = a % n;
    return r && (r < 0) !== (n < 0) ? r + n : r;
  };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const cnum = s => C.constValue(s.replace(/°+$/, ''));
  const edgeKey = (a, b) => [a, b].sort().join('|');

  /** 'A' -> $A$, "A'" -> $A'$, 'P1' / 'P_1' -> $P_{1}$. */
  function nameTex(name) {
    const m = name.match(/^([A-Z])_?(\d*)('*)$/);
    if (!m) return name;
    return `$${m[1]}${m[2] ? `_{${m[2]}}` : ''}${m[3]}$`;
  }

  /** Pretty exact-ish length: 5, 4.5, $\sqrt{34}$, $3\sqrt{2}$, else 2 decimals. */
  function fmtLen(v) {
    if (Math.abs(v - Math.round(v)) < 1e-6) return String(Math.round(v));
    const sq = v * v, n = Math.round(sq);
    if (Math.abs(sq - n) < 1e-6 && n > 1 && n <= 2000) {
      let k = 1;
      for (let f = Math.floor(Math.sqrt(n)); f > 1; f--) if (n % (f * f) === 0) { k = f; break; }
      return `$${k > 1 ? k : ''}\\sqrt{${n / (k * k)}}$`;
    }
    if (Math.abs(v * 10 - Math.round(v * 10)) < 1e-6) return v.toFixed(1);
    return v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }

  function fmtDeg(v) {
    const s = Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1);
    return `$${s}^{\\circ}$`;
  }

  /* ---------------------------------------------------------------
   * Figure state
   * ------------------------------------------------------------- */
  class Figure {
    constructor() {
      this.pts = new Map();        // name -> [x, y]
      this.internal = new Set();   // auto-named anonymous coordinates (never labeled)
      this.hidden = new Set();
      this.dot = new Set();        // points that get a dot
      this.declared = new Set();   // points made with a 'point' line (always dotted)
      this.shown = [];             // points that get a name label (in order)
      this.nameText = new Map();   // custom label text for a point
      this.nolabel = new Set();
      this.items = [];
      this.polys = [];             // vertex-name lists of every drawn polygon
      this.size = SIZE_IN.medium;
      this.title = null;
      this.labels = true;
      this.grid = null;
      this.rotate = 0;
      this.anonCount = 0;
    }

    define(name, x, y) {
      const old = this.pts.get(name);
      if (old && dist(old, [x, y]) > 1e-7 * Math.max(1, Math.abs(x), Math.abs(y))) {
        fail(`point ${name} already exists at (${C.num(old[0])}, ${C.num(old[1])}) — ` +
             'use a new name (shapes that share a point must agree on where it is)');
      }
      this.pts.set(name, [+x, +y]);
    }

    anon(x, y) {
      const name = '#' + (++this.anonCount);
      this.define(name, x, y);
      this.internal.add(name);
      return name;
    }

    get(name) {
      if (!this.pts.has(name)) {
        fail(`point ${name} hasn't been defined yet — give it coordinates, ` +
             `e.g. ${name}(0, 0), or define it on an earlier line`);
      }
      return this.pts.get(name);
    }

    show(name, dot = false) {
      if (this.internal.has(name) || this.hidden.has(name)) return;
      if (!this.shown.includes(name)) this.shown.push(name);
      if (dot) this.dot.add(name);
    }

    pair(inner, whole) {
      const parts = C.splitTop(inner, ',');
      if (parts.length !== 2) fail(`expected a point like (2, -3), got '${whole}'`);
      return [C.constValue(parts[0]), C.constValue(parts[1])];
    }

    /**
     * Read leading point references: 'A(0,0) B (3, 4)', 'ABC', '(1, 2) to (3, 4)'.
     * Returns [names, rest]. Names given with coordinates are (re)defined;
     * bare names may still be undefined (the caller decides). Stops at the
     * first token that isn't a point reference ('AB=6', 'radius', '40°', ...).
     */
    refs(s) {
      const names = [];
      let i = 0;
      for (;;) {
        while (i < s.length && (/\s/.test(s[i]) || s[i] === ',')) i++;
        if (i >= s.length) break;
        if (s[i] === '(') {
          const j = C.matchParen(s, i);
          if (C.splitTop(s.slice(i + 1, j), ',').length !== 2) break;  // '(2x+10)°' is label text
          const [x, y] = this.pair(s.slice(i + 1, j), s.slice(i, j + 1));
          names.push(this.anon(x, y));
          i = j + 1;
          continue;
        }
        const rest = s.slice(i);
        const w = rest.match(/^[a-z]+\b/);
        if (w && REF_FILLER.has(w[0])) {
          // only skip a filler word if a point reference follows it
          const k = i + w[0].length, nxt = s.slice(k).trimStart();
          if (nxt[0] === '(' || PNAME_RUN_RE.test(nxt)) { i = k; continue; }
          break;
        }
        const m = rest.match(PNAME_RUN_RE);
        if (!m) break;
        const end = i + m[0].length, after = s.slice(end).trimStart(), run = m[0];
        if (after.startsWith('=') && names.length) break;  // 'AB=6' is a measurement
        if (after.startsWith('(')) {
          if (!PNAME_FULL_RE.test(run)) fail(`'${run}(...)': give coordinates to one point at a time`);
          const k = s.indexOf('(', end), j = C.matchParen(s, k);
          this.define(run, ...this.pair(s.slice(k + 1, j), s.slice(k, j + 1)));
          names.push(run);
          i = j + 1;
          continue;
        }
        names.push(...run.match(PNAME_ONE_RE));
        i = end;
      }
      return [names, s.slice(i).trim()];
    }
  }

  /** Value after a keyword: 'width 6', 'height: 4', 'radius=3' -> number or null. */
  function kw(rest, ...keys) {
    for (const key of keys) {
      const m = rest.match(new RegExp(`(?<![A-Za-z])${key}(?![A-Za-z])\\s*[:=]?\\s*(${NUMTOK})`, 'i'));
      if (m) return cnum(m[1]);
    }
    return null;
  }

  /* ---------------------------------------------------------------
   * Shapes from measurements
   * ------------------------------------------------------------- */
  /**
   * Solve a triangle from any determining set of sides/angles.
   * names = [P, Q, R]; sides are written 'PQ=5', angles 'angle P=40'
   * (also '∠P=40', 'm∠P = 40°'). 'sides 5 6 7' means PQ, QR, RP.
   * Returns local coordinates with P at the origin and Q on the +x axis.
   */
  function solveTriangle(names, rest) {
    const [P, Q, R] = names, V = names, tri = `${P}${Q}${R}`;
    const angle = new Map(), side = new Map();  // side keyed by the OPPOSITE vertex
    let rest2 = rest;
    const angRe = new RegExp(`(?:\\bangle\\s*|m?∠\\s*|\\\\angle\\s*)(${PNAME})\\s*[:=]\\s*(${NUMTOK})`, 'g');
    for (const m of rest.matchAll(angRe)) {
      if (!names.includes(m[1])) fail(`angle ${m[1]} isn't a vertex of triangle ${tri}`);
      angle.set(m[1], cnum(m[2]));
      rest2 = rest2.split(m[0]).join(' ');
    }
    const opposite = (a, b) => (a !== b && names.includes(a) && names.includes(b))
      ? names.find(v => v !== a && v !== b) : null;
    for (const m of rest2.matchAll(new RegExp(`\\b(${PNAME})(${PNAME})\\s*[:=]\\s*(${NUMTOK})`, 'g'))) {
      const o = opposite(m[1], m[2]);
      if (!o) fail(`${m[1]}${m[2]} isn't a side of triangle ${tri}`);
      side.set(o, C.constValue(m[3]));
    }
    const sm = rest2.match(new RegExp(`\\bsides?\\s*[:=]?\\s*(${NUMTOK})[\\s,]+(${NUMTOK})[\\s,]+(${NUMTOK})`));
    if (sm) {
      side.set(R, C.constValue(sm[1]));
      side.set(P, C.constValue(sm[2]));
      side.set(Q, C.constValue(sm[3]));
    }
    if ([...side.values()].some(v => v <= 0) || [...angle.values()].some(v => !(v > 0 && v < 180))) {
      fail('side lengths must be positive and angles between 0 and 180');
    }
    const others = v => V.filter(w => w !== v);
    for (let round = 0; round < 6; round++) {
      if (angle.size === 2) {
        const missing = V.find(v => !angle.has(v));
        angle.set(missing, 180 - [...angle.values()].reduce((s, a) => s + a, 0));
        if (angle.get(missing) <= 0) fail('those angles add up to 180° or more');
      }
      for (const v of V) {  // SAS: angle with both adjacent sides -> opposite side
        const [o1, o2] = others(v);
        if (angle.has(v) && !side.has(v) && side.has(o1) && side.has(o2)) {
          const a = side.get(o1), b = side.get(o2);
          side.set(v, Math.sqrt(a * a + b * b - 2 * a * b * Math.cos(rad(angle.get(v)))));
        }
      }
      if (side.size === 3) {
        const a = side.get(P), b = side.get(Q), c = side.get(R);
        if (a + b <= c || a + c <= b || b + c <= a) {
          fail(`sides ${fmtLen(c)}, ${fmtLen(a)}, ${fmtLen(b)} can't form a triangle (triangle inequality)`);
        }
        for (const v of V) {
          const [o1, o2] = others(v), s1 = side.get(o1), s2 = side.get(o2);
          const cosv = (s1 * s1 + s2 * s2 - side.get(v) ** 2) / (2 * s1 * s2);
          if (!angle.has(v)) angle.set(v, Math.acos(Math.max(-1, Math.min(1, cosv))) * DEG);
        }
        break;
      }
      const pair = V.find(v => angle.has(v) && side.has(v));
      if (pair) {  // law of sines
        const k = side.get(pair) / Math.sin(rad(angle.get(pair)));
        for (const v of V) {
          if (angle.has(v) && !side.has(v)) side.set(v, k * Math.sin(rad(angle.get(v))));
          else if (side.has(v) && !angle.has(v)) {
            const s = side.get(v) / k;
            if (s > 1 + 1e-9) fail('no triangle has those measurements (SSA with no solution)');
            angle.set(v, Math.asin(Math.min(1, s)) * DEG);  // SSA: the acute choice
          }
        }
      }
    }
    if (side.size < 3 || angle.size < 3) {
      fail(`not enough to pin down triangle ${tri} — give 3 sides (${P}${Q}=5 ${Q}${R}=6 ${R}${P}=7), ` +
           '2 sides and the angle between them, or 2 angles and a side ' +
           `(or coordinates: triangle ${P}(0,0) ${Q}(4,0) ${R}(1,3))`);
    }
    const c = side.get(R), b = side.get(Q), A = rad(angle.get(P));
    return [[0, 0], [c, 0], [b * Math.cos(A), b * Math.sin(A)]];
  }

  /**
   * Local coordinates for a measured shape: first vertex at the origin,
   * second on the +x axis, the rest above (counterclockwise).
   */
  function shapeLocal(kind, names, rest) {
    const n = names.length;
    if (kind === 'triangle') return solveTriangle(names, rest);
    if (kind === 'right triangle') {
      const legs = rest.match(new RegExp(`\\blegs?\\s*[:=]?\\s*(${NUMTOK})[\\s,]+(${NUMTOK})`));
      if (!legs) {
        fail('right triangle needs its legs, e.g. right triangle ABC legs 3 4 ' +
             '(right angle at B: AB = 3 along the base, BC = 4 up)');
      }
      const a = C.constValue(legs[1]), b = C.constValue(legs[2]);
      return [[0, 0], [a, 0], [a, b]];
    }
    if (kind === 'rectangle') {
      const by = rest.match(new RegExp(`(${NUMTOK})\\s*(?:by|x|×)\\s*(${NUMTOK})`));
      let w = kw(rest, 'width', 'length', 'base'), h = kw(rest, 'height');
      if (by) { w = C.constValue(by[1]); h = C.constValue(by[2]); }
      if (w === null || h === null) fail('rectangle needs a size: rectangle ABCD width 6 height 4  (or 6 by 4)');
      return [[0, 0], [w, 0], [w, h], [0, h]];
    }
    if (kind === 'square') {
      const s = kw(rest, 'side', 'length');
      if (s === null) fail('square needs a side: square ABCD side 4');
      return [[0, 0], [s, 0], [s, s], [0, s]];
    }
    if (kind === 'parallelogram' || kind === 'rhombus') {
      let b = kw(rest, 'base', 'side', 'length');
      let s = kind === 'rhombus' ? b : kw(rest, 'slant', 'side2', 'leg', 'other');
      let a = kw(rest, 'angle');
      a = a === null ? 60 : a;
      const h = kw(rest, 'height');
      if (kind === 'parallelogram' && s === null && h !== null) s = h / Math.sin(rad(a));
      if (kind === 'parallelogram' && s === null) {
        const m = rest.match(new RegExp(`\\bside\\s*[:=]?\\s*(${NUMTOK})`));
        const b2 = kw(rest, 'base');
        if (m && b2 !== null) { b = b2; s = C.constValue(m[1]); }
      }
      if (b === null || s === null) {
        fail(`${kind} needs its size, e.g. parallelogram ABCD base 6 side 4 angle 60 ` +
             '(or rhombus ABCD side 5 angle 60)');
      }
      const dx = s * Math.cos(rad(a)), dy = s * Math.sin(rad(a));
      return [[0, 0], [b, 0], [b + dx, dy], [dx, dy]];
    }
    if (kind === 'trapezoid' || kind === 'trapezium') {
      const b = kw(rest, 'bottom', 'base'), t = kw(rest, 'top'), h = kw(rest, 'height');
      if (b === null || t === null || h === null) {
        fail('trapezoid needs bottom, top and height: trapezoid ABCD bottom 8 top 4 height 3');
      }
      let o = kw(rest, 'offset', 'shift');
      o = o === null ? (b - t) / 2 : o;
      return [[0, 0], [b, 0], [o + t, h], [o, h]];
    }
    if (kind === 'regular') {
      if (n < 3) fail('a regular polygon needs at least 3 vertex names: regular ABCDEF side 3');
      let s = kw(rest, 'side', 'length');
      const r = kw(rest, 'radius', 'circumradius');
      if (s === null && r !== null) s = 2 * r * Math.sin(Math.PI / n);
      if (s === null) fail('regular polygon needs a side (or radius): regular ABCDEF side 3');
      const pts = [];
      let x = 0, y = 0, h = 0;
      for (let k = 0; k < n; k++) {
        pts.push([x, y]);
        x += s * Math.cos(h);
        y += s * Math.sin(h);
        h += 2 * Math.PI / n;
      }
      return pts;
    }
    return fail(`can't build a ${kind} from measurements`);
  }

  function placeMeasured(fig, kind, names, rest, opts) {
    const at = rest.match(new RegExp(`\\bat\\s*(\\([^)]*\\)|${PNAME})`));
    const rot = kw(rest, 'rotate', 'rotated', 'turn', 'turned');
    if (at) rest = rest.slice(0, at.index) + rest.slice(at.index + at[0].length);
    if (rot !== null) rest = rest.replace(new RegExp(`\\b(?:rotate|rotated|turn|turned)\\s*[:=]?\\s*${NUMTOK}`, 'g'), ' ');
    const [n0, n1] = names;
    if (!at && fig.pts.has(n0) && fig.pts.has(n1)) {
      // built on an existing side: take its length from the drawing
      const hv = dist(fig.pts.get(n0), fig.pts.get(n1)).toFixed(12);
      if (kind === 'triangle' && !new RegExp(`\\b(?:${n0}${n1}|${n1}${n0})\\s*[:=]|\\bsides?\\b`).test(rest)) {
        rest += ` ${n0}${n1}=${hv}`;
      } else if (['square', 'rhombus', 'regular'].includes(kind) && kw(rest, 'side', 'length', 'radius') === null) {
        rest += ` side ${hv}`;
      } else if (kind === 'rectangle' && kw(rest, 'width', 'length', 'base') === null && !/\bby\b/.test(rest)) {
        rest += ` width ${hv}`;
      } else if (kind === 'parallelogram' && kw(rest, 'base') === null) {
        rest += ` base ${hv}`;
      } else if ((kind === 'trapezoid' || kind === 'trapezium') && kw(rest, 'bottom', 'base') === null) {
        rest += ` bottom ${hv}`;
      }
    }
    let local = shapeLocal(kind, names, rest);
    if (opts.flip) local = local.map(([x, y]) => [x, -y]);
    let origin = [0, 0], theta = 0;
    if (at) {
      const tok = at[1];
      origin = tok.startsWith('(') ? fig.pair(tok.slice(1, -1), tok) : fig.get(tok);
    } else if (fig.pts.has(names[0])) {
      origin = fig.pts.get(names[0]);
      if (fig.pts.has(names[1])) {
        const [x0, y0] = origin, [x1, y1] = fig.pts.get(names[1]);
        theta = Math.atan2(y1 - y0, x1 - x0);
        const built = dist(local[0], local[1]), have = dist(origin, [x1, y1]);
        if (Math.abs(built - have) > 1e-6 * Math.max(1, have)) {
          fail(`${names[0]}${names[1]} is already ${fmtLen(have)} long, but this ${kind} makes it ${fmtLen(built)}`);
        }
      }
    }
    if (rot !== null) theta += rad(rot);
    const ct = Math.cos(theta), st = Math.sin(theta);
    names.forEach((nm, k) => {
      const [x, y] = local[k];
      fig.define(nm, origin[0] + x * ct - y * st, origin[1] + x * st + y * ct);
    });
  }

  /* ---------------------------------------------------------------
   * Parsing
   * ------------------------------------------------------------- */
  function parsePoint(fig, kind, rest, opts) {
    if (kind === 'points') {
      const [names, left] = fig.refs(rest);
      if (left || !names.length) fail('points takes named coordinates: points A(0, 0) B(2, 3)');
      for (const nm of names) {
        if (opts.hidden) fig.hidden.add(nm);
        else {
          fig.show(nm, !opts.nodots);
          fig.declared.add(nm);
        }
      }
      return;
    }
    const m = rest.match(new RegExp(`^(${PNAME})\\s*(.*)$`));
    if (!m) fail('point needs a capital-letter name: point A (2, 3)');
    const name = m[1], how = m[2].trim(), low = how.toLowerCase();
    if (how.startsWith('(')) {
      fig.refs(name + how);
    } else if (low.startsWith('midpoint')) {
      const [ns] = fig.refs(how.replace(/^midpoint\s*(of)?/i, ''));
      if (ns.length !== 2) fail('point M midpoint A B');
      const [ax, ay] = fig.get(ns[0]), [bx, by] = fig.get(ns[1]);
      fig.define(name, (ax + bx) / 2, (ay + by) / 2);
    } else if (low.startsWith('foot')) {
      const [ns] = fig.refs(how.replace(/^foot\s*(of)?/i, ''));
      if (ns.length !== 3) fail('point D foot C A B  (foot of the perpendicular from C to line AB)');
      const [[px, py], [ax, ay], [bx, by]] = ns.map(n => fig.get(n));
      const dx = bx - ax, dy = by - ay;
      const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
      fig.define(name, ax + t * dx, ay + t * dy);
    } else if (low.startsWith('from')) {
      const fm = how.match(new RegExp(`^from\\s*(${PNAME})\\s*(?:distance\\s*)?(${NUMTOK})\\s*` +
                                      `(?:at|angle|direction|heading)?\\s*(${NUMTOK})`, 'i'));
      if (!fm) fail('point P from A 5 at 30  (5 units from A in the 30° direction)');
      const [ax, ay] = fig.get(fm[1]);
      const d = C.constValue(fm[2]), a = rad(cnum(fm[3]));
      fig.define(name, ax + d * Math.cos(a), ay + d * Math.sin(a));
    } else if (low.startsWith('on')) {
      const om = how.match(new RegExp(`^on\\s*(.*?)\\s*(?:at\\s*)?(${NUMTOK})$`, 'i'));
      const ns = om ? fig.refs(om[1])[0] : [];
      if (ns.length !== 2) fail('point P on A B 0.25  (a quarter of the way from A to B)');
      const t = C.constValue(om[2]);
      const [ax, ay] = fig.get(ns[0]), [bx, by] = fig.get(ns[1]);
      fig.define(name, ax + t * (bx - ax), ay + t * (by - ay));
    } else if (low.startsWith('intersect')) {
      const [ns] = fig.refs(how.replace(/^intersect(ion)?\s*(of)?/i, ''));
      if (ns.length !== 4) fail('point X intersect A B C D  (where line AB meets line CD)');
      const [[x1, y1], [x2, y2], [x3, y3], [x4, y4]] = ns.map(n => fig.get(n));
      const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
      if (Math.abs(den) < 1e-12) fail("those lines are parallel — they don't intersect");
      const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
      fig.define(name, x1 + t * (x2 - x1), y1 + t * (y2 - y1));
    } else if (!how) {
      fig.get(name);
    } else {
      fail('point A (2, 3) | point M midpoint A B | point D foot C A B | ' +
           'point P from A 5 at 30 | point P on A B 0.25 | point X intersect A B C D');
    }
    if (opts.hidden) {
      fig.hidden.add(name);
      fig.shown = fig.shown.filter(n => n !== name);
      return;
    }
    fig.show(name, !opts.nodots);
    if (!opts.nodots) fig.declared.add(name);
    if (opts.label) fig.nameText.set(name, opts.label);
    if (opts.nolabel) fig.nolabel.add(name);
  }

  function parseFigureLine(fig, line) {
    const sm = line.match(SETTING_RE);
    if (sm) {
      const key = sm[1].toLowerCase(), val = sm[2].trim();
      if (key === 'size') fig.size = C.parseSize(val, SIZE_IN, '3in');
      else if (key === 'title') fig.title = val;
      else if (key === 'labels') fig.labels = C.onOff(val, 'labels');
      else if (key === 'grid') {
        fig.grid = /^[\d.]+$/.test(val) && !isNaN(parseFloat(val)) ? parseFloat(val)
          : (C.onOff(val, 'grid') ? 1 : null);
      } else fig.rotate = cnum(val);
      return;
    }

    let [body, opts] = C.splitOpts(line, true);
    // 'A = (1, 2)' shorthand for a point
    const pm = body.match(new RegExp(`^(${PNAME})\\s*=\\s*(\\(.*\\))\\s*$`));
    if (pm) body = `point ${pm[1]} ${pm[2]}`;
    const km = body.match(KIND_RE);
    if (!km) {
      fail('expected a setting (size: small) or one of: point, triangle, right triangle, rectangle, ' +
           'square, parallelogram, rhombus, trapezoid, regular, polygon, circle, arc, sector, ' +
           'segment, line, ray, vector, side, angle, right angle, text');
    }
    const kind = km[1].toLowerCase().replace(/\s+/g, ' ');
    let rest = km[2].trim();
    const item = { kind, opts };

    if (kind === 'point' || kind === 'points') {
      parsePoint(fig, kind, rest, opts);
      return;
    }

    if (kind === 'text') {
      const tm = rest.match(new RegExp(`^\\s*(\\([^)]*\\)|${PNAME}(?:\\s*\\([^)]*\\))?)\\s*:?\\s*(.*)$`));
      const [names, txt] = tm ? [fig.refs(tm[1])[0], tm[2]] : [[], ''];
      if (names.length !== 1 || !txt) fail('text needs a position and something to write: text (2, 3) Region $R$');
      fig.get(names[0]);
      Object.assign(item, { at: names[0], text: C.stripChars(txt, '"\'') });
      fig.items.push(item);
      return;
    }

    if (SHAPES.includes(kind)) {
      let names;
      [names, rest] = fig.refs(rest);
      names = [...new Set(names)];  // 'triangle XYZ X(0,0) Y(5,0) Z(1,3)' names each once
      if (['polygon', 'quadrilateral', 'pentagon', 'hexagon'].includes(kind) ||
          (kind === 'triangle' && names.every(nm => fig.pts.has(nm)) && !/=|\bsides?\b/.test(rest))) {
        const need = { quadrilateral: 4, pentagon: 5, hexagon: 6, triangle: 3 }[kind];
        if ((need && names.length !== need) || names.length < 3) {
          fail(`${kind} needs ${need || 'at least 3'} vertices, found ${names.length}`);
        }
        names.forEach(nm => fig.get(nm));
        if (rest) fail(`didn't understand '${rest}'`);
      } else {
        const need = MEASURED_COUNT[kind];
        if (need && names.length !== need) {
          fail(`${kind} needs ${need} vertex names (e.g. ${'ABCD'.slice(0, need)}), found ${names.length}`);
        }
        placeMeasured(fig, kind, names, rest, opts);
      }
      fig.polys.push(names);
      Object.assign(item, { kind: 'poly', names });
      fig.items.push(item);
      names.forEach(nm => fig.show(nm));
      if (opts.lengths) {
        names.forEach((a, k) => fig.items.push({ kind: 'side', p: a, q: names[(k + 1) % names.length],
                                                 text: null, measure: true, opts: {}, auto: true }));
      }
      if (opts.angles) {
        names.forEach(nm => fig.items.push({ kind: 'angle', abc: null, vertex: nm, text: null,
                                             measure: true, opts: {}, auto: true }));
      }
      return;
    }

    if (kind === 'circle' || kind === 'arc' || kind === 'sector') {
      let names;
      [names, rest] = fig.refs(rest);
      if (!names.length) fail(`${kind} needs a center: ${kind} O radius 3  (or ${kind} (0, 0) radius 3)`);
      const c = names[0];
      if (!fig.pts.has(c)) fig.define(c, 0, 0);
      let r = kw(rest, 'radius', 'r');
      const d = kw(rest, 'diameter', 'd');
      if (r === null && d !== null) r = d / 2;
      if (kind === 'circle') {
        const through = names.length === 2 ? names[1] : null;
        if (r === null && through) r = dist(fig.pts.get(c), fig.get(through));
        if (r === null || r <= 0) fail('circle needs a radius: circle O radius 3 (or diameter 6, or circle O through A)');
        Object.assign(item, { center: c, r });
      } else {
        let a0, a1;
        if (names.length === 3) {  // arc O from A to B
          const [cx, cy] = fig.pts.get(c), [ax, ay] = fig.get(names[1]), [bx, by] = fig.get(names[2]);
          r = r || Math.hypot(ax - cx, ay - cy);
          a0 = ang(ax - cx, ay - cy);
          a1 = ang(bx - cx, by - cy);
          if (a1 <= a0) a1 += 360;
        } else {
          const fm = rest.match(new RegExp(`\\bfrom\\s*(${NUMTOK})\\s*(?:to|-)\\s*(${NUMTOK})`));
          if (r === null || !fm) {
            fail(`${kind} needs a radius and angles: ${kind} O radius 3 from 0 to 120 (or ${kind} O from A to B)`);
          }
          a0 = cnum(fm[1]);
          a1 = cnum(fm[2]);
        }
        Object.assign(item, { center: c, r, a0, a1 });
      }
      if (!opts.nocenter) fig.show(c, true);
      fig.items.push(item);
      return;
    }

    if (['segment', 'line', 'ray', 'vector'].includes(kind)) {
      const [names, left] = fig.refs(rest);
      if (names.length !== 2 || left) {
        fail(`${kind} takes two points: ${kind} A B  or  ${kind} (0, 0) to (3, 4)` +
             (left ? ` — didn't understand '${left}'` : ''));
      }
      names.forEach(nm => fig.get(nm));
      Object.assign(item, { p: names[0], q: names[1] });
      fig.items.push(item);
      const dots = kind !== 'vector' && !opts.nodots;
      fig.show(names[0], dots);
      fig.show(names[1], dots && kind !== 'vector');
      if (opts.lengths) {
        fig.items.push({ kind: 'side', p: names[0], q: names[1], text: null, measure: true, opts: {}, auto: true });
      }
      return;
    }

    if (kind === 'side') {
      let [names, txt] = fig.refs(rest);
      if (names.length !== 2) fail('side takes two points: side AB 5  or  side AB $x$ [ticks: 1]');
      names.forEach(nm => fig.get(nm));
      txt = txt.replace(/^[=:]\s*/, '').trim();
      const measure = ['measure', 'length', '?=', 'auto'].includes(txt.toLowerCase());
      Object.assign(item, { p: names[0], q: names[1], measure,
                            text: measure || !txt ? null : C.stripChars(txt, '"\'') });
      fig.items.push(item);
      return;
    }

    // angle / right angle
    let [names, txt] = fig.refs(rest);
    txt = txt.replace(/^[=:]\s*/, '').trim();
    const right = kind === 'right angle' || txt.toLowerCase() === 'right';
    if (txt.toLowerCase() === 'right') txt = '';
    if (names.length === 3) {
      names.forEach(nm => fig.get(nm));
      Object.assign(item, { abc: names, vertex: names[1] });
    } else if (names.length === 1) {
      fig.get(names[0]);
      Object.assign(item, { abc: null, vertex: names[0] });
    } else {
      fail('angle takes three points with the vertex in the middle (angle ABC 40°), ' +
           'or one vertex of a shape (angle B 40°)');
    }
    const measure = ['measure', 'auto', '?='].includes(txt.toLowerCase());
    Object.assign(item, { kind: 'angle', right: right || !!opts.right, measure,
                          text: measure || !txt ? null : C.stripChars(txt, '"\'') });
    fig.items.push(item);
  }

  function parseFigure(lines) {
    const fig = new Figure();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      try {
        parseFigureLine(fig, line);
      } catch (e) {
        if (e instanceof WorksheetError) throw new WorksheetError(`[figure] line '${line}': ${e.message}`);
        throw e;
      }
    }
    return fig;
  }

  /* ---------------------------------------------------------------
   * Rendering
   * ------------------------------------------------------------- */
  const figStyle = (o, color, base = 0.9) => ({
    color, width: { thick: 1.4, thin: 0.55 }[o.weight] || base, style: o.style
  });

  /** Rough [half-width, half-height] of a small label, in pt. */
  function estLabelPt(text) {
    const vis = text.replace(/\\[A-Za-z]+|[{}$^_\\]/g, '');
    const w = 5 * Math.max(1, vis.length) + 2;
    const h = text.includes('\\frac') || text.includes('\\sqrt') ? 12 : 9;
    return [w / 2, h / 2];
  }

  function arcPoints(cx, cy, r, a0, a1) {
    const steps = Math.max(2, Math.ceil(Math.abs(a1 - a0) / 3));
    const pts = [];
    for (let j = 0; j <= steps; j++) {
      const a = rad(a0 + (a1 - a0) * j / steps);
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return pts;
  }

  function render(lines) {
    const fig = parseFigure(lines);
    if (fig.rotate) {
      const th = rad(fig.rotate), ct = Math.cos(th), st = Math.sin(th);
      for (const [k, [x, y]] of fig.pts) fig.pts.set(k, [x * ct - y * st, x * st + y * ct]);
      for (const it of fig.items) if ('a0' in it) { it.a0 += fig.rotate; it.a1 += fig.rotate; }
    }
    const P = name => fig.pts.get(name);

    // ---- bounding box (in figure units) -------------------------------
    const bb = [];
    for (const it of fig.items) {
      const k = it.kind;
      if (k === 'poly') bb.push(...it.names.map(P));
      else if (['segment', 'vector', 'side'].includes(k)) bb.push(P(it.p), P(it.q));
      else if (k === 'line' || k === 'ray') {
        const [ax, ay] = P(it.p), [bx, by] = P(it.q), ext = k === 'line' ? 0.22 : 0.35;
        it.ends = [k === 'line' ? [ax - ext * (bx - ax), ay - ext * (by - ay)] : [ax, ay],
                   [bx + ext * (bx - ax), by + ext * (by - ay)]];
        bb.push(...it.ends);
      } else if (k === 'circle') {
        const [cx, cy] = P(it.center), r = it.r;
        bb.push([cx - r, cy - r], [cx + r, cy + r]);
      } else if (k === 'arc' || k === 'sector') {
        const [cx, cy] = P(it.center), r = it.r;
        const steps = Math.max(8, Math.trunc(Math.abs(it.a1 - it.a0) / 3));
        for (let j = 0; j <= steps; j++) {
          const a = rad(it.a0 + (it.a1 - it.a0) * j / steps);
          bb.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
        }
        if (k === 'sector') bb.push([cx, cy]);
      } else if (k === 'text') bb.push(P(it.at));
    }
    bb.push(...fig.shown.map(P));
    if (!bb.length) fail('[figure] block has nothing to draw');
    let x0 = Math.min(...bb.map(p => p[0])), x1 = Math.max(...bb.map(p => p[0]));
    let y0 = Math.min(...bb.map(p => p[1])), y1 = Math.max(...bb.map(p => p[1]));
    if (fig.grid) {
      const g = fig.grid;
      x0 = Math.floor(x0 / g - 1e-9) * g; y0 = Math.floor(y0 / g - 1e-9) * g;
      x1 = Math.ceil(x1 / g + 1e-9) * g; y1 = Math.ceil(y1 / g + 1e-9) * g;
    }
    let bw = Math.max(x1 - x0, 1e-9), bh = Math.max(y1 - y0, 1e-9);
    if (bw < 1e-6 && bh < 1e-6) bw = bh = 1;
    const s = Math.min(bw > 1e-6 ? fig.size / bw : 1e9, bh > 1e-6 ? fig.size / bh : 1e9);  // in per unit
    const S = s * IN;                                    // px per unit
    const u = pt => pt * PT / S;                         // TeX pt -> figure units
    const X = x => (x - x0) * S, Y = y => (y1 - y) * S;
    const XY = ([x, y]) => [X(x), Y(y)];

    const cv = new C.Canvas();
    const node = (pos, text, color, anchor, sep, bg) => cv.label({
      x: X(pos[0]), y: Y(pos[1]), html: C.inlineFormat(text), anchor, color, sep, bg
    });
    if (fig.grid) {
      const g = fig.grid, nx = Math.round((x1 - x0) / g), ny = Math.round((y1 - y0) / g);
      for (let k = 0; k <= nx; k++) cv.path([XY([x0 + k * g, y0]), XY([x0 + k * g, y1])], { color: '#D6D6D6', width: 0.35 }, 'grid');
      for (let k = 0; k <= ny; k++) cv.path([XY([x0, y0 + k * g]), XY([x1, y0 + k * g])], { color: '#D6D6D6', width: 0.35 }, 'grid');
    }

    // edges for label placement: name -> directions (degrees) to neighbours
    const incident = new Map();
    const addDir = (name, d) => { if (!incident.has(name)) incident.set(name, []); incident.get(name).push(d); };
    const straight = [];      // every drawn straight piece, for points lying in the middle of one
    const sweeps = new Map(); // vertex -> [[start, delta, outer radius]] of its angle marks
    const edges = new Set();
    const circles = [];
    const addEdge = (a, b) => {
      const [ax, ay] = P(a), [bx, by] = P(b);
      straight.push([[ax, ay], [bx, by]]);
      if (ax !== bx || ay !== by) {
        addDir(a, ang(bx - ax, by - ay));
        addDir(b, ang(ax - bx, ay - by));
      }
    };
    const polyPts = fig.polys.flatMap(poly => poly.map(P));
    const centreOf = polyPts.length ? polyPts : bb;
    const figCx = centreOf.reduce((t, p) => t + p[0], 0) / centreOf.length;
    const figCy = centreOf.reduce((t, p) => t + p[1], 0) / centreOf.length;

    for (const it of fig.items) {
      const k = it.kind, o = it.opts, color = o.color || BLACK;
      if (k === 'poly') {
        const ns = it.names, path = ns.map(n => XY(P(n)));
        if (o.shade) cv.path(path, { fill: color, fillOpacity: 0.13, closed: true }, 'fill');
        cv.path(path, Object.assign({ closed: true }, figStyle(o, color)), 'stroke');
        ns.forEach((a, i) => {
          const b = ns[(i + 1) % ns.length];
          addEdge(a, b);
          edges.add(edgeKey(a, b));
        });
        if (o.label) {
          const cx = ns.reduce((t, n) => t + P(n)[0], 0) / ns.length;
          const cy = ns.reduce((t, n) => t + P(n)[1], 0) / ns.length;
          node([cx, cy], o.label, color, 'center');
        }
      } else if (['segment', 'line', 'ray', 'vector'].includes(k)) {
        const a = P(it.p), b = P(it.q);
        if (k === 'segment') cv.path([XY(a), XY(b)], figStyle(o, color), 'stroke');
        else {
          const [e0, e1] = k === 'vector' ? [a, b] : it.ends;
          let s0 = XY(e0), s1 = XY(e1);
          const dx = s1[0] - s0[0], dy = s1[1] - s0[1], L = Math.hypot(dx, dy) || 1;
          const [len, wid] = k === 'vector' ? [6, 4.5] : [5, 4];
          const back1 = cv.arrowHead(s1[0], s1[1], dx, dy, color, len, wid, 'stroke');
          s1 = [s1[0] - dx / L * back1, s1[1] - dy / L * back1];
          if (k === 'line') {
            const back0 = cv.arrowHead(s0[0], s0[1], -dx, -dy, color, len, wid, 'stroke');
            s0 = [s0[0] + dx / L * back0, s0[1] + dy / L * back0];
          }
          cv.path([s0, s1], figStyle(o, color, k === 'vector' ? 1.1 : 0.9), 'stroke');
        }
        addEdge(it.p, it.q);
        edges.add(edgeKey(it.p, it.q));
        const fwd = ang(b[0] - a[0], b[1] - a[1]);
        if (k === 'line' || k === 'ray') addDir(it.q, fwd);
        if (k === 'line') addDir(it.p, fwd + 180);
        if (o.label) {
          fig.items.push({ kind: 'side', p: it.p, q: it.q, text: o.label, measure: false,
                           opts: { color }, auto: true, vec: k === 'vector' });
        }
      } else if (k === 'circle') {
        const c = P(it.center), r = it.r;
        const ring = arcPoints(c[0], c[1], r, 0, 360).map(XY);
        if (o.shade) cv.path(ring, { fill: color, fillOpacity: 0.13, closed: true }, 'fill');
        cv.path(ring, Object.assign({ closed: true }, figStyle(o, color)), 'stroke');
        circles.push([it.center, c, r]);
        if (o.label) {
          const a = rad(45);
          node([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)], o.label, color, 'south west', 1.5);
        }
      } else if (k === 'arc' || k === 'sector') {
        const [cx, cy] = P(it.center), r = it.r, { a0, a1 } = it;
        const arc = arcPoints(cx, cy, r, a0, a1);
        if (k === 'sector') {
          const path = [[cx, cy], ...arc].map(XY);
          if (o.shade !== false) cv.path(path, { fill: color, fillOpacity: 0.13, closed: true }, 'fill');
          cv.path(path, Object.assign({ closed: true }, figStyle(o, color)), 'stroke');
          for (const e of [arc[0], arc[arc.length - 1]]) addDir(it.center, ang(e[0] - cx, e[1] - cy));
        } else {
          cv.path(arc.map(XY), figStyle(o, color), 'stroke');
        }
        circles.push([it.center, [cx, cy], r]);
        if (o.label) {
          const am = rad((a0 + a1) / 2);
          node([cx + (r + u(3)) * Math.cos(am), cy + (r + u(3)) * Math.sin(am)], o.label, color,
               (a0 + a1) / 2 + 180, 1.5);
        }
      } else if (k === 'text') {
        node(P(it.at), it.text, color, 'center');
      }
    }

    // ---- side annotations: ticks, parallel arrows, length / name labels
    const explicitSides = new Set(fig.items.filter(it => it.kind === 'side' && !it.auto)
      .map(it => edgeKey(it.p, it.q)));
    const mark = (pts, color, width) => cv.path(pts.map(XY), { color, width }, 'mark');
    for (const it of fig.items) {
      if (it.kind !== 'side') continue;
      const key = edgeKey(it.p, it.q);
      if (it.auto && it.measure && explicitSides.has(key)) continue;
      const o = it.opts, color = o.color || BLACK;
      const [ax, ay] = P(it.p), [bx, by] = P(it.q);
      const L = Math.hypot(bx - ax, by - ay);
      if (L < 1e-12) fail(`side ${it.p}${it.q}: the two points are the same`);
      if (!edges.has(key) && !it.auto) {
        cv.path([XY([ax, ay]), XY([bx, by])], figStyle(o, color), 'stroke');
        edges.add(key);
        addEdge(it.p, it.q);
      }
      const dx = (bx - ax) / L, dy = (by - ay) / L, mx = (ax + bx) / 2, my = (ay + by) / 2;
      let nx = -dy, ny = dx;
      // outward = away from the polygon that owns this edge (else the figure centre)
      const owner = fig.polys.find(poly => poly.some((p1, i) => edgeKey(p1, poly[(i + 1) % poly.length]) === key));
      if (owner) {
        // true outward normal (concave shapes too): the right-hand normal of
        // the edge as traversed counterclockwise
        const ring = owner.map((p, i) => [p, owner[(i + 1) % owner.length]]);
        const [p1, p2] = ring.find(e => edgeKey(e[0], e[1]) === key);
        const area = ring.reduce((t, [p, q]) => t + P(p)[0] * P(q)[1] - P(q)[0] * P(p)[1], 0);
        const ex = P(p2)[0] - P(p1)[0], ey = P(p2)[1] - P(p1)[1], el = Math.hypot(ex, ey);
        [nx, ny] = area > 0 ? [ey / el, -ex / el] : [-ey / el, ex / el];
      } else {
        const side = (mx - figCx) * nx + (my - figCy) * ny;
        if (side < -1e-9 || (Math.abs(side) <= 1e-9 && ny < 0)) { nx = -nx; ny = -ny; }
      }
      if (it.vec && !o.flip) [nx, ny] = [-dy, dx];  // vector names sit on the left of the arrow
      if (o.flip) { nx = -nx; ny = -ny; }
      const nt = o.ticks || 0, npar = o.parallel || 0;
      for (let i = 0; i < nt; i++) {
        const off = (i - (nt - 1) / 2) * u(2.6), tx = mx + dx * off, ty = my + dy * off;
        mark([[tx - nx * u(3.8), ty - ny * u(3.8)], [tx + nx * u(3.8), ty + ny * u(3.8)]], color, 0.7);
      }
      if (npar) {
        const shift = nt ? u(5 + 2.6 * nt) : 0;
        for (let i = 0; i < npar; i++) {
          const off = shift + (i - (npar - 1) / 2) * u(3.2) + u(1.8);
          const tx = mx + dx * off, ty = my + dy * off, bxp = tx - dx * u(3.6), byp = ty - dy * u(3.6);
          mark([[bxp + nx * u(2.6), byp + ny * u(2.6)], [tx, ty], [bxp - nx * u(2.6), byp - ny * u(2.6)]], color, 0.7);
        }
      }
      const text = it.measure ? fmtLen(L) : it.text;
      if (text) {
        const gap = u(3.5 + (nt ? 3.8 : 0) + (npar && !nt ? 2.6 : 0));
        node([mx + nx * gap, my + ny * gap], text, color, ang(nx, ny) + 180, 1.2, 0.85);
      }
    }

    // ---- angle annotations: arcs, right-angle squares, measures --------
    for (const it of fig.items) {
      if (it.kind !== 'angle') continue;
      const o = it.opts, color = o.color || BLACK, B = it.vertex;
      let A, Cn, start, delta;
      if (it.abc) {
        [A, , Cn] = it.abc;
        const [bx, by] = P(B), [ax, ay] = P(A), [cx, cy] = P(Cn);
        const a1 = ang(ax - bx, ay - by), a2 = ang(cx - bx, cy - by);
        start = a1;
        delta = mod(a2 - a1, 360);
        if (delta > 180) { start = a2; delta = 360 - delta; }
        if (o.reflex) { start = mod(start + delta, 360); delta = 360 - delta; }
      } else {
        const poly = fig.polys.find(pl => pl.includes(B));
        if (!poly) {
          fail(`angle ${B}: ${B} isn't a vertex of any shape — name all three points instead (angle A${B}C)`);
        }
        const i = poly.indexOf(B);
        A = poly[(i - 1 + poly.length) % poly.length];
        Cn = poly[(i + 1) % poly.length];
        const [bx, by] = P(B), [ax, ay] = P(A), [cx, cy] = P(Cn);
        const area = poly.reduce((t, p, j) => {
          const q = poly[(j + 1) % poly.length];
          return t + P(p)[0] * P(q)[1] - P(q)[0] * P(p)[1];
        }, 0);
        const aPrev = ang(ax - bx, ay - by), aNext = ang(cx - bx, cy - by);
        if (area > 0) { start = aNext; delta = mod(aPrev - aNext, 360); }  // counterclockwise
        else { start = aPrev; delta = mod(aNext - aPrev, 360); }
      }
      const [bx, by] = P(B);
      const la = dist(P(A), [bx, by]), lc = dist(P(Cn), [bx, by]);
      if (Math.min(la, lc) < 1e-12) fail(`angle at ${B}: one of its sides has zero length`);
      const short = Math.min(la, lc), right = it.right;
      const narcs = o.arcs !== undefined ? o.arcs : (right ? 0 : 1);
      const r = Math.min(u(narcs <= 1 ? 12 : 10), 0.38 * short);
      let rOut = r;
      if (right) {
        const sq = Math.min(u(7.5), 0.3 * short);
        const e1 = [Math.cos(rad(start)), Math.sin(rad(start))];
        const e2 = [Math.cos(rad(start + delta)), Math.sin(rad(start + delta))];
        mark([[bx + e1[0] * sq, by + e1[1] * sq], [bx + (e1[0] + e2[0]) * sq, by + (e1[1] + e2[1]) * sq],
              [bx + e2[0] * sq, by + e2[1] * sq]], color, 0.65);
        rOut = sq * 1.42;
      }
      for (let j = 0; j < narcs; j++) {
        const rj = r + j * u(2.4);
        mark(arcPoints(bx, by, rj, start, start + delta), color, 0.65);
        rOut = Math.max(rOut, rj);
      }
      const text = it.measure ? fmtDeg(delta) : it.text;
      if (text) {
        const [hw, hh] = estLabelPt(text);
        const half = rad(Math.min(delta, 180) / 2);
        const need = u(Math.max(hw, hh) + 1) / Math.max(Math.tan(half), 0.05);
        const d = Math.max(rOut + u(2.5), Math.min(need, u(42)));
        const bis = rad(start + delta / 2);
        node([bx + d * Math.cos(bis), by + d * Math.sin(bis)], text, color, start + delta / 2 + 180, 1, 0.85);
      }
      if (text || narcs || right) {
        if (!sweeps.has(B)) sweeps.set(B, []);
        sweeps.get(B).push([start, delta, rOut]);
        // the vertex name must stay clear of the whole marked angle
        const steps = Math.max(1, Math.ceil(delta / 30));
        for (let j = 0; j <= steps; j++) addDir(B, start + delta * j / steps);
      }
    }

    // ---- point dots and names ------------------------------------------
    for (const name of fig.shown) {
      if (fig.hidden.has(name)) continue;
      const [px, py] = P(name);
      const corner = fig.polys.some(poly => poly.includes(name));
      if (fig.dot.has(name) && (!corner || fig.declared.has(name))) {  // no dots on shape corners
        const [qx, qy] = XY([px, py]);
        cv.dot(qx, qy, BLACK, 1.7, false, 'dot');
      }
      if (!fig.labels || fig.nolabel.has(name)) continue;
      const dirs = (incident.get(name) || []).slice();
      for (const [cname, [cx, cy], r] of circles) {  // a point on a circle: label outside it
        if (cname !== name && Math.abs(Math.hypot(px - cx, py - cy) - r) < 1e-6 * Math.max(1, r)) {
          dirs.push(ang(cx - px, cy - py));
        }
      }
      for (const [[ax, ay], [bx, by]] of straight) {  // a point partway along a drawn line
        const L2 = (bx - ax) ** 2 + (by - ay) ** 2;
        if (L2 < 1e-18) continue;
        const t = ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / L2;
        if (t > 1e-6 && t < 1 - 1e-6 &&
            Math.abs((px - ax) * (by - ay) - (py - ay) * (bx - ax)) / Math.sqrt(L2) < 1e-6) {
          dirs.push(ang(bx - ax, by - ay), ang(ax - bx, ay - by));
        }
      }
      const ds = [...new Set(dirs.map(d => mod(Number(mod(d, 360).toFixed(6)), 360)))].sort((a, b) => a - b);
      let best;
      if (!ds.length) {
        const vx = px - figCx, vy = py - figCy;
        best = Math.hypot(vx, vy) > 1e-9 ? ang(vx, vy) : 45;
      } else if (ds.length === 1) {
        best = ds[0] + 180;
      } else {  // the middle of the widest empty wedge around the point
        let gap = -1, a = 0;
        ds.forEach((d, i) => {
          const g = mod(ds[(i + 1) % ds.length] - d, 360);
          if (g > gap || (g === gap && d > a)) { gap = g; a = d; }
        });
        best = a + gap / 2;
      }
      best = mod(best, 360);
      let off = u(fig.dot.has(name) ? 2.2 : 1.6);
      for (const [st0, dl, ro] of sweeps.get(name) || []) {  // boxed in by an angle mark: go past it
        if (mod(best - st0, 360) <= dl) off = Math.max(off, ro + u(1.5));
      }
      const text = fig.nameText.get(name) || nameTex(name);
      node([px + off * Math.cos(rad(best)), py + off * Math.sin(rad(best))], text, BLACK, best + 180, 1.4);
    }

    if (fig.title) {
      cv.label({ x: 0, y: 0, html: C.inlineFormat(fig.title), anchor: 'south', bold: true,
                 color: C.COLORS.navy, sep: 0, dy: 7, rel: 'title' });
    }
    // an empty drawing still spans its bounding box
    cv.grow(X(x0), Y(y0));
    cv.grow(X(x1), Y(y1));
    const body = ['grid', 'fill', 'stroke', 'mark', 'dot'].map(l => cv.body(l)).join('');
    return cv.html('ws-figure', [body, '']);
  }

  return { render, parseFigure };
})();
