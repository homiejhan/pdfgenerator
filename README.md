# Worksheet Studio

A fully offline, single-purpose web app that turns plain text — the kind you'd
paste straight out of a Claude (or any LLM) response — into a typeset,
paginated PDF worksheet with an answer key. Beyond text and math, the same
plain-text format describes coordinate-plane graphs, to-scale geometry
figures, tables, and compact grid/column layouts for drill problems. No
server, no build step, no account. Open `index.html` and it works, on a plane
if need be.

The text format is shared with the **worksheet-studio-pdf** skill (which
compiles the same source through LaTeX): anything written for one renders on
the other.

Paste problems on the left, click **Generate worksheet**, get a live paginated
preview on the right, click **Download PDF**. If a graph, figure, table, or
layout line can't be read, the status line names the line and says what was
expected.

---

## Why this exists

Writing practice problems is easy to do well in a chat with an LLM. Turning
that output into something a student can print and write on is normally its
own chore — copy into Word, fix the math formatting, fix the page breaks,
make an answer key. This app removes that step: the text format below *is*
the worksheet.

## How it works (no network required)

Everything runs client-side in the browser:

- **Parsing** — your pasted text is parsed into a title, subtitle, numbered
  problems, and an optional answer key.
- **Typesetting** — math between `$...$` is rendered with
  [KaTeX](https://katex.org/) (fonts included locally).
- **Graphs and figures** — `[graph]` and `[figure]` blocks are computed in
  JavaScript (function sampling with asymptote/jump detection, a triangle
  solver, geometric constructions) and drawn as SVG, with KaTeX-typeset
  labels anchored around the drawing.
- **Pagination** — each problem's real rendered height is measured, then
  problems are packed onto fixed US-Letter pages without ever splitting one
  across a page break. The answer key always starts on a fresh page.
- **Export** — the visible pages are rendered to a PDF with
  [html2canvas](https://html2canvas.hertzen.com/) and
  [jsPDF](https://github.com/parallax/jsPDF), one page per image, at full
  print resolution.

No data leaves your machine. No CDN calls, no analytics, no accounts.

## Project structure

```
studio-app/
├── index.html            entry point — open this in a browser
├── css/
│   ├── styles.css         all UI and worksheet/page presentation
│   ├── katex.min.css      math typesetting styles
│   └── fonts/              KaTeX math fonts (woff2, embedded locally)
└── js/
    ├── core.js             shared helpers: inline math/markdown, the graph
    │                       expression compiler, picture (SVG + label) layout
    ├── graph.js            [graph] blocks: coordinate planes
    ├── figure.js           [figure] blocks: to-scale geometry diagrams
    ├── app.js              the application: Model / View / Controller
    └── vendor/             katex.min.js, html2canvas.min.js, jspdf.umd.min.js
```

`js/app.js` is organized as three clearly labeled sections:

| Layer | Responsibility |
|---|---|
| **Model** | Parses source text into `{ title, subtitle, problems[], answers[] }`, including which `[grid]` / `[columns]` layout each problem sits in. Pure logic, no DOM. |
| **View** | Converts parsed data into typeset blocks (paragraphs, parts, tables, graphs, figures, compact layouts), paginates them onto letter-size pages, scales the preview, and renders the PDF. |
| **Controller** | Wires the Generate/Download buttons and resize events to the Model and View, and reports input errors. |

`js/graph.js` and `js/figure.js` each parse one block's lines and return the
picture; `js/core.js` lays pictures out once they are in the page (anchoring
labels, shrinking anything wider than its column).

## Running it

Double-click `index.html`, or serve the folder with any static file server.
There is nothing to install and nothing to build.

## Install on iPhone (offline home-screen app)

The app is a PWA: it ships a `manifest.webmanifest` and a service worker
(`sw.js`) that precaches every file on first visit, so once added to your
home screen it opens and works with **no internet connection at all**.

1. Host the folder over HTTPS — GitHub Pages works out of the box
   (Settings → Pages → deploy from branch). Service workers require HTTPS;
   this is a browser rule, not an app choice.
2. Open the page once in Safari on your iPhone. The service worker installs
   and caches all 35 app files (~1.3 MB) in the background.
3. Tap **Share → Add to Home Screen**.
4. From then on the icon launches the full app instantly, online or offline —
   airplane mode included. Nothing is re-downloaded unless the app is updated.

When you update the code, bump `CACHE_VERSION` at the top of `sw.js` (e.g.
`v1` → `v2`) so returning devices fetch the new files; old caches are
cleaned up automatically. If you add or remove files, add or remove them
from the `ASSETS` list in `sw.js` as well.

---

## Input format specification

This is the part an AI (or a person) needs in order to generate a worksheet
that parses correctly on the first try. The rules below are exhaustive —
they describe the actual parsing logic, not an approximation of it.

### Overall shape

```
<Title>
<Subtitle — optional>

Problem 1. <problem text, may span multiple lines>

Problem 2. <problem text>
(a) <part text>
(b) <part text>

*Problem 3. <starred / challenge problem>

Answer Key
1. <answer text>
2. <answer text>
```

### Rules, one at a time

**1. The first non-blank line is always the title.**
The second non-blank line, if there is one *before* any problem marker, is
the subtitle. Both are optional in the sense that a title is auto-supplied
("Worksheet") if omitted, but if you want a title, put it first.

**2. A problem starts with a numbered marker at the start of a line.**
Accepted marker forms (case-insensitive), matched against the start of the
line:

```
Problem 1.      Problem 1)      Problem 1:
Question 1.
Q1.
#1.
1.
1)
1:
```

Concretely, the pattern is: an optional leading `*` (see below), an optional
word (`Problem`, `Question`, `Q`, or `#`), then digits, then one of `.` `)`
`:`, then the rest of the line is the start of the problem's body.

Use **one consistent style per worksheet** — you don't need to match the
example above exactly, but pick one form (e.g. always `Problem N.`) and use
it throughout. Numbers should be sequential starting at 1.

**3. A leading `*` (or `★`) marks a starred / challenge problem.**
It must come before the marker: `*Problem 5.` or `*5.` Rendered with a star
icon next to the problem number.

**4. Everything after a problem marker, up to the next marker, is that
problem's body.** This can span multiple lines and multiple paragraphs
(separate paragraphs with a blank line).

**5. Lettered sub-parts use `(a)`, `(b)`, etc. — parentheses required,
letters a–h, followed by `.` or `)` and a space.** Lettering continues if a
graph, figure, or table interrupts the list.

```
Problem 3. A rectangle has area 48 and length 2 more than its width.
(a) Write an equation that models this situation.
(b) Find the dimensions.
```

These render as an indented `(a) / (b)` list under the problem. Don't use
lettered parts for anything other than genuine sub-questions of a single
problem.

**6. Multiple-choice options are just plain lines, separated from the
problem stem and from each other by a blank line** — they are *not* a
special syntax, they're ordinary paragraphs:

```
Problem 1. Solve for $x$: $x^2 - 5x + 6 = 0$.

A) $x = 2$ or $x = 3$

B) $x = -2$ or $x = -3$

C) $x = 6$

D) $x = -6$
```

Each becomes its own paragraph on the page. Do not run all four choices
together on one line — they won't separate correctly.

**7. A line matching "Answer Key", "Answers", or "Solutions" (optionally
followed by `:`) switches parsing into answer-key mode.** Everything after
it is parsed the same way (numbered items, same marker rules) but rendered
as a boxed answer key on its own page instead of as worksheet problems.

```
Answer Key
1. $x = 2, 3$
2. $x = 3$
```

Answer numbers should match problem numbers; they don't need to be in
order (they get sorted), but every number should correspond to a real
problem above it. The answer key section is optional — omit it entirely for
a worksheet with no key.

### Math formatting

**Math goes between single dollar signs: `$x^2 + 1$`.** Standard LaTeX math
syntax works (KaTeX's supported subset): `\frac{a}{b}`, `\sqrt{x}`, `x^2`,
`x_1`, Greek letters (`\pi`, `\theta`), `\le \ge \ne`, `\times`, `\cdot`,
`\in`, `\{ \}` (escape braces used as literal set delimiters), etc.

**Use `$$...$$` for a standalone displayed equation on its own line**, e.g. a
centered equation above a question:

```
$$\frac{x^2}{\sqrt{x^2 - c^2}} = \frac{c^2}{\sqrt{x^2 - c^2}} + 39$$
```

**Currency dollar signs MUST be escaped as `\$`, never a bare `$`.**
This is the single most important rule and the most common source of
broken output. A bare, unescaped `$` is *always* treated as the start or
end of a math span, with no exceptions for "obviously currency" contexts.
If a line contains a currency amount and separate math expressions, an
unescaped `$` will desynchronize the pairing for the rest of the line.

```
WRONG:  A kayak rental costs $12 deposit plus $8 per hour. If h is
        hours, which equation models the cost c(h)?

RIGHT:  A kayak rental costs \$12 deposit plus \$8 per hour. If $h$ is
        hours, which equation models the cost $c(h)$?
```

The renderer treats `\$` as an escaped literal dollar sign and restores it
in the final output without ever letting it participate in math-span
pairing — so mixing currency and math freely on the same line is safe as
long as every currency `$` is backslash-escaped.

A degree sign `°` can be typed directly, in text or inside `$...$`.

### Light text formatting

- `**bold**` → **bold**
- `*italic*` → *italic* (single asterisks; don't nest with bold)
- A bold or italic span **may enclose inline math**:
  `**Step 2: Compute $b^2$.**` renders the whole label bold with the math
  intact.
- Inside `$...$`, use LaTeX commands (`\textbf{}`, `\textit{}`) if you need
  emphasis in math mode, though this is rarely needed.

### Graphs (`[graph] ... [/graph]`)

A coordinate plane, placed inside a problem, a sub-part, or an answer-key
entry. The `[graph]` and `[/graph]` tags go on their own lines. Inside:
optional settings, then one item per line, in any order. An empty block is a
blank grid for students.

```
[graph]
x: -5 to 5
y: -5 to 5
y = 2x - 3 [label: $f$]
g(x) = -x^2 + 4 [red, dashed]
point A (1, -1)
[/graph]
```

**Settings** (`key: value`, all optional):

- `x: -5 to 5`, `y: 0 to 350` — window. Default `-10 to 10` on both. Also
  accepts `-5..5`, `[0, 10]`, `-2pi to 2pi`.
- `step: 1`, `xstep: 2`, `ystep: 50` — grid spacing. Automatic by default:
  one line per unit for integer windows 4–24 wide, π-fractions when the bounds
  are π multiples, otherwise a round number. Tick numbers are thinned only as
  much as needed to avoid overlap.
- `grid: off`, `numbers: off` — hide grid lines / tick numbers.
- `xlabel: Hours worked`, `ylabel: Cost (\$)` — default `$x$` / `$y$`;
  `none` hides. Short labels sit at the arrow tips; long labels on a
  first-quadrant graph sit centered along the axes.
- `size: small | medium | large` (1.7 / 3.0 / 4.2 in wide) or e.g. `3.5in`.
  Default medium. Height keeps equal units when the window is roughly square.
- `title: A)` — bold caption above the graph.

**Items** (one per line):

- `y = 2x - 3` or `f(x) = x^2 - 4` — plot a function of x.
- `y > -1/2 x + 1` (also `<`, `<=`, `>=`, `≤`, `≥`, `\le`, `\ge`) — shaded
  inequality; `<`/`>` draw a dashed boundary, `<=`/`>=` a solid one.
- `... for -3 <= x < 1` — restrict the domain. Endpoint dots are automatic:
  closed for `<=`, open for `<`. Consecutive restricted pieces share one color
  (= one piecewise function). One-sided works too: `for x >= 0`.
- `x = 2`, `x < -1` — vertical line / shaded half-plane.
- `point (1, 3)`, `point A (1, 3)` (labeled *A*), `open point (2, 1)`,
  `points (0, 1) (1, 3) (2, 5)` (scatter, no labels).
- `segment P(0, 0) to Q(3, 4)` — endpoint dots, names labeled.
- `vector (0, 0) to (3, 2)` — an arrow from the first point to the second.
- `line (0, 1) (2, 5)` — infinite line through two points.
- `polygon A(1, 1) B(4, 1) C(4, 3)` — lightly filled; named vertices labeled.
- `circle (0, 0) radius 3`
- `text (4, 5) Region $R$` — free text at a point.

**Options** go in a bracket at the end of an item line:
`[red, dashed, label: $f(x)$]`. Colors: `navy blue red green orange purple
gold gray black`; styles: `dashed dotted solid`, `thick thin`; `noshade`
(inequality/polygon without fill); `label: ...` (text or `$math$`, placed
automatically clear of dots and axes). Without a color, curves cycle
navy → red → green → orange → purple; points and text are black.

**Expressions** (right side of `y =`, and any number in a coordinate,
window, or step): implicit multiplication (`2x`, `3(x+1)`, `(x+1)(x-2)`),
`^` powers, `|x - 2|`, `sqrt() cbrt() abs() sin() cos() tan() sec() csc()
cot() arcsin() arccos() arctan() ln() log()` (log = base 10) `exp() floor()
ceil()`, constants `pi` and `e`, and LaTeX forms `\frac{1}{2}x`, `\sqrt{x}`,
`\sqrt[3]{x}`, `\cdot`, `\pi`. Functions need parentheses unless the argument
is a single number or `x` (`sin x` is fine). The variable must be `x`.
Undefined points leave gaps; asymptotes and jumps are detected, so `1/(x-1)`
and `tan x` draw correctly. Note `x^(1/3)` is undefined for negative x — use
`cbrt(x)` or `\sqrt[3]{x}` for a cube root.

**Layout:** graph and figure blocks separated only by blank lines sit side by
side and wrap. Three `size: small` graphs fit per row — the pattern for
"Which graph shows ...?" multiple choice (`title: A)`, `title: B)`, ...).

### Geometry figures (`[figure] ... [/figure]`)

A to-scale geometry diagram with no axes. Same placement rules as `[graph]`.
Every point is computed exactly, then the whole figure is scaled uniformly to
fit `size`, so angles and proportions are true. Lines are read top to bottom;
a point must exist before a later line uses it.

```
[figure]
triangle ABC AB=8 angle A=50 angle B=60
side AB 8 cm
side BC $x$ [ticks: 1]
angle A 50°
angle C measure
[/figure]
```

**Settings:** `size: small | medium | large` (1.6 / 2.5 / 3.5 in for the
larger of width/height) or `3in`; `title: A)`; `labels: off` (hide vertex
names); `grid: on` or `grid: 2` (graph-paper grid, step in figure units);
`rotate: 20` (turn the whole figure counterclockwise, degrees).

**Point names** are a capital letter plus optional digits/primes: `A`, `B'`,
`P1` (renders P₁). Names can run together: `ABC` = A, B, C. `A(2, 3)` gives
coordinates. A name has one position for the whole figure: shapes may share a
point, but giving an existing name a different position is an error.

**Shapes from coordinates:** `triangle A(0,0) B(6,0) C(2,4)`,
`polygon A(0,0) B(4,0) C(5,3) D(1,3)` (also `quadrilateral`, `pentagon`,
`hexagon`), or `polygon ABCD` with already-defined points.

**Shapes from measurements** — first vertex at the origin (or `at (x, y)` /
`at P`), first side along the +x axis, the rest counterclockwise above it:

- `triangle ABC AB=5 BC=6 CA=7` (SSS) · `triangle ABC AB=5 AC=7 angle A=40`
  (SAS) · `triangle ABC AB=8 angle A=30 angle B=70` (ASA/AAS) ·
  `triangle ABC sides 5 6 7`. Impossible input (triangle inequality, angles
  summing to 180° or more) is an error. SSA takes the acute solution. Angles
  may be written `angle A=40`, `∠A=40`, `m∠A = 40°`.
- `right triangle ABC legs 3 4` — right angle at B.
- `rectangle ABCD width 6 height 4` (or `6 by 4`) · `square ABCD side 4`
- `parallelogram ABCD base 7 side 4 angle 65` (`height 3` may replace
  `side`) · `rhombus ABCD side 5 angle 60`
- `trapezoid ABCD bottom 10 top 6 height 4` — isosceles by default;
  `offset 0` makes a right trapezoid.
- `regular ABCDEF side 3` (or `radius 2`) — n = number of vertex names.
- If the first two vertices already exist, the shape is built on that
  segment: `triangle ABC AB=4 BC=3 CA=4.5` then `square BAED` puts a square
  on side AB, away from C (`[flip]` switches sides).
- Per-shape keywords: `at (x, y)` / `at P`, `rotate 30`.

**Points and constructions:** `point A (2, 3)` · `A = (2, 3)` ·
`points A(0,0) B(4,1)` · `point M midpoint A B` · `point D foot C A B`
(foot of the perpendicular from C to line AB) · `point P from A 5 at 30` ·
`point P on A B 0.25` · `point X intersect A B C D`. `[hidden]` defines a
point without drawing it; `[nolabel]` draws the dot without the name;
`[label: $A(2,3)$]` replaces the name text.

**Lines and curves:** `segment A B` · `line A B` (arrows both ways) ·
`ray A B` · `vector A B` or `vector (0, 0) to (3, 2)` · `circle O radius 3`
(or `diameter 6`, or `circle O through A`) · `arc O radius 3 from 0 to 120`
or `arc O from A to B` · `sector O radius 4 from 30 to 100` ·
`text (2, 3) Region $R$`.

**Side annotations** — `side AB <label> [options]`: `side AB 5`,
`side AB $x + 2$`, `side AB measure` (prints the true length: `5`, `4.5`,
`√34`, `3√2`). Labels go outside the shape automatically; `[flip]` moves a
label to the other side. `[ticks: 1|2|3]` congruence marks, `[parallel: 1|2]`
parallel arrows.

**Angle annotations** — `angle ABC <label> [options]` (vertex in the middle)
or `angle B <label>` when B is a corner of a shape: `angle ABC 40°`,
`angle B $x^\circ$`, `angle C measure`, or `angle B` alone for an unlabeled
arc. `right angle ABC` draws the square corner mark. `[arcs: 2|3]` congruent-
angle arcs (`noarc` = label only), `[reflex]` marks the outside angle.

**Options:** the `[graph]` colors (default black), `dashed`, `dotted`,
`thick`, `thin`, `fill` (light tint inside a polygon/circle), `flip`,
`lengths` / `angles` on a shape (label every side / interior angle with its
computed value — handy in answer keys), `nodots`, `hidden`, `nolabel`,
`label: ...`.

Build shapes from the problem's actual numbers so the picture is honest, and
keep `measure` / `lengths` / `angles` for the answer key so the figure
doesn't give the answer away. Inside `[columns]` or `[grid]` cells, use
`size: small` (anything too wide shrinks to fit).

### Tables (`| pipe |` rows)

Consecutive lines starting with `|` form a table; a blank line ends it.

```
| Months ($m$) | Cost ($C$) |
|:------------:|-----------:|
| 1            | \$40       |
| 3            |            |
```

- A second row of dashes makes row 1 a shaded header and sets each column's
  alignment: `:---` left, `:---:` center, `---:` right (default center).
  Without a dash row there's no header — use that for horizontal tables of
  values like `| $x$ | $-1$ | $0$ | $1$ |` / `| $y$ | | | |`.
- Cells take everything a normal line does: `$math$`, `**bold**`, `\$`. A
  pipe inside math is fine (`$|x|$`); a literal pipe in text is `\|`.
- Empty body cells are widened as student write-in space.
- Long text columns wrap to the page width; small tables shrink to fit a
  narrow column or grid cell.
- Tables work in problems, between sub-parts, and in the answer key.

### Compact layouts (`[grid N]` and `[columns N]`)

For short problems that would waste space as full-width "Problem N." blocks.
Put a layout tag on its own line before the problems and a closing tag after
them. Problems inside use the normal markers but render with a compact
inline number ("**1.** $2x+3=11$"), and inline math is display-size there.

```
[grid 4]
1. $x + 7 = 12$
2. $3x = 21$
...
16. $0.5x + 1.5 = 4$
[/grid]

[columns 2]
17. Solve for $y$: $2x + 3y = 12$.
18. Solve and check: $5(x - 1) = 3x + 7$.
[/columns]
```

- `[grid N]` (N = 1–4) — a boxed table read left to right, N cells per row.
  A row never splits across a page. Options after the number: `plain` (no
  borders), `space: none|compact|standard|large` (workspace in each cell;
  default = the Workspace dropdown). Example: `[grid 4, space: compact]`.
- `[columns N]` (N = 1–4) — problems flow top-to-bottom down N newspaper
  columns with a light rule between them, filling each page and balancing the
  last one; each problem stays in one piece. Options: `norule`, `space: ...`.
- More than 4 columns is an error. `[columns 1]` returns to normal layout.
- The closing tag is optional: a layout runs until `[/grid]` / `[/columns]`,
  the next layout tag, or the Answer Key. A tag right after the
  title/subtitle lays out the whole worksheet that way.
- **Answer key:** answers to problems that sat in a grid/columns block are
  packed N across automatically. Answers can also be wrapped in their own
  `[grid N]` / `[columns N]` block.

### What NOT to do

- Don't put more than one problem number on a line.
- Don't use unescaped `$` for currency, ever — see above.
- Don't leave a `$...$` or `$$...$$` span unclosed — every opening `$` needs
  a matching closing `$` *on the same line* (math spans do not cross line
  breaks).
- Don't use lettered markers `(a)` for anything except real sub-parts of the
  immediately preceding problem.
- Don't number answer key items to reference a problem number that doesn't
  exist above it.
- Don't leave a `[graph]` or `[figure]` block without its closing tag.

### Minimal worked example

```
Algebra 1A CBE Review
15 Practice Questions

Problem 1. Solve the following equation.
$$-3(x + 4) - 2x = 2x + 9$$

A) $-3$

B) $3$

C) $-\frac{21}{9}$

D) $21$

Problem 2. A parking garage charges \$6 for each hour parked, up to a
maximum of 8 hours per day. If $n$ is the number of whole hours parked
($n = 1, 2, \dots, 8$) and $c(n)$ is the total cost, what is the range of
this function?

A) All real numbers

B) $c > 0$

C) $c \ge 6$

D) $c \in \{6, 12, 18, 24, 30, 36, 42, 48\}$

Answer Key
1. A — distribute and combine like terms: $-5x - 12 = 2x + 9 \Rightarrow x = -3$.
2. D — cost is $c(n) = 6n$ for integer $n$ from 1 to 8, giving a discrete set.
```

This parses into a two-question worksheet with a boxed answer key on page 2,
with full explanations preserved in the key.

---

## Customization

- **Workspace** dropdown controls blank space left under each problem
  (None / Compact / Standard / Large) — useful for handwritten work vs. a
  quick answer-only review sheet. The same four amounts apply inside
  `[grid]` / `[columns]` cells (overridable per block with `space: ...`); the
  pixel values are `SPACING_PX` in `js/app.js`.
- Colors, fonts, and page dimensions live in `css/styles.css` under CSS
  custom properties at the top of the file (`--ink`, `--desk`, etc.) and the
  `.page` / `PAGE_W` / `PAGE_H` constants in `js/app.js`'s View layer.

## Known limitations

- PDF text is not selectable — pages are exported as high-resolution raster
  images, not vector text. This keeps the app fully self-contained without a
  LaTeX toolchain, at the cost of text searchability.
- Math support is whatever KaTeX supports — this covers the large majority
  of high-school and early-college notation but not every LaTeX package or
  command.
- Graph and figure label placement follows the worksheet-studio-pdf skill's
  rules exactly, but labels are measured in the browser's fonts, so spacing
  can differ by a pixel or two from the LaTeX output.
