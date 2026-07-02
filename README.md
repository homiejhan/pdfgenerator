# Worksheet Studio

A fully offline, single-purpose web app that turns plain text — the kind you'd
paste straight out of a Claude (or any LLM) response — into a typeset,
paginated PDF worksheet with an answer key. No server, no build step, no
account. Open `index.html` and it works, on a plane if need be.

Paste problems on the left, click **Generate worksheet**, get a live paginated
preview on the right, click **Download PDF**.

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
    ├── app.js              the entire application: Model / View / Controller
    └── vendor/             katex.min.js, html2canvas.min.js, jspdf.umd.min.js
```

`js/app.js` is organized as three clearly labeled sections:

| Layer | Responsibility |
|---|---|
| **Model** | Parses source text into `{ title, subtitle, problems[], answers[] }`. Pure logic, no DOM. |
| **View** | Converts parsed data into typeset blocks, paginates them onto letter-size pages, scales the preview, and renders the PDF. |
| **Controller** | Wires the Generate/Download buttons and resize events to the Model and View. |

## Running it

Double-click `index.html`, or serve the folder with any static file server.
There is nothing to install and nothing to build.

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
letters a–h, followed by `.` or `)` and a space.**

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

### Light text formatting

- `**bold**` → **bold**
- `*italic*` → *italic* (single asterisks; don't nest with bold)
- These only apply outside math spans — inside `$...$`, use LaTeX commands
  (`\textbf{}`, `\textit{}`) if you need emphasis in math mode, though this
  is rarely needed.

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
  quick answer-only review sheet.
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
