/* ==========================================================================
   Vitae — app.js
   --------------------------------------------------------------------------
   All behaviour for the resume builder. Written as one plain script (no ES
   modules) so the app runs straight from file:// with no server.

   Data model — state.resume:
       {
         design:  { template, paper, accent },
         profile: { fullName, headline, email, phone, location, website,
                    linkedin, summary, skills },
         experience: [{ id, role, company, … }], projects: […],
         education: […], certifications: […]
       }
   List sections are described once in LIST_SECTIONS (section 02); the form
   AND the preview are both generated from that description.

   Every edit → onResumeChanged() → preview re-render (next frame) + autosave.
   "Save PDF" uses the browser's print-to-PDF, so the PDF keeps real,
   selectable text that applicant tracking systems (ATS) can read.

   TABLE OF CONTENTS
     01  Settings & constants
     02  Section schema
     03  DOM references
     04  Small helpers
     05  Resume data (normalize, sample, empty checks)
     06  State & autosave
     07  Form: profile & design fields
     08  Form: list entries (rendering)
     09  Form: list entries (add, move, remove, undo)
     10  Preview: building the resume
     11  Preview: scaling & page breaks
     12  PDF (print)
     13  Data menu (example, import, export, clear)
     14  Dialogs (shared + confirm)
     15  Phone tabs (Edit / Preview)
     16  Toast & screen-reader announcements
     17  Theme
     18  Keyboard shortcuts
     19  Init
   ========================================================================== */
(function () {
  'use strict';

  /* ==========================================================================
     01  SETTINGS & CONSTANTS
     ========================================================================== */
  const STORAGE_KEYS = {
    theme: 'vitae-theme', // also read by the inline script in index.html
    resume: 'vitae-resume',
    pdfTipSeen: 'vitae-pdf-tip-seen',
  };

  const SAVE_DELAY_MS = 400; // autosave waits this long after the last keystroke
  const TOAST_MS = 2400;
  const UNDO_MS = 8000; // how long "Entry removed. undo" stays
  const MAX_ENTRIES = 20; // per list section
  const MAX_IMPORT_BYTES = 1000000; // a resume backup is a few KB; refuse anything huge

  const THEMES = ['auto', 'light', 'dark'];
  /** Browser-bar color (meta theme-color) for a manually chosen theme. Matches --surface. */
  const THEME_BAR_COLORS = { light: '#ffffff', dark: '#101317' };
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const TEMPLATES = ['modern', 'classic', 'compact'];
  /** Paper sizes in millimetres. `size` is the CSS @page keyword. */
  const PAPERS = {
    a4: { label: 'A4', size: 'A4', width: 210, height: 297 },
    letter: { label: 'US Letter', size: 'letter', width: 215.9, height: 279.4 },
  };
  /** PDF page margins in mm (top/bottom, left/right). Used on screen and in @page. */
  const PAGE_MARGIN = { y: 16, x: 18 };
  const MM_TO_PX = 96 / 25.4;

  /** Accent presets — every one has ≥ 4.5:1 contrast on white paper (WCAG AA). */
  const ACCENTS = [
    // greens & blues
    { value: '#0a7a52', name: 'Green' },
    { value: '#4d7c0f', name: 'Olive' },
    { value: '#0f766e', name: 'Teal' },
    { value: '#0e7490', name: 'Cyan' },
    { value: '#0369a1', name: 'Sky' },
    { value: '#1d4ed8', name: 'Blue' },
    { value: '#1e3a8a', name: 'Navy' },
    // purples & pinks
    { value: '#4338ca', name: 'Indigo' },
    { value: '#6d28d9', name: 'Violet' },
    { value: '#7e22ce', name: 'Purple' },
    { value: '#a21caf', name: 'Magenta' },
    { value: '#be185d', name: 'Pink' },
    // reds & earth tones
    { value: '#b91c1c', name: 'Red' },
    { value: '#c2410c', name: 'Orange' },
    { value: '#b45309', name: 'Amber' },
    { value: '#92400e', name: 'Brown' },
    // neutrals
    { value: '#334155', name: 'Slate' },
    { value: '#1f2937', name: 'Charcoal' },
  ];

  /* ==========================================================================
     02  SECTION SCHEMA
     PROFILE_FIELDS: single fields → max length (must match data-profile in HTML).
     LIST_SECTIONS: repeatable entries. For each section:
       fields   form inputs (key, label, placeholder, type, hint, full width?)
       title    text shown on the folded entry in the form
       preview  how one entry appears on the resume
     To add a section: add it here, add a matching block in index.html
     (data-list / data-add) and its key to PREVIEW_ORDER.
     ========================================================================== */
  const PROFILE_FIELDS = {
    fullName: 80,
    headline: 120,
    email: 120,
    phone: 40,
    location: 100,
    website: 200,
    linkedin: 200,
    summary: 1200,
    skills: 1500,
  };

  const TEXT_LIMIT = 150; // single-line list fields
  const TEXTAREA_LIMIT = 2000;

  const LIST_SECTIONS = {
    experience: {
      heading: 'Experience',
      itemName: 'job',
      fields: [
        { key: 'role', label: 'job title', placeholder: 'Frontend Developer', full: true },
        { key: 'company', label: 'company', placeholder: 'Brightline Studio' },
        { key: 'location', label: 'location', placeholder: 'Remote' },
        { key: 'start', label: 'start', placeholder: 'Jan 2022' },
        { key: 'end', label: 'end', placeholder: 'Mar 2024' },
        { key: 'current', label: 'I currently work here', type: 'checkbox' },
        {
          key: 'highlights',
          label: 'highlights',
          type: 'textarea',
          placeholder: 'Rebuilt the dashboard, cutting load time by 48%',
          hint: 'One per line. Start with a verb; add numbers where you can.',
        },
      ],
      title: (entry) => [entry.role, entry.company].filter(Boolean).join(' · '),
      preview: (entry) => ({
        title: entry.role,
        subtitle: [entry.company, entry.location],
        date: dateRange(entry.start, entry.end, entry.current),
        bullets: entry.highlights,
      }),
    },
    projects: {
      heading: 'Projects',
      itemName: 'project',
      fields: [
        { key: 'name', label: 'project name', placeholder: 'Open Recipes', full: true },
        { key: 'link', label: 'link', type: 'url', placeholder: 'github.com/you/project', full: true },
        {
          key: 'description',
          label: 'description',
          type: 'textarea',
          placeholder: 'Offline-first recipe app (Vue, IndexedDB)',
          hint: 'One point per line: what it does, your role, the result.',
        },
      ],
      title: (entry) => entry.name,
      preview: (entry) => ({ title: entry.name, link: entry.link, bullets: entry.description }),
    },
    education: {
      heading: 'Education',
      itemName: 'school',
      fields: [
        { key: 'degree', label: 'degree / course', placeholder: 'BS Computer Science', full: true },
        { key: 'school', label: 'school', placeholder: 'Metro State University' },
        { key: 'location', label: 'location', placeholder: 'Quezon City' },
        { key: 'start', label: 'start', placeholder: '2015' },
        { key: 'end', label: 'end', placeholder: '2019' },
        {
          key: 'details',
          label: 'details',
          type: 'textarea',
          placeholder: 'Cum laude',
          hint: 'Optional: honours, GPA, thesis… one per line.',
        },
      ],
      title: (entry) => [entry.degree, entry.school].filter(Boolean).join(' · '),
      preview: (entry) => ({
        title: entry.degree,
        subtitle: [entry.school, entry.location],
        date: dateRange(entry.start, entry.end, false),
        bullets: entry.details,
      }),
    },
    certifications: {
      heading: 'Certifications',
      itemName: 'certification',
      fields: [
        { key: 'name', label: 'certificate', placeholder: 'AWS Cloud Practitioner', full: true },
        { key: 'issuer', label: 'issued by', placeholder: 'Amazon Web Services' },
        { key: 'date', label: 'date', placeholder: '2023' },
      ],
      title: (entry) => entry.name,
      preview: (entry) => ({ title: entry.name, subtitle: [entry.issuer], date: entry.date }),
    },
  };

  /** Order of sections on the resume. "summary" and "skills" come from the profile. */
  const PREVIEW_ORDER = ['summary', 'experience', 'projects', 'education', 'skills', 'certifications'];
  const PROFILE_SECTION_HEADINGS = { summary: 'Summary', skills: 'Skills' };

  /* ==========================================================================
     03  DOM REFERENCES
     Every id used here exists in index.html.
     ========================================================================== */
  const byId = (id) => document.getElementById(id);

  const els = {
    // Top bar & toolbar
    helpBtn: byId('helpBtn'),
    themeBtn: byId('themeBtn'),
    tabEdit: byId('tabEdit'),
    tabPreview: byId('tabPreview'),
    saveStatus: byId('saveStatus'),
    dataBtn: byId('dataBtn'),
    dataMenu: byId('dataMenu'),
    sampleBtn: byId('sampleBtn'),
    importBtn: byId('importBtn'),
    importInput: byId('importInput'),
    exportBtn: byId('exportBtn'),
    clearBtn: byId('clearBtn'),
    pdfBtn: byId('pdfBtn'),
    // Workspace
    editorPanel: byId('editorPanel'),
    previewPanel: byId('previewPanel'),
    form: byId('resumeForm'),
    accentOptions: byId('accentOptions'),
    previewStage: byId('previewStage'),
    pageScaler: byId('pageScaler'),
    resume: byId('resume'),
    pageCount: byId('pageCount'),
    pageStyle: byId('pageStyle'),
    // Dialogs
    confirmDialog: byId('confirmDialog'),
    confirmTitle: byId('confirmTitle'),
    confirmMessage: byId('confirmMessage'),
    confirmOkBtn: byId('confirmOkBtn'),
    pdfDialog: byId('pdfDialog'),
    pdfPaperName: byId('pdfPaperName'),
    pdfTipSkip: byId('pdfTipSkip'),
    pdfContinueBtn: byId('pdfContinueBtn'),
    helpDialog: byId('helpDialog'),
    // Feedback
    toast: byId('toast'),
    announcer: byId('announcer'),
  };

  /* ==========================================================================
     04  SMALL HELPERS
     ========================================================================== */
  /**
   * Create an element with an optional class and text (text is never parsed as HTML).
   * @param {string} tag
   * @param {string} [className]
   * @param {string} [text]
   */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** True for {…} objects (not arrays, not null). */
  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /** A string cut to `max` characters; anything that isn't a string becomes "". */
  function cleanText(value, max) {
    return typeof value === 'string' ? value.slice(0, max) : '';
  }

  /** Short unique-enough id for list entries (only used while the page is open). */
  function makeId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /** "job" → "Job" */
  function capitalize(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  /** Text → trimmed, non-empty lines, with typed bullet characters ("- ", "• ") removed. */
  function splitLines(text) {
    return String(text || '')
      .split('\n')
      .map((line) => line.replace(/^\s*[-•*·]\s*/, '').trim())
      .filter(Boolean);
  }

  /** "Jan 2022" + "Mar 2024" → "Jan 2022 – Mar 2024"; current job → "… – Present". */
  function dateRange(start, end, current) {
    const from = start.trim();
    const to = current ? 'Present' : end.trim();
    return from && to ? `${from} – ${to}` : from || to;
  }

  /**
   * A safe link target for a contact value, or null.
   * Only mailto:, tel: and http(s): are ever produced (no javascript: etc.).
   * @param {string} value
   * @param {'email'|'phone'|'url'} kind
   */
  function toHref(value, kind) {
    const text = value.trim();
    if (!text) return null;
    if (kind === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? `mailto:${text}` : null;
    if (kind === 'phone') return /\d/.test(text) ? `tel:${text.replace(/[^\d+]/g, '')}` : null;
    if (/^https?:\/\//i.test(text)) return text;
    // Bare domains like "alexrivera.dev" get https:// added; anything with a scheme or spaces is refused.
    return /^[^\s:/]+\.[^\s:]+/.test(text) ? `https://${text}` : null;
  }

  /** "https://www.alexrivera.dev/" → "alexrivera.dev" (shorter on the resume). */
  function displayUrl(value) {
    return value
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(/\/$/, '');
  }

  /**
   * Build an icon that points at a <symbol> in the sprite (index.html).
   * @param {string} name symbol id without the "i-" prefix, e.g. "trash"
   * @returns {SVGSVGElement}
   */
  function svgIcon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.appendChild(use);
    return svg;
  }

  /**
   * Turn a button on/off with aria-disabled instead of the disabled attribute,
   * so keyboard focus isn't lost when a focused button turns off.
   * @param {HTMLButtonElement} button
   * @param {boolean} disabled
   */
  function setDisabled(button, disabled) {
    button.setAttribute('aria-disabled', String(disabled));
  }

  /** True when the user is typing in a field (single-key shortcuts must not fire). */
  function isTypingTarget(element) {
    return (
      Boolean(element) && (element.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(element.tagName))
    );
  }

  /** Read from localStorage without throwing (private mode can block it). */
  function readStorage(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      console.warn('Vitae: storage is not available', error);
      return null;
    }
  }

  /**
   * Write to localStorage.
   * @returns {boolean} false when storage is full or blocked
   */
  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error) {
      console.warn('Vitae: could not write to storage', error);
      return false;
    }
  }

  /** Save text as a file (works from file:// too). */
  function downloadFile(fileName, text, mime) {
    try {
      const url = URL.createObjectURL(new Blob([text], { type: mime }));
      const link = el('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    } catch (error) {
      console.error('Vitae: download failed', error);
      showToast('Download failed — your browser blocked it');
      return false;
    }
  }

  /* ==========================================================================
     05  RESUME DATA
     normalizeResume() is the gatekeeper: everything loaded from storage, an
     imported file or the example passes through it, so the rest of the code
     can trust the shape and types of state.resume.
     ========================================================================== */
  /** Default paper: US Letter where it's the norm, A4 everywhere else. */
  function defaultPaper() {
    return /-(US|CA|PH|MX)$/i.test(navigator.language || '') ? 'letter' : 'a4';
  }

  /** Max length for a list field. */
  function fieldLimit(field) {
    return field.type === 'textarea' ? TEXTAREA_LIMIT : TEXT_LIMIT;
  }

  /**
   * Build a clean resume from anything (missing/invalid parts become defaults).
   * @param {unknown} raw
   */
  function normalizeResume(raw) {
    const source = isPlainObject(raw) ? raw : {};
    const resume = {
      design: normalizeDesign(source.design),
      profile: normalizeProfile(source.profile),
    };
    Object.entries(LIST_SECTIONS).forEach(([key, section]) => {
      resume[key] = normalizeList(source[key], section);
    });
    return resume;
  }

  /** Template / paper / accent, each limited to the known options. */
  function normalizeDesign(raw) {
    const design = isPlainObject(raw) ? raw : {};
    return {
      template: TEMPLATES.includes(design.template) ? design.template : TEMPLATES[0],
      paper: Object.hasOwn(PAPERS, design.paper) ? design.paper : defaultPaper(),
      accent: ACCENTS.some((accent) => accent.value === design.accent) ? design.accent : ACCENTS[0].value,
    };
  }

  /** Every PROFILE_FIELDS key as a length-limited string. */
  function normalizeProfile(raw) {
    const profile = isPlainObject(raw) ? raw : {};
    return Object.fromEntries(
      Object.entries(PROFILE_FIELDS).map(([key, max]) => [key, cleanText(profile[key], max)]),
    );
  }

  /** Up to MAX_ENTRIES clean entries. */
  function normalizeList(raw, section) {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(isPlainObject)
      .slice(0, MAX_ENTRIES)
      .map((entry) => normalizeEntry(entry, section));
  }

  /** One entry with exactly the section's fields (plus a fresh id). */
  function normalizeEntry(raw, section) {
    const entry = { id: makeId() };
    section.fields.forEach((field) => {
      entry[field.key] =
        field.type === 'checkbox' ? raw[field.key] === true : cleanText(raw[field.key], fieldLimit(field));
    });
    return entry;
  }

  /** True when at least one text field of the entry has something in it. */
  function entryHasContent(entry, section) {
    return section.fields.some((field) => field.type !== 'checkbox' && entry[field.key].trim() !== '');
  }

  /** True when there's nothing to put on the resume yet. */
  function isResumeEmpty(resume) {
    const hasProfile = Object.keys(PROFILE_FIELDS).some((key) => resume.profile[key].trim() !== '');
    const hasEntries = Object.entries(LIST_SECTIONS).some(([key, section]) =>
      resume[key].some((entry) => entryHasContent(entry, section)),
    );
    return !hasProfile && !hasEntries;
  }

  /** The resume as plain data for storage/export (entry ids are dropped). */
  function serializeResume(resume) {
    const data = { design: { ...resume.design }, profile: { ...resume.profile } };
    Object.keys(LIST_SECTIONS).forEach((key) => {
      data[key] = resume[key].map((entry) =>
        Object.fromEntries(Object.entries(entry).filter(([name]) => name !== 'id')),
      );
    });
    return data;
  }

  /**
   * A complete fictional resume, so people can see what a finished one looks like.
   * Plain data; sampleResume() runs it through normalizeResume() for fresh ids.
   */
  const SAMPLE_RESUME = {
    profile: {
      fullName: 'Alex Rivera',
      headline: 'Frontend Developer',
      email: 'alex.rivera@example.com',
      phone: '+63 900 000 0000',
      location: 'Manila, Philippines',
      website: 'alexrivera.dev',
      linkedin: 'linkedin.com/in/alexrivera',
      summary:
        'Frontend developer with 5 years of experience building fast, accessible web apps. I turn designs into clean, tested code and care about performance and the people who use the product.',
      skills:
        'Languages: JavaScript, TypeScript, HTML, CSS, Python, SQL\nFrameworks: React, Vue, Node.js, Express\nTools: Git, Figma, Vite, Jest, Playwright\nPractices: Accessibility (WCAG 2.1), responsive design, CI/CD',
    },
    experience: [
      {
        role: 'Frontend Developer',
        company: 'Brightline Studio',
        location: 'Remote',
        start: 'Mar 2022',
        current: true,
        highlights:
          'Rebuilt the customer dashboard in React, cutting load time by 48%\nLed an accessibility audit and fixed 120+ issues to reach WCAG 2.1 AA\nMentored 3 junior developers through code reviews and pair programming',
      },
      {
        role: 'Web Developer',
        company: 'Harbor Analytics',
        location: 'Makati, Philippines',
        start: 'Jun 2019',
        end: 'Feb 2022',
        highlights:
          'Built 15+ responsive marketing pages that lifted sign-ups by 22%\nCreated a shared component library used across 4 products\nAutomated visual regression tests, reducing UI bugs in releases by 35%',
      },
    ],
    projects: [
      {
        name: 'Open Recipes',
        link: 'github.com/alexrivera/open-recipes',
        description:
          'Offline-first recipe app with search and meal planning (Vue, IndexedDB)\n2,000+ monthly users',
      },
    ],
    education: [
      {
        degree: 'BS Computer Science',
        school: 'Metro State University',
        location: 'Quezon City',
        start: '2015',
        end: '2019',
        details: 'Cum laude\nThesis: Accessible data visualisation on the web',
      },
    ],
    certifications: [
      { name: 'AWS Certified Cloud Practitioner', issuer: 'Amazon Web Services', date: '2023' },
    ],
  };

  /** The example resume, keeping the user's current design settings. */
  function sampleResume() {
    return normalizeResume({ ...SAMPLE_RESUME, design: state.resume.design });
  }

  /* ==========================================================================
     06  STATE & AUTOSAVE
     ========================================================================== */
  const state = {
    resume: null, // set in init()
    openEntries: new Set(), // ids of unfolded entries (survives list re-renders)
    lastRemoved: null, // { sectionKey, index, entry } for "undo"
    undoTimer: 0,
    saveTimer: 0,
    previewFrame: 0,
    saveErrorShown: false,
    theme: 'auto',
  };

  /** The saved resume, or an empty one when there is none / it's damaged. */
  function loadResume() {
    const raw = readStorage(STORAGE_KEYS.resume);
    if (!raw) return normalizeResume({});
    try {
      return normalizeResume(JSON.parse(raw));
    } catch (error) {
      console.warn('Vitae: the saved resume is unreadable and was ignored', error);
      return normalizeResume({});
    }
  }

  /** Called after every change: refresh the preview and autosave. */
  function onResumeChanged() {
    schedulePreview();
    scheduleSave();
  }

  /** Save shortly after the last change (typing doesn't write on every key). */
  function scheduleSave() {
    els.saveStatus.textContent = 'saving…';
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
  }

  /** Write the resume to localStorage right away. */
  function saveNow() {
    clearTimeout(state.saveTimer);
    state.saveTimer = 0;
    const saved = writeStorage(STORAGE_KEYS.resume, JSON.stringify(serializeResume(state.resume)));
    if (saved) {
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      els.saveStatus.textContent = `saved ${time}`;
      return;
    }
    els.saveStatus.textContent = 'not saved — storage blocked';
    if (!state.saveErrorShown) {
      state.saveErrorShown = true;
      showToast('Autosave is blocked in this browser — use data → export .json to keep a copy');
    }
  }

  /** Leaving the page with a save still pending: write it now. */
  function flushPendingSave() {
    if (state.saveTimer) saveNow();
  }

  /** Replace the whole resume (example, import, clear) and refresh everything. */
  function setResume(resume) {
    state.resume = resume;
    state.openEntries.clear();
    state.lastRemoved = null;
    hideUndoBars();
    fillProfileFields();
    fillDesignControls();
    renderAllLists();
    renderPreview();
    saveNow();
  }

  /* ==========================================================================
     07  FORM: PROFILE & DESIGN FIELDS
     ========================================================================== */
  /** Set maxlength on the static profile fields from PROFILE_FIELDS. */
  function applyFieldLimits() {
    els.form.querySelectorAll('[data-profile]').forEach((input) => {
      input.maxLength = PROFILE_FIELDS[input.dataset.profile];
    });
  }

  /** Create the accent radio buttons from ACCENTS. */
  function buildAccentOptions() {
    const options = ACCENTS.map((accent) => {
      const label = el('label', 'accent-option');
      label.title = accent.name;
      const input = el('input', 'accent-input');
      Object.assign(input, { type: 'radio', name: 'accent', value: accent.value });
      input.dataset.design = 'accent';
      input.setAttribute('aria-label', accent.name);
      const swatch = el('span', 'accent-swatch');
      swatch.style.setProperty('--swatch', accent.value);
      label.append(input, swatch);
      return label;
    });
    els.accentOptions.replaceChildren(...options);
  }

  /** Copy profile values from state into the inputs. */
  function fillProfileFields() {
    els.form.querySelectorAll('[data-profile]').forEach((input) => {
      input.value = state.resume.profile[input.dataset.profile];
    });
  }

  /** Copy design values from state into the selects and radios. */
  function fillDesignControls() {
    els.form.querySelectorAll('[data-design]').forEach((control) => {
      const value = state.resume.design[control.dataset.design];
      if (control.type === 'radio') control.checked = control.value === value;
      else control.value = value;
    });
  }

  /** Any input/change in the form: write the value into state. */
  function handleFormInput(event) {
    const field = event.target;
    if (field.dataset.profile) {
      state.resume.profile[field.dataset.profile] = field.value;
    } else if (field.dataset.design) {
      if (field.type === 'radio' && !field.checked) return;
      state.resume.design[field.dataset.design] = field.value;
    } else if (field.dataset.key) {
      updateEntryField(field);
    } else {
      return;
    }
    onResumeChanged();
  }

  /* ==========================================================================
     08  FORM: LIST ENTRIES (rendering)
     Each entry is a <details class="entry" data-list="…" data-id="…">.
     Inputs inside carry data-key (the field name).
     ========================================================================== */
  /** The container for a section's entries. */
  function listContainer(sectionKey) {
    return els.form.querySelector(`[data-list="${sectionKey}"]`);
  }

  /** The <details> of one entry, or null. */
  function findEntryEl(sectionKey, id) {
    return listContainer(sectionKey).querySelector(`.entry[data-id="${CSS.escape(id)}"]`);
  }

  /** Rebuild every list section. */
  function renderAllLists() {
    Object.keys(LIST_SECTIONS).forEach(renderList);
  }

  /** Rebuild one list section's entries and its "add" button state. */
  function renderList(sectionKey) {
    const entries = state.resume[sectionKey];
    listContainer(sectionKey).replaceChildren(
      ...entries.map((entry, index) => createEntry(sectionKey, entry, index, entries.length)),
    );
    const addButton = els.form.querySelector(`[data-add="${sectionKey}"]`);
    setDisabled(addButton, entries.length >= MAX_ENTRIES);
  }

  /** One foldable entry: summary line + move/remove tools + fields. */
  function createEntry(sectionKey, entry, index, total) {
    const section = LIST_SECTIONS[sectionKey];
    const details = el('details', 'entry');
    Object.assign(details.dataset, { list: sectionKey, id: entry.id, index: String(index) });
    details.open = state.openEntries.has(entry.id);

    const summary = el('summary', 'entry-summary');
    summary.appendChild(el('span', 'entry-title'));
    const body = el('div', 'entry-body');
    body.append(createEntryTools(section, index, total), createEntryFields(sectionKey, section, entry));
    details.append(summary, body);
    updateEntryTitle(details, section, entry);
    return details;
  }

  /** Move up / move down / remove buttons for an entry. */
  function createEntryTools(section, index, total) {
    const name = `${section.itemName} ${index + 1}`;
    const tools = el('div', 'entry-tools');
    const up = createIconButton('up', `Move ${name} up`, 'up');
    const down = createIconButton('down', `Move ${name} down`, 'down');
    const remove = createIconButton('trash', `Remove ${name}`, 'remove');
    remove.classList.add('entry-remove');
    setDisabled(up, index === 0);
    setDisabled(down, index === total - 1);
    tools.append(up, down, remove);
    return tools;
  }

  /** Small icon-only button with a data-entry-action. */
  function createIconButton(icon, label, action) {
    const button = el('button', 'icon-btn');
    button.type = 'button';
    button.dataset.entryAction = action;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.appendChild(svgIcon(icon));
    return button;
  }

  /** All inputs of an entry, laid out in the shared field grid. */
  function createEntryFields(sectionKey, section, entry) {
    const grid = el('div', 'field-grid');
    section.fields.forEach((field) => {
      const id = `${sectionKey}-${entry.id}-${field.key}`;
      grid.appendChild(
        field.type === 'checkbox' ? createCheckbox(field, entry, id) : createField(field, entry, id),
      );
    });
    const end = grid.querySelector('[data-key="end"]');
    if (end) end.disabled = entry.current === true;
    return grid;
  }

  /** Label + input/textarea (+ hint) for one text field. */
  function createField(field, entry, id) {
    const isTextarea = field.type === 'textarea';
    const wrapper = el('div', isTextarea || field.full ? 'field field--full' : 'field');
    const label = el('label', 'field-label', field.label);
    label.htmlFor = id;
    const control = el(isTextarea ? 'textarea' : 'input');
    if (isTextarea) control.rows = 3;
    else control.type = field.type === 'url' ? 'url' : 'text';
    Object.assign(control, { id, value: entry[field.key], maxLength: fieldLimit(field) });
    control.placeholder = field.placeholder || '';
    control.dataset.key = field.key;
    wrapper.append(label, control);
    if (field.hint) wrapper.appendChild(createHint(control, field.hint));
    return wrapper;
  }

  /** Hint text linked to its control with aria-describedby. */
  function createHint(control, text) {
    const hint = el('p', 'field-hint', text);
    hint.id = `${control.id}-hint`;
    control.setAttribute('aria-describedby', hint.id);
    return hint;
  }

  /** Checkbox + label (e.g. "I currently work here"). */
  function createCheckbox(field, entry, id) {
    const label = el('label', 'check field--full');
    const input = el('input', 'check-input');
    Object.assign(input, { type: 'checkbox', id, checked: entry[field.key] === true });
    input.dataset.key = field.key;
    label.append(input, el('span', '', field.label));
    return label;
  }

  /** Folded-entry title: "Frontend Developer · Brightline Studio", or "Job 2" when empty. */
  function updateEntryTitle(details, section, entry) {
    const title = section.title(entry);
    const span = details.querySelector('.entry-title');
    span.textContent = title || `${capitalize(section.itemName)} ${Number(details.dataset.index) + 1}`;
    span.classList.toggle('entry-title--empty', !title);
  }

  /** Typing in an entry field: update state and the folded title. */
  function updateEntryField(field) {
    const details = field.closest('.entry');
    if (!details) return;
    const sectionKey = details.dataset.list;
    const entry = state.resume[sectionKey].find((item) => item.id === details.dataset.id);
    if (!entry) return;

    entry[field.dataset.key] = field.type === 'checkbox' ? field.checked : field.value;
    if (field.dataset.key === 'current') details.querySelector('[data-key="end"]').disabled = field.checked;
    updateEntryTitle(details, LIST_SECTIONS[sectionKey], entry);
  }

  /** Remember which entries are unfolded (the 'toggle' event doesn't bubble, so it's captured). */
  function handleEntryToggle(event) {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement) || !details.classList.contains('entry')) return;
    if (details.open) state.openEntries.add(details.dataset.id);
    else state.openEntries.delete(details.dataset.id);
  }

  /* ==========================================================================
     09  FORM: LIST ENTRIES (add, move, remove, undo)
     ========================================================================== */
  /** Clicks inside the form: add buttons, entry tools and undo. */
  function handleFormClick(event) {
    const button = event.target.closest('button');
    if (!button || button.getAttribute('aria-disabled') === 'true') return;
    if (button.dataset.add) addEntry(button.dataset.add);
    else if (button.dataset.entryAction) handleEntryAction(button);
    else if (button.classList.contains('undo-btn')) undoRemove();
  }

  /** Move up / down / remove for the entry that contains `button`. */
  function handleEntryAction(button) {
    const details = button.closest('.entry');
    const sectionKey = details.dataset.list;
    const index = state.resume[sectionKey].findIndex((entry) => entry.id === details.dataset.id);
    if (index < 0) return;
    const action = button.dataset.entryAction;
    if (action === 'up') moveEntry(sectionKey, index, -1);
    else if (action === 'down') moveEntry(sectionKey, index, 1);
    else if (action === 'remove') removeEntry(sectionKey, index);
  }

  /** Append a blank, unfolded entry and put the cursor in its first field. */
  function addEntry(sectionKey) {
    const list = state.resume[sectionKey];
    if (list.length >= MAX_ENTRIES) return;
    const entry = normalizeEntry({}, LIST_SECTIONS[sectionKey]);
    list.push(entry);
    state.openEntries.add(entry.id);
    renderList(sectionKey);
    onResumeChanged();
    findEntryEl(sectionKey, entry.id).querySelector('input, textarea').focus();
  }

  /** Swap an entry with its neighbour and keep focus on the arrow that was used. */
  function moveEntry(sectionKey, index, direction) {
    const list = state.resume[sectionKey];
    const target = index + direction;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    renderList(sectionKey);
    onResumeChanged();

    const details = findEntryEl(sectionKey, list[target].id);
    const same = details.querySelector(`[data-entry-action="${direction < 0 ? 'up' : 'down'}"]`);
    const other = details.querySelector(`[data-entry-action="${direction < 0 ? 'down' : 'up'}"]`);
    (same.getAttribute('aria-disabled') === 'true' ? other : same).focus();
    announce(`Moved to position ${target + 1} of ${list.length}`);
  }

  /** Remove an entry; it can be restored with "undo" for a few seconds. */
  function removeEntry(sectionKey, index) {
    const list = state.resume[sectionKey];
    const [entry] = list.splice(index, 1);
    state.lastRemoved = { sectionKey, index, entry };
    renderList(sectionKey);
    onResumeChanged();
    showUndoBar(sectionKey);

    // Keep keyboard focus nearby: next entry, previous entry, or the undo button.
    const neighbour = list[index] || list[index - 1];
    const target = neighbour
      ? findEntryEl(sectionKey, neighbour.id).querySelector('summary')
      : getUndoBar(sectionKey).querySelector('button');
    target.focus();
    announce('Entry removed. Undo is available');
  }

  /** Put the last removed entry back where it was. */
  function undoRemove() {
    const removed = state.lastRemoved;
    if (!removed) return;
    const list = state.resume[removed.sectionKey];
    list.splice(Math.min(removed.index, list.length), 0, removed.entry);
    state.lastRemoved = null;
    clearTimeout(state.undoTimer);
    renderList(removed.sectionKey);
    findEntryEl(removed.sectionKey, removed.entry.id).querySelector('summary').focus();
    hideUndoBars();
    onResumeChanged();
    announce('Entry restored');
  }

  const undoBars = new Map(); // sectionKey → <p class="undo-bar">

  /** The undo bar for a section (created the first time it's needed). */
  function getUndoBar(sectionKey) {
    if (!undoBars.has(sectionKey)) {
      const bar = el('p', 'undo-bar');
      bar.hidden = true;
      const button = el('button', 'btn undo-btn', 'undo');
      button.type = 'button';
      bar.append(el('span', '', 'Entry removed.'), button);
      listContainer(sectionKey).before(bar);
      undoBars.set(sectionKey, bar);
    }
    return undoBars.get(sectionKey);
  }

  /** Show one section's undo bar (hiding any other) for UNDO_MS. */
  function showUndoBar(sectionKey) {
    hideUndoBars();
    getUndoBar(sectionKey).hidden = false;
    clearTimeout(state.undoTimer);
    state.undoTimer = setTimeout(expireUndo, UNDO_MS);
  }

  /** Time's up for undo — unless someone is focused on the undo button. */
  function expireUndo() {
    const focusedBar = [...undoBars.values()].some((bar) => bar.contains(document.activeElement));
    if (focusedBar) {
      state.undoTimer = setTimeout(expireUndo, UNDO_MS);
      return;
    }
    hideUndoBars();
    state.lastRemoved = null;
  }

  /** Hide every section's undo bar. */
  function hideUndoBars() {
    undoBars.forEach((bar) => {
      bar.hidden = true;
    });
  }

  /* ==========================================================================
     10  PREVIEW: BUILDING THE RESUME
     The resume is rebuilt from state on every change (it's small, so this is
     fast and keeps the code simple). Empty fields and sections are skipped.
     ========================================================================== */
  /** Re-render on the next animation frame (many keystrokes → one render). */
  function schedulePreview() {
    if (state.previewFrame) return;
    state.previewFrame = requestAnimationFrame(() => {
      state.previewFrame = 0;
      renderPreview();
    });
  }

  /** Rebuild the resume paper from state. */
  function renderPreview() {
    if (state.previewFrame) cancelAnimationFrame(state.previewFrame);
    state.previewFrame = 0;
    const resume = state.resume;
    applyDesign(resume.design);
    const parts = isResumeEmpty(resume) ? [renderPlaceholder()] : renderResumeParts(resume);
    els.resume.replaceChildren(...parts);
    updatePageLayout();
  }

  /** Template class, accent color, paper size and margins. */
  function applyDesign(design) {
    const paper = PAPERS[design.paper];
    els.resume.className = `resume resume--${design.template}`;
    const vars = {
      '--resume-accent': design.accent,
      '--page-w': `${paper.width}mm`,
      '--page-h': `${paper.height}mm`,
      '--margin-y': `${PAGE_MARGIN.y}mm`,
      '--margin-x': `${PAGE_MARGIN.x}mm`,
    };
    Object.entries(vars).forEach(([name, value]) => els.resume.style.setProperty(name, value));
    applyPageStyle(paper);
  }

  /** Header + every non-empty section, in PREVIEW_ORDER. */
  function renderResumeParts(resume) {
    const sections = PREVIEW_ORDER.map((key) => renderSection(key, resume));
    return [renderHeader(resume.profile), ...sections].filter(Boolean);
  }

  /** "Experience" heading + its content, or null when there's no content. */
  function renderSection(key, resume) {
    const body = PROFILE_SECTION_HEADINGS[key]
      ? renderProfileText(key, resume.profile[key])
      : renderEntries(key, resume[key]);
    if (!body) return null;

    const section = el('section', 'r-section');
    const content = el('div', 'r-body');
    content.appendChild(body);
    section.append(
      el('h2', 'r-heading', PROFILE_SECTION_HEADINGS[key] || LIST_SECTIONS[key].heading),
      content,
    );
    return section;
  }

  /** Name, headline and contact line. */
  function renderHeader(profile) {
    const contacts = contactItems(profile);
    if (!profile.fullName.trim() && !profile.headline.trim() && contacts.length === 0) return null;
    const header = el('header', 'r-header');
    if (profile.fullName.trim()) header.appendChild(el('h1', 'r-name', profile.fullName));
    if (profile.headline.trim()) header.appendChild(el('p', 'r-headline', profile.headline));
    if (contacts.length) {
      const list = el('ul', 'r-contact');
      list.append(...contacts.map(createContactItem));
      header.appendChild(list);
    }
    return header;
  }

  /** Contact details that are filled in, with safe links where it makes sense. */
  function contactItems(profile) {
    return [
      { text: profile.email, href: toHref(profile.email, 'email') },
      { text: profile.phone, href: toHref(profile.phone, 'phone') },
      { text: profile.location, href: null },
      { text: displayUrl(profile.website), href: toHref(profile.website, 'url') },
      { text: displayUrl(profile.linkedin), href: toHref(profile.linkedin, 'url') },
    ].filter((item) => item.text.trim());
  }

  /** <li> with a link (kept clickable in the PDF) or plain text. */
  function createContactItem({ text, href }) {
    const item = el('li');
    if (!href) {
      item.textContent = text;
      return item;
    }
    const link = el('a', '', text);
    link.href = href;
    item.appendChild(link);
    return item;
  }

  /** Summary (one paragraph per line) or skills ("Group: a, b" lines). */
  function renderProfileText(key, text) {
    const lines = splitLines(text);
    if (lines.length === 0) return null;
    if (key === 'summary') {
      const fragment = document.createDocumentFragment();
      fragment.append(...lines.map((line) => el('p', 'r-summary', line)));
      return fragment;
    }
    const list = el('ul', 'r-skills');
    list.append(...lines.map(createSkillLine));
    return list;
  }

  /** "Tools: Git, Figma" → <li><span class="r-skill-label">Tools:</span> Git, Figma</li> */
  function createSkillLine(line) {
    const item = el('li');
    const match = /^([^:]{1,40}):\s*(.+)$/.exec(line);
    if (!match) {
      item.textContent = line;
      return item;
    }
    item.append(el('span', 'r-skill-label', `${match[1]}:`), document.createTextNode(` ${match[2]}`));
    return item;
  }

  /** Every non-empty entry of a list section, or null. */
  function renderEntries(key, entries) {
    const section = LIST_SECTIONS[key];
    const filled = entries.filter((entry) => entryHasContent(entry, section));
    if (filled.length === 0) return null;
    const fragment = document.createDocumentFragment();
    fragment.append(...filled.map((entry) => renderEntry(section.preview(entry))));
    return fragment;
  }

  /**
   * One entry on the paper.
   * @param {{title?:string, subtitle?:string[], link?:string, date?:string, bullets?:string}} view
   */
  function renderEntry(view) {
    const article = el('article', 'r-entry');
    const head = el('div', 'r-entry-head');
    const main = el('div');
    if (view.title) main.appendChild(el('h3', 'r-entry-title', view.title));
    const subtitle = renderSubtitle(view);
    if (subtitle) main.appendChild(subtitle);
    head.appendChild(main);
    if (view.date) head.appendChild(el('p', 'r-entry-date', view.date));
    article.appendChild(head);

    const bullets = splitLines(view.bullets);
    if (bullets.length) {
      const list = el('ul', 'r-bullets');
      list.append(...bullets.map((line) => el('li', 'r-bullet', line)));
      article.appendChild(list);
    }
    return article;
  }

  /** "Company · Location" and/or a project link, or null. */
  function renderSubtitle(view) {
    const parts = (view.subtitle || []).map((part) => part.trim()).filter(Boolean);
    const href = view.link ? toHref(view.link, 'url') : null;
    if (parts.length === 0 && !href) return null;
    const line = el('p', 'r-entry-sub', parts.join(' · '));
    if (href) {
      const link = el('a', '', displayUrl(view.link));
      link.href = href;
      if (parts.length) line.append(' · ');
      line.appendChild(link);
    }
    return line;
  }

  /** Shown on the paper until something is filled in (never printed). */
  function renderPlaceholder() {
    const box = el('div', 'r-placeholder no-print');
    const button = el('button', 'btn', 'load example');
    button.type = 'button';
    button.dataset.sample = '';
    box.append(
      el('p', '', 'Your resume appears here as you type.'),
      el('p', '', 'Start with your name, or see a finished example:'),
      button,
    );
    return box;
  }

  /* ==========================================================================
     11  PREVIEW: SCALING & PAGE BREAKS
     The paper is drawn at its real size (mm) and scaled down to fit the
     stage. Dashed lines show roughly where each new PDF page will start.
     ========================================================================== */
  /** Fit the paper to the stage and redraw page-break markers. */
  function updatePageLayout() {
    const paper = PAPERS[state.resume.design.paper];
    const pageWidth = paper.width * MM_TO_PX;
    const stageStyle = getComputedStyle(els.previewStage);
    const available =
      els.previewStage.clientWidth - parseFloat(stageStyle.paddingLeft) - parseFloat(stageStyle.paddingRight);
    if (available <= 0) return; // preview is hidden (phone "edit" tab) — redone when shown

    const scale = Math.min(1, available / pageWidth);
    const height = els.resume.offsetHeight; // unaffected by the transform
    els.resume.style.transform = `scale(${scale})`;
    els.pageScaler.style.width = `${pageWidth * scale}px`;
    els.pageScaler.style.height = `${height * scale}px`;
    updatePageBreaks(paper, height);
  }

  /** Approximate number of PDF pages for a paper of this height (px). */
  function countPages(paper, height) {
    const marginY = PAGE_MARGIN.y * MM_TO_PX;
    const usable = (paper.height - 2 * PAGE_MARGIN.y) * MM_TO_PX;
    return Math.max(1, Math.ceil((height - 2 * marginY - 1) / usable));
  }

  /** Dashed "page 2" lines on the paper, plus the page counter. */
  function updatePageBreaks(paper, height) {
    els.resume.querySelectorAll('.page-break').forEach((line) => line.remove());
    const pages = countPages(paper, height);
    const marginY = PAGE_MARGIN.y * MM_TO_PX;
    const usable = (paper.height - 2 * PAGE_MARGIN.y) * MM_TO_PX;
    for (let page = 1; page < pages; page += 1) {
      const line = el('div', 'page-break');
      line.setAttribute('aria-hidden', 'true');
      line.dataset.label = `page ${page + 1} ≈`;
      line.style.top = `${marginY + page * usable}px`;
      els.resume.appendChild(line);
    }
    els.pageCount.textContent = `${pages} ${pages === 1 ? 'page' : 'pages'}${pages > 2 ? ' · aim for 1–2' : ''}`;
    els.pageCount.classList.toggle('page-count--warn', pages > 2);
  }

  /** Keep the paper fitted when the window or panel size changes. */
  function observePreviewSize() {
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => updatePageLayout()).observe(els.previewStage);
    } else {
      window.addEventListener('resize', updatePageLayout);
    }
    // Web fonts change text height once they arrive.
    if (document.fonts) document.fonts.ready.then(updatePageLayout);
  }

  /* ==========================================================================
     12  PDF (print)
     The browser's print window turns the paper into a PDF. Print CSS
     (style.css section 16) hides the app around it; the @page rule written
     here sets the paper size and the margins of every page.
     ========================================================================== */
  let titleBeforePrint = document.title;

  /** Write the @page rule for the chosen paper. */
  function applyPageStyle(paper) {
    els.pageStyle.textContent = `@page { size: ${paper.size}; margin: ${PAGE_MARGIN.y}mm ${PAGE_MARGIN.x}mm; }`;
  }

  /** "save PDF" button: show tips first (until dismissed for good), then print. */
  function requestPdf() {
    if (isResumeEmpty(state.resume)) {
      showToast('Add your details first — or load the example');
      return;
    }
    if (readStorage(STORAGE_KEYS.pdfTipSeen) === '1') {
      startPrint();
      return;
    }
    els.pdfPaperName.textContent = PAPERS[state.resume.design.paper].label;
    els.pdfTipSkip.checked = false;
    openDialog(els.pdfDialog);
  }

  /** "open print window" in the tips dialog. */
  function continueToPrint() {
    if (els.pdfTipSkip.checked) writeStorage(STORAGE_KEYS.pdfTipSeen, '1');
    els.pdfDialog.close();
    // Let the dialog close (and focus return) before the print window takes over.
    setTimeout(startPrint, 50);
  }

  /** Open the browser's print window. */
  function startPrint() {
    flushPendingSave();
    try {
      window.print();
    } catch (error) {
      console.error('Vitae: print failed', error);
      showToast('Could not open the print window — try Ctrl/⌘ P');
    }
  }

  /** Before printing (button or Ctrl/⌘ P): freshest preview + a good PDF file name. */
  function handleBeforePrint() {
    renderPreview();
    titleBeforePrint = document.title;
    document.title = pdfFileName(); // browsers use the page title as the default file name
  }

  /** Print window closed: put the page title back. */
  function handleAfterPrint() {
    document.title = titleBeforePrint;
  }

  /** "Alex Rivera" → "Alex_Rivera_Resume" (letters and digits in any language are kept). */
  function pdfFileName() {
    const name = state.resume.profile.fullName
      .trim()
      .replace(/[^\p{L}\p{N}]+/gu, '_')
      .replace(/^_+|_+$/g, '');
    return `${name || 'My'}_Resume`;
  }

  /* ==========================================================================
     13  DATA MENU (example, import, export, clear)
     ========================================================================== */
  /** Open/close the data menu. */
  function toggleDataMenu(open) {
    els.dataMenu.hidden = !open;
    els.dataBtn.setAttribute('aria-expanded', String(open));
  }

  /** Close the menu and return focus to its button (so dialogs restore focus correctly). */
  function closeDataMenuAndFocus() {
    toggleDataMenu(false);
    els.dataBtn.focus();
  }

  /** Clicking outside an open menu closes it. */
  function handleOutsideClick(event) {
    if (!els.dataMenu.hidden && !event.target.closest('.menu')) toggleDataMenu(false);
  }

  /** Ask before replacing a non-empty resume. */
  function confirmReplace(title, message, confirmLabel) {
    if (isResumeEmpty(state.resume)) return Promise.resolve(true);
    return confirmAction({ title, message, confirmLabel });
  }

  /** data → load example */
  async function loadSample() {
    closeDataMenuAndFocus();
    const ok = await confirmReplace(
      'Load the example?',
      'This replaces everything you have entered with a sample resume. Export a .json backup first if you want to keep it.',
      'load example',
    );
    if (!ok) return;
    setResume(sampleResume());
    showToast('Example loaded — edit it to make it yours');
  }

  /** data → export .json (a backup that can be imported later). */
  function exportJson() {
    closeDataMenuAndFocus();
    const backup = { app: 'vitae', version: 1, exportedAt: new Date().toISOString() };
    backup.resume = serializeResume(state.resume);
    if (downloadFile(`${pdfFileName()}.json`, JSON.stringify(backup, null, 2), 'application/json')) {
      showToast('Backup downloaded');
    }
  }

  /** data → import .json: open the file picker. */
  function startImport() {
    closeDataMenuAndFocus();
    els.importInput.value = ''; // so picking the same file again still fires "change"
    els.importInput.click();
  }

  /** A file was picked: validate it, confirm, then load it. */
  async function handleImportFile() {
    const file = els.importInput.files[0];
    if (!file) return;
    try {
      const resume = await readResumeFile(file);
      const ok = await confirmReplace(
        'Import this file?',
        `This replaces your current resume with "${file.name}".`,
        'import',
      );
      if (!ok) return;
      setResume(resume);
      showToast('Resume imported');
    } catch (error) {
      console.error('Vitae: import failed', error);
      showToast(error.userMessage || 'That file could not be imported');
    }
  }

  /** Parse and validate a backup file. Throws an error with a userMessage. */
  async function readResumeFile(file) {
    if (file.size > MAX_IMPORT_BYTES) throw userError('That file is too large to be a Vitae backup');
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (error) {
      throw userError('That file is not valid JSON', error);
    }
    const raw = isPlainObject(data) && isPlainObject(data.resume) ? data.resume : data;
    if (!isPlainObject(raw) || !isPlainObject(raw.profile)) {
      throw userError('That file is not a Vitae resume backup');
    }
    return normalizeResume(raw);
  }

  /** An Error carrying a message that is safe to show to the user. */
  function userError(message, cause) {
    const error = new Error(message, cause ? { cause } : undefined);
    error.userMessage = message;
    return error;
  }

  /** data → clear all (keeps the design settings). */
  async function clearAll() {
    closeDataMenuAndFocus();
    if (isResumeEmpty(state.resume)) {
      showToast('Nothing to clear');
      return;
    }
    const ok = await confirmAction({
      title: 'Clear everything?',
      message:
        'This deletes your resume from this browser. Export a .json backup first if you might need it.',
      confirmLabel: 'clear all',
    });
    if (!ok) return;
    setResume(normalizeResume({ design: state.resume.design }));
    showToast('Resume cleared');
  }

  /* ==========================================================================
     14  DIALOGS (shared + confirm)
     Native <dialog>.showModal() gives Esc-to-close and a focus trap.
     Added here: backdrop click, [data-close] buttons, focus restore.
     ========================================================================== */
  const returnFocus = new WeakMap();

  /** Open a dialog as modal and remember where focus should return. */
  function openDialog(dialog) {
    if (dialog.open) return;
    returnFocus.set(dialog, document.activeElement);
    dialog.showModal();
    const body = dialog.querySelector('.dialog-body');
    if (body) body.scrollTop = 0;
  }

  /** Shared behaviour for every dialog: close buttons, backdrop click, focus restore. */
  function bindDialog(dialog) {
    dialog.addEventListener('click', (event) => {
      // The dialog has no padding, so a click on the dialog itself is a backdrop click.
      if (event.target === dialog || event.target.closest('[data-close]')) dialog.close();
    });
    dialog.addEventListener('close', () => {
      const previous = returnFocus.get(dialog);
      if (previous && document.contains(previous) && typeof previous.focus === 'function') previous.focus();
      returnFocus.delete(dialog);
    });
  }

  /**
   * Ask a yes/no question. Resolves true only for the confirm button
   * (cancel, Esc and backdrop click all resolve false).
   * @param {{title:string, message:string, confirmLabel:string}} options
   * @returns {Promise<boolean>}
   */
  function confirmAction({ title, message, confirmLabel }) {
    const dialog = els.confirmDialog;
    els.confirmTitle.textContent = title;
    els.confirmMessage.textContent = message;
    els.confirmOkBtn.textContent = confirmLabel;
    dialog.returnValue = ''; // returnValue survives between openings — reset it
    openDialog(dialog);
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    });
  }

  /** Open the help guide. */
  function openHelp() {
    openDialog(els.helpDialog);
  }

  /* ==========================================================================
     15  PHONE TABS (Edit / Preview) — WAI-ARIA tabs pattern
     On desktop (≥1000px) the tabs are hidden and both panels show.
     ========================================================================== */
  /** Show the "edit" or "preview" panel. */
  function selectTab(name) {
    const showPreview = name === 'preview';
    setTabState(els.tabEdit, !showPreview);
    setTabState(els.tabPreview, showPreview);
    els.editorPanel.classList.toggle('is-hidden', showPreview);
    els.previewPanel.classList.toggle('is-hidden', !showPreview);
    if (showPreview) updatePageLayout();
  }

  /** aria-selected + roving tabindex for one tab. */
  function setTabState(tab, selected) {
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }

  /** ←/→/Home/End move between the two tabs. */
  function handleTabKeys(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const goPreview = event.key === 'End' || (event.key !== 'Home' && event.currentTarget === els.tabEdit);
    selectTab(goPreview ? 'preview' : 'edit');
    (goPreview ? els.tabPreview : els.tabEdit).focus();
  }

  /* ==========================================================================
     16  TOAST & SCREEN-READER ANNOUNCEMENTS
     ========================================================================== */
  // With the Popover API the toast sits in the top layer, above open dialogs.
  const supportsPopover = typeof HTMLElement.prototype.showPopover === 'function';
  let toastTimer = 0;

  /** Show a short message at the bottom of the screen (and announce it). */
  function showToast(message) {
    els.toast.textContent = message;
    setToastVisible(false); // re-open so it restarts the animation and stacks on top
    setToastVisible(true);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToastVisible(false), TOAST_MS);
    announce(message);
  }

  /** Show/hide the toast — via the Popover API when supported, else the hidden attribute. */
  function setToastVisible(visible) {
    const toast = els.toast;
    if (!supportsPopover) {
      toast.hidden = !visible;
      return;
    }
    const isOpen = toast.matches(':popover-open');
    if (visible && !isOpen) toast.showPopover();
    if (!visible && isOpen) toast.hidePopover();
  }

  /**
   * Read a message to screen-reader users. While a modal dialog is open,
   * content outside it is hidden from assistive tech, so the message goes to
   * that dialog's own status line.
   */
  function announce(message) {
    const openDialogEl = document.querySelector('dialog[open]');
    const region = (openDialogEl && openDialogEl.querySelector('.dialog-status')) || els.announcer;
    region.textContent = '';
    // A short delay makes repeated identical messages announce again.
    setTimeout(() => {
      region.textContent = message;
    }, 50);
  }

  /* ==========================================================================
     17  THEME (app interface only — the resume paper is always white)
     ========================================================================== */
  /** Saved theme, or "auto" when missing/unknown. */
  function readTheme() {
    const saved = readStorage(STORAGE_KEYS.theme);
    return THEMES.includes(saved) ? saved : 'auto';
  }

  /** Apply a theme to the page, browser bar and theme button. */
  function applyTheme(theme) {
    state.theme = theme;
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);

    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
      if (!meta.dataset.default) meta.dataset.default = meta.content;
      meta.content = THEME_BAR_COLORS[theme] || meta.dataset.default;
    });
    const next = nextTheme(theme);
    els.themeBtn.replaceChildren(svgIcon(`theme-${theme}`));
    els.themeBtn.setAttribute('aria-label', `Theme: ${theme}. Switch to ${next}`);
    els.themeBtn.title = `Theme: ${theme} (click for ${next})`;
  }

  /** auto → light → dark → auto */
  function nextTheme(theme) {
    return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  }

  /** Theme button: switch to the next theme and remember it. */
  function cycleTheme() {
    const theme = nextTheme(state.theme);
    applyTheme(theme);
    writeStorage(STORAGE_KEYS.theme, theme);
    showToast(`Theme: ${theme}`);
  }

  /* ==========================================================================
     18  KEYBOARD SHORTCUTS
     Keep this list in sync with the help guide (index.html) and README.
     ========================================================================== */
  /** Global keydown. */
  function handleShortcuts(event) {
    const dialogOpen = Boolean(document.querySelector('dialog[open]'));
    if (event.key === 'Escape' && !els.dataMenu.hidden) {
      closeDataMenuAndFocus();
      return;
    }
    if (dialogOpen || event.altKey) return;
    if (handleModifierKeys(event)) return;
    if (event.key === '?' && !isTypingTarget(event.target)) {
      event.preventDefault();
      openHelp();
    }
  }

  /**
   * Ctrl/⌘ P → our PDF flow (tips + checks) instead of a raw print.
   * Ctrl/⌘ S → save now (instead of the browser's "save page").
   * @returns {boolean} true when the key was handled
   */
  function handleModifierKeys(event) {
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey) return false;
    const key = event.key.toLowerCase();
    if (key === 'p') {
      event.preventDefault();
      requestPdf();
      return true;
    }
    if (key === 's') {
      event.preventDefault();
      saveNow();
      showToast('Saved — Vitae also saves automatically as you type');
      return true;
    }
    return false;
  }

  /* ==========================================================================
     19  INIT
     ========================================================================== */
  /** Wire every listener, grouped by area of the page. */
  function bindEvents() {
    bindTopbar();
    bindToolbar();
    bindForm();
    bindDialogs();
    document.addEventListener('keydown', handleShortcuts);
    document.addEventListener('click', handleOutsideClick);
    window.addEventListener('beforeprint', handleBeforePrint);
    window.addEventListener('afterprint', handleAfterPrint);
    window.addEventListener('pagehide', flushPendingSave);
  }

  /** Help + theme buttons. */
  function bindTopbar() {
    els.helpBtn.addEventListener('click', openHelp);
    els.themeBtn.addEventListener('click', cycleTheme);
  }

  /** Tabs, data menu and PDF button. */
  function bindToolbar() {
    els.tabEdit.addEventListener('click', () => selectTab('edit'));
    els.tabPreview.addEventListener('click', () => selectTab('preview'));
    [els.tabEdit, els.tabPreview].forEach((tab) => tab.addEventListener('keydown', handleTabKeys));
    els.dataBtn.addEventListener('click', () => toggleDataMenu(els.dataMenu.hidden));
    els.sampleBtn.addEventListener('click', loadSample);
    els.importBtn.addEventListener('click', startImport);
    els.importInput.addEventListener('change', handleImportFile);
    els.exportBtn.addEventListener('click', exportJson);
    els.clearBtn.addEventListener('click', clearAll);
    els.pdfBtn.addEventListener('click', requestPdf);
  }

  /** Form edits (delegated) and the "load example" button on the empty paper. */
  function bindForm() {
    els.form.addEventListener('input', handleFormInput);
    els.form.addEventListener('change', handleFormInput); // older Safari: checkboxes fire only "change"
    els.form.addEventListener('click', handleFormClick);
    els.form.addEventListener('toggle', handleEntryToggle, true);
    els.resume.addEventListener('click', (event) => {
      if (event.target.closest('[data-sample]')) loadSample();
    });
  }

  /** Shared dialog behaviour + PDF tips button. */
  function bindDialogs() {
    [els.confirmDialog, els.pdfDialog, els.helpDialog].forEach(bindDialog);
    els.pdfContinueBtn.addEventListener('click', continueToPrint);
  }

  /** Start the app: restore settings and the saved resume, then wire events. */
  function init() {
    applyTheme(readTheme());
    if (supportsPopover) {
      els.toast.setAttribute('popover', 'manual');
      els.toast.hidden = false; // the popover state controls visibility from now on
    }
    buildAccentOptions();
    applyFieldLimits();

    state.resume = loadResume();
    fillProfileFields();
    fillDesignControls();
    renderAllLists();
    renderPreview();
    if (readStorage(STORAGE_KEYS.resume)) els.saveStatus.textContent = 'saved';

    bindEvents();
    observePreviewSize();
  }

  init();
})();
