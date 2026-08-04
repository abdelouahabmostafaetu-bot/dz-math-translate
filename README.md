# DZ Math Translate

A browser extension for reading mathematics in another language. It renders PDFs
itself, rebuilds real paragraphs out of the PDF text layer, translates the pages
you are actually looking at as you scroll, and **never sends a formula to a
translation engine**.

Built for the workflow behind the
[Doc Math DZ Book Series](https://github.com/abdelouahabmostafaetu-bot/dz_math_book_series):
reading English graduate textbooks and doctoral exam papers in Arabic or French
without losing the notation.

## Why not just use an existing extension

I looked first. The landscape:

| Project | What it is | Why it is not this |
|---|---|---|
| [PDFMathTranslate](https://github.com/PDFMathTranslate/PDFMathTranslate) | Python tool, produces a translated PDF with formulas and layout preserved. Excellent, EMNLP 2025 demo. | Not a browser extension. Batch conversion, minutes per book, needs Python. **Use it when you want a translated file.** |
| [BabelDOC](https://github.com/funstory-ai/BabelDOC) | The document-translation library behind the above | Same: a library, not a reader |
| [Immersive Translate](https://github.com/immersive-translate/immersive-translate) | The best-known bilingual extension | PDF translation is a paid Pro feature, and the extension itself is not open source |
| [Read Frog](https://github.com/mengxi-ream/read-frog) | Open-source AI reading extension | Web pages, not a PDF reader; no formula protection |
| [