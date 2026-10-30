# Vitae — Resume / CV Builder

Fill in your details, choose a design, and save a clean resume as a PDF. Everything runs in the browser, and nothing is uploaded.

Open `index.html` in a modern browser (Chrome, Edge, Safari or Firefox). There's no build step and no server.

---

## Project structure

```
Resume_Builder/
├── index.html           Page structure, editor form, dialogs, help text, icon sprite
├── README.md            This file
├── package.json         Lint/format scripts (Node is NOT needed to run the app)
├── eslint.config.mjs    JavaScript rules
├── .stylelintrc.json    CSS rules (stylelint-config-standard, BEM class names allowed)
├── .htmlvalidate.json   HTML rules (html-validate recommended, Prettier-compatible)
├── .prettierrc.json     Formatting (Prettier, single quotes, 110 columns)
└── assets/
    ├── css/style.css    App styling, resume templates and print rules
    └── js/app.js        All behaviour: schema, form, preview, autosave, PDF
```

Each file starts with a **table of contents**. Section numbers in comments (for example `section 10`) refer to those tables.

---

## Features

- **Live preview.** The real page (A4 or US Letter) is scaled to fit the screen and updates as you type. A page counter and dashed lines show where new pages start.
- **Three templates.**
  - `modern`: accent-colored name and headings with lines
  - `classic`: serif type and a centered header
  - `compact`: smaller type with section headings in the left column
- **18 accent colors**, from green to charcoal. Every one passes WCAG AA contrast (at least 4.5:1) on white paper.
- **Sections.**
  - personal details and contact links
  - summary
  - experience
  - projects
  - education
  - skills, with optional `Group:` labels
  - certifications

  Empty fields and sections are left off the resume.
- **Entries.** Entries can be folded, reordered with ↑ ↓, and removed with an **undo** option.
- **PDF.** Uses the browser's own *Save as PDF*. The PDF contains real, selectable text that applicant tracking systems (ATS) can read, and links stay clickable. The file is named after the person, for example `Alex_Rivera_Resume.pdf`. A tips dialog explains the print settings the first time.
- **Autosave.** The resume is saved to `localStorage`. **Export / import .json** gives a backup that can move between devices.
- **Example resume.** A complete example shows a finished resume, plus there's a built-in help guide.
- **Themes.** Light, dark and auto, for the app only. The paper is always white.

### Why print-to-PDF instead of a PDF library?
Libraries that "screenshot" HTML (html2canvas + jsPDF) produce an **image** of the resume: the text can't be selected and ATS software can't read it. Libraries that draw text (pdfmake) would need a second copy of every template. The browser's print engine gives a text-based PDF that matches the preview exactly, needs no download, and works offline.

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Ctrl/⌘ P` | Save as PDF (shows tips first, then the print window) |
| `Ctrl/⌘ S` | Save now (it also saves automatically) |
| `?` | Help guide (when not typing) |
| `Esc` | Close a dialog or the data menu |
| `←` `→` | Switch between the Edit and Preview tabs (phones, when a tab has focus) |

---

## Common changes

### Add a field to a list section (e.g. "GPA" in education)
In **`app.js` → section 02**, add an object to that section's `fields`, for example `{ key: 'gpa', label: 'GPA', placeholder: '3.8' }`. Then use it in the section's `preview` function. The form, saving, import and export pick it up automatically.

### Add a whole new list section (e.g. "Volunteering")
1. In **`app.js` → section 02**, add an entry to `LIST_SECTIONS` with `heading`, `itemName`, `fields`, `title` and `preview`.
2. Add its key to `PREVIEW_ORDER` where it should appear on the resume.
3. In **`index.html`**, copy one of the list blocks (`data-list="…"` + `data-add="…"`) and change the key.

### Add a template
1. In **`index.html`**, add an `<option>` to the template select.
2. In **`app.js` → section 01**, add its name to `TEMPLATES`.
3. In **`style.css` → section 13**, add `.resume--NAME …` rules.

### Change resume fonts, sizes or spacing
Edit **`style.css` → sections 12–13**. Use `pt` and `mm` so the PDF matches the preview. Page margins are `PAGE_MARGIN` in **`app.js` → section 01**, used both on screen and in the `@page` rule.

### Add an accent color
Add it to `ACCENTS` in **`app.js` → section 01**. Check that it has at least 4.5:1 contrast against white.

### Edit the help guide
Edit the help guide as plain HTML in **`index.html`**, inside `<dialog id="helpDialog">`.

### Change app colors
Edit the design tokens in **`style.css` → section 01**. The dark theme appears twice: once for the manual setting and once for `auto`. Keep both blocks identical.

---

## Code checks

Node.js is **only** needed for these checks. The app itself runs from `index.html` without it.

```sh
npm install          # once: downloads the checkers into node_modules/
npm run lint         # HTML + CSS + JS + formatting; must pass before shipping
npm run format       # auto-format every file with Prettier
```

| Tool | Checks | Config |
|---|---|---|
| html-validate | Valid HTML, accessible names, ARIA usage, WCAG rules | `.htmlvalidate.json` |
| Stylelint | Modern, error-free CSS | `.stylelintrc.json` |
| ESLint | JavaScript bugs and unsafe patterns | `eslint.config.mjs` |
| Prettier | Consistent formatting | `.prettierrc.json` |

---

## Standards followed

- **Accessibility (WCAG 2.1 AA).**
  - All app text has a contrast ratio of at least 4.5:1, and every resume accent color passes AA on white.
  - Every input has a label, and hints are linked with `aria-describedby`.
  - There is a skip link and visible focus rings.
  - The phone Edit/Preview switcher follows the WAI-ARIA tabs pattern, and dialogs are native `<dialog>` elements with focus restore.
  - Disabled buttons use `aria-disabled` rather than `disabled`, so focus isn't lost.
  - Focus is managed after add, move, remove and undo, live regions announce changes (including inside dialogs), and reduced motion is respected.
- **Security.**
  - All user text is inserted with `textContent` and never parsed as HTML.
  - Links are built only as `mailto:`, `tel:` or `http(s):`, so `javascript:` URLs are refused.
  - Saved and imported data is validated and size-limited by `normalizeResume()`.
- **Privacy.** No uploads, analytics or third-party scripts. The only outside request is for Google Fonts.
- **Responsive and mobile-first.** Phones get tabs to switch between editing and the preview. Tablets get two-column fields (600px and up). Desktops get a side-by-side editor and preview (1000px and up).
- **Robustness.** Storage, download, import and print failures are shown to the user and logged with a `Vitae:` prefix. Damaged saved data is ignored safely.
- **Code style.**
  - The code uses `'use strict'`, and every function has a JSDoc comment and is no longer than 25 lines.
  - Each file has a table of contents.
  - ESLint, Stylelint, html-validate and Prettier all pass.
