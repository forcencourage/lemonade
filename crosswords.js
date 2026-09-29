/* =============================================
   CROSSWORDS MODULE
   Depends on globals from site.js: db, isAdmin, closeCollectionDropdown
   Load this file AFTER site.js.
   ============================================= */
(() => {
  'use strict';

  /* ---------- Config ---------- */
  const STORAGE_KEY  = 'blog_crossword';
  const VGRID        = 45;   // virtual grid used while generating (cropped afterwards)
  const MAX_WORDS    = 16;   // words drawn from the vocabulary per grid
  const MIN_PLACED   = 3;    // minimum words needed for a valid grid
  const ATTEMPTS     = 80;   // random restarts of the generator
  const MIN_LETTERS  = 3;
  const MAX_CELLS    = 20;   // longest entry, black boxes included
  const ACROSS = 'across';
  const DOWN   = 'down';

  /* ---------- State ---------- */
  let overlay, box, gridEl, gridWrap, messageEl, inputEl;
  let subEl, barEl, activeClueEl, listAcross, listDown;
  let generateBtn, revealBtn;

  let puzzle = null;           // { rows, cols, grid, entries, placements, complete }
  let active = { r: 0, c: 0, dir: ACROSS };
  let busy = false;
  let lastScrolledEntry = null;

  /* =============================================
     TEXT HELPERS
     ============================================= */
  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function normalize(str) {
    return String(str || '')
      .replace(/œ/gi, 'oe').replace(/æ/gi, 'ae').replace(/ß/g, 'ss')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toUpperCase();
  }

  /**
   * Turns a vocabulary word into grid cells.
   * "ice cream" → cells I,C,E,null,C,R,E,A,M — `null` is a black box.
   * Enumeration mirrors the original separators: (3,5) (4-3) (1'3)
   */
  function parseWord(raw) {
    const tokens = normalize(raw).match(/[A-Z0-9]+|[^A-Z0-9]+/g) || [];
    const parts = [];
    const seps = [];
    let pending = null;

    for (const t of tokens) {
      if (/^[A-Z0-9]+$/.test(t)) {
        if (parts.length) seps.push(pending || ',');
        parts.push(t);
        pending = null;
      } else if (parts.length) {
        pending = t.includes('-') ? '-' : /['’]/.test(t) ? "'" : ',';
      }
    }
    if (!parts.length) return null;

    const cells = [];
    parts.forEach((p, i) => {
      if (i > 0) cells.push(null);
      for (const ch of p) cells.push(ch);
    });

    let en = '';
    parts.forEach((p, i) => { en += (i ? seps[i - 1] : '') + p.length; });

    return { cells, parts, enumStr: `(${en})`, letters: parts.join('').length };
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /* =============================================
     GRID GENERATION
     ============================================= */
  function prepareEntries(rows) {
    const seen = new Set();
    const out = [];
    for (const row of rows) {
      const word = (row.word || '').trim();
      if (!word) continue;
      const parsed = parseWord(word);
      if (!parsed || parsed.letters < MIN_LETTERS || parsed.cells.length > MAX_CELLS) continue;
      const key = parsed.parts.join(' ');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ word, definition: (row.definition || '').trim(), cells: parsed.cells });
    }
    return out;
  }

  function attempt(entries) {
    const N = VGRID;
    const letter  = new Array(N * N).fill(null);
    const blocked = new Uint8Array(N * N);
    const dirs    = new Uint8Array(N * N);
    const letterIdx = [];
    const placed = [];
    const box = { r0: N, r1: -1, c0: N, c1: -1 };
    const bit = d => (d === ACROSS ? 1 : 2);

    function check(e, r0, c0, d) {
      const len = e.cells.length;
      const dr = d === DOWN ? 1 : 0;
      const dc = d === ACROSS ? 1 : 0;
      const r1 = r0 + dr * (len - 1);
      const c1 = c0 + dc * (len - 1);
      if (r0 - dr < 1 || c0 - dc < 1 || r1 + dr > N - 2 || c1 + dc > N - 2) return -1;
      if (r0 < 1 || c0 < 1 || r1 > N - 2 || c1 > N - 2) return -1;

      // Cells right before / after the word must not hold a letter
      if (letter[(r0 - dr) * N + (c0 - dc)] || letter[(r1 + dr) * N + (c1 + dc)]) return -1;

      const side = d === ACROSS ? N : 1;
      let cross = 0;
      for (let i = 0; i < len; i++) {
        const idx = (r0 + dr * i) * N + (c0 + dc * i);
        const ch = e.cells[i];
        if (ch === null) {                 // black box: no letter may live here
          if (letter[idx]) return -1;
          continue;
        }
        if (blocked[idx]) return -1;
        if (letter[idx]) {                 // crossing
          if (letter[idx] !== ch || (dirs[idx] & bit(d))) return -1;
          cross++;
        } else if (letter[idx - side] || letter[idx + side]) {
          return -1;                       // would touch a parallel word
        }
      }
      return cross;
    }

    function put(e, r0, c0, d) {
      const len = e.cells.length;
      const dr = d === DOWN ? 1 : 0;
      const dc = d === ACROSS ? 1 : 0;
      for (let i = 0; i < len; i++) {
        const idx = (r0 + dr * i) * N + (c0 + dc * i);
        const ch = e.cells[i];
        if (ch === null) { blocked[idx] = 1; continue; }
        if (!letter[idx]) { letter[idx] = ch; letterIdx.push(idx); }
        dirs[idx] |= bit(d);
      }
      const r1 = r0 + dr * (len - 1);
      const c1 = c0 + dc * (len - 1);
      box.r0 = Math.min(box.r0, r0); box.r1 = Math.max(box.r1, r1);
      box.c0 = Math.min(box.c0, c0); box.c1 = Math.max(box.c1, c1);
      placed.push({ e, r: r0, c: c0, d });
    }

    function bestSpot(e) {
      let best = null;
      const seen = new Set();
      for (const idx of letterIdx) {
        const L = letter[idx];
        const r = Math.floor(idx / N);
        const c = idx % N;
        for (let k = 0; k < e.cells.length; k++) {
          if (e.cells[k] !== L) continue;
          for (const d of [ACROSS, DOWN]) {
            if (dirs[idx] & bit(d)) continue;
            const r0 = d === DOWN ? r - k : r;
            const c0 = d === ACROSS ? c - k : c;
            const key = r0 + ',' + c0 + ',' + d;
            if (seen.has(key)) continue;
            seen.add(key);
            const cr = check(e, r0, c0, d);
            if (cr < 1) continue;

            const len = e.cells.length;
            const r1 = r0 + (d === DOWN ? len - 1 : 0);
            const c1 = c0 + (d === ACROSS ? len - 1 : 0);
            const h = Math.max(box.r1, r1) - Math.min(box.r0, r0) + 1;
            const w = Math.max(box.c1, c1) - Math.min(box.c0, c0) + 1;
            const score = cr * 6 - h * w * 0.12 - Math.abs(h - w) * 0.8 + Math.random() * 2.5;
            if (!best || score > best.score) best = { r0, c0, d, score };
          }
        }
      }
      return best;
    }

    // Longest first, with a little noise so every restart differs
    const order = entries
      .map(e => ({ e, k: e.cells.length + Math.random() * 5 }))
      .sort((a, b) => b.k - a.k)
      .map(x => x.e);

    const first = order.shift();
    put(first, Math.floor(N / 2), Math.floor((N - first.cells.length) / 2), ACROSS);

    let remaining = order;
    for (let pass = 0; pass < 3 && remaining.length; pass++) {
      const next = [];
      let progress = false;
      for (const e of remaining) {
        const spot = bestSpot(e);
        if (spot) { put(e, spot.r0, spot.c0, spot.d); progress = true; }
        else next.push(e);
      }
      remaining = next;
      if (!progress) break;
    }

    const h = box.r1 - box.r0 + 1;
    const w = box.c1 - box.c0 + 1;
    return { placed, h, w, quality: placed.length * 100 - h * w * 0.3 - Math.abs(h - w) };
  }

  function buildPlacements(rows) {
    const entries = prepareEntries(rows);
    if (entries.length < MIN_PLACED) return null;

    const pool = shuffle(entries).slice(0, MAX_WORDS);
    let best = null;
    for (let i = 0; i < ATTEMPTS; i++) {
      const res = attempt(pool);
      if (!best || res.quality > best.quality) best = res;
    }
    if (!best || best.placed.length < MIN_PLACED) return null;

    const minR = Math.min(...best.placed.map(p => p.r));
    const minC = Math.min(...best.placed.map(p => p.c));
    return best.placed.map(p => ({
      word: p.e.word,
      definition: p.e.definition,
      r: p.r - minR,
      c: p.c - minC,
      dir: p.d
    }));
  }

  /* =============================================
     PUZZLE MODEL
     ============================================= */
  function setupPuzzle(placements, answers = {}, revealed = []) {
    const entries = placements.map((p, i) => {
      const parsed = parseWord(p.word);
      return {
        id: i, word: p.word, definition: p.definition || '',
        dir: p.dir, r: p.r, c: p.c,
        letters: parsed.cells, enumStr: parsed.enumStr,
        cells: [], num: 0, solved: false, el: null
      };
    });

    let rows = 0, cols = 0;
    entries.forEach(e => {
      const len = e.letters.length;
      rows = Math.max(rows, e.r + (e.dir === DOWN ? len : 1));
      cols = Math.max(cols, e.c + (e.dir === ACROSS ? len : 1));
    });

    const grid = Array.from({ length: rows }, () => Array(cols).fill(null));

    entries.forEach(e => {
      e.letters.forEach((ch, i) => {
        if (ch === null) { e.cells.push(null); return; }
        const r = e.r + (e.dir === DOWN ? i : 0);
        const c = e.c + (e.dir === ACROSS ? i : 0);
        let cell = grid[r][c];
        if (!cell) {
          cell = grid[r][c] = {
            r, c, letter: ch, value: '', revealed: false, num: 0,
            entries: { across: null, down: null },
            el: null, valEl: null
          };
        }
        cell.entries[e.dir] = e;
        e.cells.push(cell);
      });
    });

    // Clue numbers, in reading order
    let n = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = grid[r][c];
        if (!cell) continue;
        const starts = [cell.entries.across, cell.entries.down].filter(en => en && en.cells[0] === cell);
        if (starts.length) {
          cell.num = ++n;
          starts.forEach(en => { en.num = cell.num; });
        }
      }
    }

    // Restore saved answers
    Object.entries(answers).forEach(([k, v]) => {
      const [r, c] = k.split(',').map(Number);
      const cell = grid[r]?.[c];
      if (cell && typeof v === 'string') cell.value = v.slice(0, 1);
    });
    revealed.forEach(k => {
      const [r, c] = k.split(',').map(Number);
      const cell = grid[r]?.[c];
      if (cell && cell.value) cell.revealed = true;
    });

    // Positions of the black boxes separating sub-words of an expression
    const gaps = new Set();
    entries.forEach(e => {
      e.letters.forEach((ch, i) => {
        if (ch !== null) return;
        const r = e.r + (e.dir === DOWN ? i : 0);
        const c = e.c + (e.dir === ACROSS ? i : 0);
        gaps.add(r + ',' + c);
      });
    });

    puzzle = { rows, cols, grid, entries, placements, gaps, complete: false };

    const first = entries.slice().sort((a, b) => a.num - b.num || (a.dir === ACROSS ? -1 : 1))[0];
    const start = first.cells.find(c => c && !c.value) || first.cells[0];
    active = { r: start.r, c: start.c, dir: first.dir };
    lastScrolledEntry = null;

    hideMessage();
    renderGrid();
    renderClues();
    fit();
    refresh(false);
  }

  const EYE_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';

  const curCell = () => puzzle.grid[active.r][active.c];

  function activeEntry() {
    const cell = curCell();
    return cell.entries[active.dir] || cell.entries.across || cell.entries.down;
  }

  /* =============================================
     RENDERING
     ============================================= */
  function renderGrid() {
    gridEl.innerHTML = '';
    gridEl.style.setProperty('--cols', puzzle.cols);

    for (let r = 0; r < puzzle.rows; r++) {
      for (let c = 0; c < puzzle.cols; c++) {
        const cell = puzzle.grid[r][c];
        const el = document.createElement('div');

        if (!cell) {
          el.className = puzzle.gaps.has(r + ',' + c) ? 'cw-cell cw-sep' : 'cw-cell cw-black';
        } else {
          el.className = 'cw-cell';
          el.dataset.r = r;
          el.dataset.c = c;
          if (cell.num) {
            const num = document.createElement('span');
            num.className = 'cw-num';
            num.textContent = cell.num;
            el.appendChild(num);
          }
          const val = document.createElement('span');
          val.className = 'cw-letter';
          el.appendChild(val);
          el.addEventListener('animationend', () => el.classList.remove('cw-pop'));
          cell.el = el;
          cell.valEl = val;
        }
        gridEl.appendChild(el);
      }
    }
  }

  function renderClues() {
    [[ACROSS, listAcross], [DOWN, listDown]].forEach(([dir, list]) => {
      list.innerHTML = '';
      const items = puzzle.entries.filter(e => e.dir === dir).sort((a, b) => a.num - b.num);
      list.parentElement.classList.toggle('cw-hidden', !items.length);

      items.forEach(e => {
        const li = document.createElement('li');
        li.className = 'cw-clue';
        li.innerHTML = `
          <span class="cw-clue-num">${e.num}</span>
          <span class="cw-clue-text">${esc(e.definition || 'No definition')}
            <span class="cw-clue-enum">${esc(e.enumStr)}</span></span>
          <button type="button" class="cw-clue-reveal" title="Reveal this word" aria-label="Reveal this word">${EYE_ICON}</button>`;
        li.addEventListener('click', () => selectEntry(e));
        li.querySelector('.cw-clue-reveal').addEventListener('click', ev => {
          ev.stopPropagation();
          revealEntry(e);
        });
        e.el = li;
        list.appendChild(li);
      });
    });
  }

  function renderEmpty() {
    puzzle = null;
    gridEl.innerHTML = '';
    listAcross.innerHTML = '';
    listDown.innerHTML = '';
    activeClueEl.innerHTML = '';
    activeClueEl.classList.remove('cw-done');
    barEl.style.width = '0%';
    subEl.textContent = 'From your vocabulary';
    box.classList.remove('cw-complete');
    revealBtn.disabled = true;
  }

  function fit() {
    if (!puzzle || !gridWrap.clientWidth) return;
    let size = Math.floor((gridWrap.clientWidth - 16) / puzzle.cols);
    if (window.matchMedia('(min-width: 861px)').matches) {
      size = Math.min(size, Math.floor((gridWrap.clientHeight - 16) / puzzle.rows));
    }
    size = Math.max(26, Math.min(size, 48));
    gridEl.style.setProperty('--cw', size + 'px');
  }

  function refresh(animate = false) {
    if (!puzzle) return;
    const { entries, grid } = puzzle;

    // Which words are solved?
    let solved = 0;
    const newly = [];
    entries.forEach(e => {
      const ok = e.cells.every(c => !c || c.value === c.letter);
      if (ok && !e.solved && animate) newly.push(e);
      e.solved = ok;
      if (ok) solved++;
    });

    const ae = activeEntry();
    const ac = curCell();

    grid.forEach(row => row.forEach(cell => {
      if (!cell) return;
      const en = cell.entries;
      cell.el.classList.toggle('cw-solved', !!((en.across && en.across.solved) || (en.down && en.down.solved)));
      cell.el.classList.toggle('cw-in-word', !!ae && ae.cells.includes(cell));
      cell.el.classList.toggle('cw-active', cell === ac);
      cell.el.classList.toggle('cw-revealed', !!cell.revealed);
      if (cell.valEl.textContent !== cell.value) cell.valEl.textContent = cell.value;
    }));

    newly.forEach(e => {
      e.cells.forEach((c, i) => {
        if (!c) return;
        c.el.style.animationDelay = (i * 40) + 'ms';
        c.el.classList.remove('cw-pop');
        void c.el.offsetWidth;
        c.el.classList.add('cw-pop');
      });
    });

    entries.forEach(e => {
      e.el.classList.toggle('cw-solved', e.solved);
      e.el.classList.toggle('cw-active', e === ae);
    });

    if (ae && ae.el && ae !== lastScrolledEntry && window.matchMedia('(min-width: 861px)').matches) {
      ae.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    lastScrolledEntry = ae;

    // Progress + active clue bar
    puzzle.complete = solved === entries.length;
    box.classList.toggle('cw-complete', puzzle.complete);
    barEl.style.width = (solved / entries.length * 100) + '%';
    subEl.textContent = puzzle.complete
      ? `All ${entries.length} words found`
      : `${solved} of ${entries.length} words found`;
    revealBtn.disabled = puzzle.complete;

    activeClueEl.classList.toggle('cw-done', puzzle.complete);
    if (puzzle.complete) {
      activeClueEl.innerHTML = `<span>Grid complete — press Generate for a new one.</span>`;
    } else if (ae) {
      activeClueEl.innerHTML = `
        <span class="cw-ac-tag">${ae.num} ${ae.dir === ACROSS ? 'Across' : 'Down'}</span>
        <span>${esc(ae.definition || 'No definition')}</span>
        <span class="cw-ac-enum">${esc(ae.enumStr)}</span>
        ${ae.solved ? '' : `<button type="button" class="cw-reveal-word" title="Reveal this word">${EYE_ICON}<span>Reveal word</span></button>`}`;
    }
  }

  /* =============================================
     INTERACTION
     ============================================= */
  function focusInput() {
    resetInput();
    try { inputEl.focus({ preventScroll: true }); } catch { inputEl.focus(); }
  }

  function resetInput() {
    inputEl.value = ' ';
    try { inputEl.setSelectionRange(1, 1); } catch { /* noop */ }
  }

  function selectCell(cell, toggle = false) {
    const same = active.r === cell.r && active.c === cell.c;
    const has = { across: !!cell.entries.across, down: !!cell.entries.down };

    if (same && toggle && has.across && has.down) {
      active.dir = active.dir === ACROSS ? DOWN : ACROSS;
    } else if (!has[active.dir]) {
      active.dir = has.across ? ACROSS : DOWN;
    }
    active.r = cell.r;
    active.c = cell.c;
    refresh();
    focusInput();
  }

  function selectEntry(e) {
    const target = e.cells.find(c => c && !c.value) || e.cells.find(Boolean);
    active = { r: target.r, c: target.c, dir: e.dir };
    refresh();
    focusInput();
  }

  function stepInEntry(step) {
    const e = activeEntry();
    let i = e.cells.indexOf(curCell()) + step;
    while (i >= 0 && i < e.cells.length && !e.cells[i]) i += step;
    return i >= 0 && i < e.cells.length ? e.cells[i] : null;
  }

  function typeChar(ch) {
    const cur = curCell();
    cur.value = ch;
    cur.revealed = false;
    const next = stepInEntry(1);
    if (next) { active.r = next.r; active.c = next.c; }
    refresh(true);
    save();
  }

  function backspace() {
    const cell = curCell();
    if (cell.value) {
      cell.value = '';
      cell.revealed = false;
    } else {
      const prev = stepInEntry(-1);
      if (prev) { active.r = prev.r; active.c = prev.c; prev.value = ''; prev.revealed = false; }
    }
    refresh(true);
    save();
  }

  function moveArrow(dr, dc) {
    let r = active.r + dr;
    let c = active.c + dc;
    while (r >= 0 && r < puzzle.rows && c >= 0 && c < puzzle.cols) {
      const cell = puzzle.grid[r][c];
      if (cell) {
        if (dc !== 0 && cell.entries.across) active.dir = ACROSS;
        else if (dr !== 0 && cell.entries.down) active.dir = DOWN;
        else if (!cell.entries[active.dir]) active.dir = cell.entries.across ? ACROSS : DOWN;
        active.r = r;
        active.c = c;
        refresh();
        return;
      }
      r += dr;
      c += dc;
    }
  }

  function clueOrder() {
    return [
      ...puzzle.entries.filter(e => e.dir === ACROSS).sort((a, b) => a.num - b.num),
      ...puzzle.entries.filter(e => e.dir === DOWN).sort((a, b) => a.num - b.num)
    ];
  }

  function jumpClue(step) {
    const order = [
      ...puzzle.entries.filter(e => e.dir === ACROSS).sort((a, b) => a.num - b.num),
      ...puzzle.entries.filter(e => e.dir === DOWN).sort((a, b) => a.num - b.num)
    ];
    const i = order.indexOf(activeEntry());
    selectEntry(order[(i + step + order.length) % order.length]);
  }

  function onKeyDown(e) {
    if (!overlay || overlay.classList.contains('cw-hidden')) return;

    if (e.key === 'Escape') { closeModal(); return; }
    if (!puzzle || busy) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return;

    switch (e.key) {
      case 'ArrowLeft':  moveArrow(0, -1); break;
      case 'ArrowRight': moveArrow(0, 1);  break;
      case 'ArrowUp':    moveArrow(-1, 0); break;
      case 'ArrowDown':  moveArrow(1, 0);  break;
      case 'Backspace':  backspace(); break;
      case 'Delete': {
        const dc = curCell();
        dc.value = '';
        dc.revealed = false;
        refresh(true);
        save();
        break;
      }
      case 'Tab':
        jumpClue(e.shiftKey ? -1 : 1);
        break;
      case ' ':
        selectCell(curCell(), true);
        break;
      default: {
        if (e.key.length !== 1) return;
        const ch = normalize(e.key)[0];
        if (!ch || !/[A-Z0-9]/.test(ch)) return;
        typeChar(ch);
      }
    }
    e.preventDefault();
  }

  // Mobile virtual keyboards often skip usable keydown events
  function onInput(e) {
    if (puzzle && !busy) {
      if (e.inputType && e.inputType.startsWith('delete')) {
        backspace();
      } else if (e.data) {
        for (const raw of e.data) {
          const ch = normalize(raw)[0];
          if (ch && /[A-Z0-9]/.test(ch)) typeChar(ch);
        }
      }
    }
    resetInput();
  }

  /* =============================================
     PERSISTENCE
     ============================================= */
  function save() {
    if (!puzzle) return;
    const answers = {};
    const revealed = [];
    puzzle.grid.forEach(row => row.forEach(cell => {
      if (!cell || !cell.value) return;
      answers[cell.r + ',' + cell.c] = cell.value;
      if (cell.revealed) revealed.push(cell.r + ',' + cell.c);
    }));
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ placements: puzzle.placements, answers, revealed }));
    } catch { /* storage unavailable */ }
  }

  function loadSaved() {
    try {
      const d = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (d && Array.isArray(d.placements) && d.placements.length) return d;
    } catch { /* corrupted */ }
    return null;
  }

  function clearSaved() {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
  }

  /* =============================================
     ACTIONS
     ============================================= */
  function showMessage(text, spinner = false) {
    messageEl.innerHTML = (spinner ? '<div class="cw-spinner"></div>' : '') + `<p>${esc(text)}</p>`;
    messageEl.classList.remove('cw-hidden');
  }
  function hideMessage() { messageEl.classList.add('cw-hidden'); }

  function hasProgress() {
    return !!puzzle && puzzle.grid.some(row => row.some(c => c && c.value));
  }

  async function fetchVocabulary() {
    const { data, error } = await db.from('vocabulary').select('word, definition');
    if (error) throw error;
    return data || [];
  }

  async function generate() {
    if (busy) return;
    if (puzzle && hasProgress() && !puzzle.complete &&
        !confirm('Discard your current grid and generate a new one?')) return;

    busy = true;
    generateBtn.disabled = true;
    showMessage('Building your grid…', true);

    try {
      const rows = await fetchVocabulary();
      await new Promise(r => setTimeout(r, 40)); // let the loader paint before the CPU-heavy part
      const placements = buildPlacements(rows);

      if (!placements) {
        renderEmpty();
        clearSaved();
        showMessage('Couldn’t build a grid. Add a few more words to your vocabulary (at least 3, sharing some letters) and try again.');
        return;
      }
      setupPuzzle(placements, {});
      save();
      focusInput();
    } catch (err) {
      console.error('[Crosswords] generate failed:', err);
      if (!puzzle) renderEmpty();
      showMessage('Could not load your vocabulary. Check your connection and try again.');
    } finally {
      busy = false;
      generateBtn.disabled = false;
    }
  }

  /** Reveals a single word, then moves on to the next unsolved clue. */
  function revealEntry(e) {
    if (!puzzle || busy || !e || e.solved) return;
    e.cells.forEach(c => {
      if (c && c.value !== c.letter) { c.value = c.letter; c.revealed = true; }
    });
    refresh(true);   // recomputes solved state + plays the yellow pop

    const order = clueOrder();
    const i = order.indexOf(e);
    const next = order.slice(i + 1).concat(order.slice(0, i)).find(x => !x.solved);
    if (next) selectEntry(next);
    else focusInput();
    save();
  }

  function reveal() {
    if (!puzzle || puzzle.complete) return;
    if (!confirm('Reveal all answers?')) return;
    puzzle.grid.forEach(row => row.forEach(c => {
      if (c && c.value !== c.letter) { c.value = c.letter; c.revealed = true; }
    }));
    refresh(true);
    save();
  }

  /* =============================================
     MODAL
     ============================================= */
  function ensureModal() {
    if (overlay) return;

    overlay = document.getElementById('crosswords-modal');
    if (!overlay) {
      console.error('[Crosswords] #crosswords-modal not found in index.html');
      return;
    }

    box          = overlay.querySelector('.cw-box');
    gridEl       = overlay.querySelector('#cw-grid');
    gridWrap     = overlay.querySelector('#cw-grid-wrap');
    messageEl    = overlay.querySelector('#cw-message');
    inputEl      = overlay.querySelector('#cw-input');
    subEl        = overlay.querySelector('#cw-sub');
    barEl        = overlay.querySelector('#cw-bar');
    activeClueEl = overlay.querySelector('#cw-active-clue');
    listAcross   = overlay.querySelector('#cw-clues-across');
    listDown     = overlay.querySelector('#cw-clues-down');
    generateBtn  = overlay.querySelector('#cw-generate');
    revealBtn    = overlay.querySelector('#cw-reveal');
    revealBtn.disabled = true;

    generateBtn.addEventListener('click', generate);
    revealBtn.addEventListener('click', reveal);
    overlay.querySelector('#cw-close').addEventListener('click', closeModal);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

    gridEl.addEventListener('click', e => {
      const el = e.target.closest('.cw-cell');
      if (!el || !el.dataset.r || !puzzle) return;
      selectCell(puzzle.grid[+el.dataset.r][+el.dataset.c], true);
    });

    activeClueEl.addEventListener('click', e => {
      if (e.target.closest('.cw-reveal-word') && puzzle) revealEntry(activeEntry());
    });

    inputEl.addEventListener('input', onInput);
    document.addEventListener('keydown', onKeyDown);

    if ('ResizeObserver' in window) new ResizeObserver(fit).observe(gridWrap);
    window.addEventListener('resize', fit);
  }

  function openModal() {
    if (typeof isAdmin !== 'undefined' && !isAdmin) return;
    ensureModal();
    overlay.classList.remove('cw-hidden');
    document.body.style.overflow = 'hidden';

    if (puzzle) { fit(); focusInput(); return; }

    const saved = loadSaved();
    if (saved) {
      try {
        setupPuzzle(saved.placements, saved.answers || {}, saved.revealed || []);
        focusInput();
        return;
      } catch (err) {
        console.warn('[Crosswords] could not restore saved grid:', err);
        clearSaved();
      }
    }
    generate();
  }

  function closeModal() {
    if (!overlay) return;
    overlay.classList.add('cw-hidden');
    document.body.style.overflow = '';
  }

  /* =============================================
     DROPDOWN BUTTON (markup lives in index.html)
     ============================================= */
  function bindDropdownButton() {
    const btn = document.getElementById('collection-dropdown-crosswords');
    if (!btn) {
      console.error('[Crosswords] #collection-dropdown-crosswords not found in index.html');
      return;
    }
    btn.addEventListener('click', () => {
      if (typeof closeCollectionDropdown === 'function') closeCollectionDropdown();
      openModal();
    });
  }

  function init() {
    bindDropdownButton();
    // Reset everything if the user signs out mid-session
    if (typeof db !== 'undefined') {
      db.auth.onAuthStateChange((_e, session) => {
        if (!session) { closeModal(); puzzle = null; }
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();