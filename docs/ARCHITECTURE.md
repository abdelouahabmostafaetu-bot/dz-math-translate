# Architecture

## The constraint that shapes everything

Chrome's built-in PDF viewer is a native plugin (PDFium). Its text never enters
the DOM, so a content script cannot read it, cannot overlay it, and cannot
translate it. Every extension that genuinely translates PDFs does one of two
things:

1. sends the file to a server that rewrites it into a translated PDF
   (PDFMathTranslate, BabelDOC, Immersive Translate Pro), or
2. renders the PDF itself with PDF.js and works on its own DOM.

This project takes route 2: nothing leaves your machine except paragraphs of
prose sent to the translation engine you chose.

## Pieces

```
manifest.json
src/background.js        service worker: message router, PDF interception
src/lib/settings.js      defaults, storage, language list, RTL detection
src/lib/segment.js       PDF text repair + formula protection
src/lib/translator.js    providers, cache, concurrency limit, backoff
src/viewer/*             PDF.js based bilingual reader
src/content/*            inline translation for HTML pages, selection bubble
src/popup/*              settings UI
scripts/fetch-pdfjs.mjs  downloads vendor/pdfjs
```

All network calls happen in the service worker. That gives one shared cache, one
global rate limit, and no CORS problems, since the page itself never talks to
the translation API.

## From pixels to a translated paragraph

1. **Render.** PDF.js draws the page and produces a text layer: dozens of
   absolutely positioned `<span>` elements, one per text run.
2. **Rebuild lines.** Spans are sorted by vertical position and grouped into
   lines with a tolerance of 0.6 x median glyph height.
3. **Rebuild paragraphs.** A new paragraph starts on a vertical gap larger than
   0.9 line heights, on a first-line indent, or after a short line that ends
   with sentence punctuation. This is where most naive PDF translators fail:
   they translate line by line and produce nonsense.
4. **Repair the text.** `joinLines()` fixes words broken by hyphenation
   (`vocabu-` + `lary` -> `vocabulary`), and `normalise()` removes ligature
   glyphs, soft hyphens and duplicated spaces.
5. **Protect the mathematics.** `protectMath()` replaces every formula-looking
   run by an opaque placeholder `ZQX<n>XQZ`. Placeholders are uppercase ASCII
   with no spaces, which translation engines pass through unchanged.
6. **Translate.** The paragraph goes to the engine, at most `concurrency`
   requests at a time, with exponential backoff shared by the whole browser on
   HTTP 429.
7. **Restore.** `restoreMath()` puts the formulas back. If the engine dropped a
   placeholder, the formula is appended rather than lost silently.
8. **Display.** The translation appears in the side pane, aligned with the page
   you are reading. Hovering a card outlines the original paragraph; clicking a
   paragraph in the PDF selects its card.

## Why a side pane instead of overlaying the page

A PDF has fixed layout. Inserting translated text between the lines either
covers the original or requires reflowing a page that cannot reflow. Academic
reading needs the original *and* the translation side by side, especially for
mathematics, where you check the symbols in the original while reading the prose
in your language. The pane also keeps the PDF pixel-perfect for printing.

## Scroll-driven translation

An `IntersectionObserver` with a 200px margin watches the page containers. When
a page becomes visible its paragraphs are queued, together with the next
`prefetchPages` pages, so scrolling feels instant without translating a whole
400-page book up front. Every result is cached by `provider|source|target|hash`,
so re-reading a chapter costs nothing.

## Formula protection, honestly

The detector is a set of regular expressions in `MATH_PATTERNS`, not a parser.
It reliably catches `$...$`, `\( ... \)`, LaTeX commands, expressions containing
a relation or a big operator, `x^2`, `a_n`, `f(x)`, and lone Greek or set-theory
symbols. It will miss exotic notation and occasionally protect a word it should
have translated. Tune the patterns for your field; that file is meant to be
edited.

## Deliberate limits

- **Scanned PDFs** have no text layer. Run `ocrmypdf` first.
- **`file://` URLs** cannot be intercepted, hence the file picker and drag and drop.
- **Free Google endpoint** is undocumented and can change or throttle. Support
  for keyed engines exists for exactly that reason.
- **No layout-preserving output.** This tool is for reading, not for producing a
  translated PDF. Use PDFMathTranslate or BabelDOC for that.
