# PDFed v0.7 — Review Studio

PDFed is a static, local-first workspace for born-digital PDFs. Host these files on GitHub Pages and open the site in a modern browser. Imported PDFs stay in IndexedDB on that device.

## What changed in v0.7

- Markups are now selectable working objects instead of permanent strokes: click with Pointer to move, recolor, change opacity/line weight, edit text, duplicate, or delete.
- Added a Redact tool. On export, any page containing a redaction is rasterized locally before the black redaction is applied so the covered source text is not retained in that exported page. Rasterized redacted pages no longer contain selectable/searchable text.
- Added an Export dialog with filename control and markup inclusion control. Redactions force markups on so an export cannot accidentally expose content that was intended to be redacted.
- Added Compare: select two imported PDFs, match sections by title, flag changed/minor/added/removed sections, and review corresponding source pages side by side.
- Binder now carries secure redactions through the same working-copy export path.
- Library adds an Edited filter for documents with a working-copy state.

## Existing core

- Persistent Library with favorites, collections, recent files, and local document state.
- Born-digital PDF structure compiler: hierarchy, sections, references, figures/tables, section-aware search, and editable heading review.
- Source + Markup mode and section-based Reading mode.
- Page Organizer with reorder, rotate, duplicate, delete-from-working-copy, extract, and reset.
- Binder compiler with document ordering, custom packet labels, dividers, clickable index, PDF bookmarks, optional page numbering, and working-copy edits.

## Deploy

1. Put the contents of this folder at the root of a GitHub repository.
2. In **Settings → Pages**, deploy from the `main` branch and repository root.
3. Open the Pages URL.

No Python or local server is required for normal use. PDF.js and pdf-lib are currently loaded from jsDelivr, so the app itself needs an internet connection when those libraries are not already cached; your PDF bytes are not uploaded by PDFed.

## Input boundary

PDFed v0.7 is intentionally optimized for born-digital PDFs. Image-only/scanned PDFs are rejected rather than silently producing a low-quality structure.

## Redaction boundary

PDFed v0.7 secures redacted exports by rasterizing the entire affected page locally and exporting that raster with the redaction burned in. This prevents the original page text/content stream from being copied into the output, but it also intentionally removes text search/selectability on that page. Treat the exported result as a flattened redacted page and verify the output before distribution.
