/* =============================================
   EPHEMERA
   Depends on globals from site.js: db, isAdmin, currentUsername
   ============================================= */
let ephemeraNotes     = [];
let ephemeraActiveId  = null;
let ephemeraDirty     = false;
let ephemeraSaveTimer = null;
let ephemeraSaveQueue = Promise.resolve();   // serialises all DB writes
let ephemeraDragId    = null;
let ephemeraCreating  = false;

const EPHEMERA_INDENT    = '  ';
const EPHEMERA_AUTOSAVE  = 1200; // ms after last keystroke
const PIN_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 3a1 1 0 0 1 .7 1.7L15.4 6l1.6 5.2 2 1.8a1 1 0 0 1-.7 1.7H13v5l-1 2-1-2v-5H5.7A1 1 0 0 1 5 13l2-1.8L8.6 6 7.3 4.7A1 1 0 0 1 8 3h8z"/></svg>';

const ephemeraModal      = document.getElementById('ephemera-modal');
const ephemeraCloseBtn   = document.getElementById('ephemera-close');
const ephemeraListEl     = document.getElementById('ephemera-list');
const ephemeraNewBtn     = document.getElementById('ephemera-new-btn');
const ephemeraTitleInput = document.getElementById('ephemera-title-input');
const ephemeraTextarea   = document.getElementById('ephemera-textarea');
const ephemeraSaveBtn    = document.getElementById('ephemera-save-btn');
const ephemeraDeleteBtn  = document.getElementById('ephemera-delete-btn');
const ephemeraStatusEl   = document.getElementById('ephemera-status');

// Pin button (created here so no HTML change is needed)
const ephemeraPinBtn = document.createElement('button');
ephemeraPinBtn.id = 'ephemera-pin-btn';
ephemeraPinBtn.type = 'button';
ephemeraPinBtn.className = 'ephemera-icon-btn';
ephemeraPinBtn.innerHTML = PIN_SVG;
ephemeraDeleteBtn.before(ephemeraPinBtn);

/* ---------- helpers ---------- */
const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const findEphemeraNote = id => ephemeraNotes.find(n => sameId(n.id, id));
const activeEphemeraNote = () => findEphemeraNote(ephemeraActiveId);

function updateEphemeraStatus(text) { ephemeraStatusEl.textContent = text; }

function sortEphemeraNotes() {
  ephemeraNotes.sort((a, b) =>
    (Number(!!b.pinned) - Number(!!a.pinned)) ||
    ((a.sort_order || 0) - (b.sort_order || 0)) ||
    (new Date(b.updated_at) - new Date(a.updated_at))
  );
}

function queueEphemeraDb(task) {
  ephemeraSaveQueue = ephemeraSaveQueue.then(task).catch(err =>
    console.error('[Ephemera] queue error:', err));
  return ephemeraSaveQueue;
}

function syncEphemeraControls() {
  const note = activeEphemeraNote();
  const pinned = !!note?.pinned;
  ephemeraPinBtn.disabled    = !note;
  ephemeraDeleteBtn.disabled = !note;
  ephemeraSaveBtn.disabled   = !note;
  ephemeraPinBtn.classList.toggle('active', pinned);
  ephemeraPinBtn.setAttribute('aria-pressed', String(pinned));
  ephemeraPinBtn.title = pinned ? 'Unpin note' : 'Pin note to top';
  ephemeraPinBtn.setAttribute('aria-label', ephemeraPinBtn.title);
}

function showEphemeraEmptyState() {
  ephemeraActiveId = null;
  ephemeraDirty = false;
  ephemeraTitleInput.value = '';
  ephemeraTextarea.value   = '';
  ephemeraTitleInput.disabled = true;
  ephemeraTextarea.disabled   = true;
  updateEphemeraStatus('');
  syncEphemeraControls();
  renderEphemeraList();
}

/* ---------- open / close ---------- */
async function openEphemeraModal() {
  if (!isAdmin) return;
  ephemeraActiveId = null;
  ephemeraDirty = false;
  ephemeraModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  await loadEphemeraNotes();
}

function closeEphemeraModal() {
  leaveActiveEphemeraNote();            // autosave (+ drop blank note)
  ephemeraModal.classList.add('hidden');
  document.body.style.overflow = '';
  ephemeraActiveId = null;
  ephemeraDirty = false;
}

/* ---------- load / render ---------- */
async function loadEphemeraNotes() {
  ephemeraListEl.innerHTML = '<li class="ephemera-loading">Loading…</li>';
  const { data, error } = await db
    .from('ephemera_notes')
    .select('id, title, content, updated_at, pinned, sort_order')
    .eq('author', currentUsername);

  if (error) {
    console.error('[Ephemera] load error:', error);
    ephemeraListEl.innerHTML = '<li class="ephemera-empty">Could not load notes.</li>';
    return;
  }

  ephemeraNotes = data || [];
  sortEphemeraNotes();

  if (ephemeraNotes.length) {
    renderEphemeraList();
    selectEphemeraNote(ephemeraNotes[0].id);
  } else {
    showEphemeraEmptyState();
  }
}

function renderEphemeraList() {
  const scroll = ephemeraListEl.scrollTop;
  ephemeraListEl.innerHTML = '';

  if (!ephemeraNotes.length) {
    ephemeraListEl.innerHTML = '<li class="ephemera-empty">No notes yet.</li>';
    return;
  }

  const pinnedCount = ephemeraNotes.filter(n => n.pinned).length;

  ephemeraNotes.forEach((note, i) => {
    if (pinnedCount && i === pinnedCount) {
      const divider = document.createElement('li');
      divider.className = 'ephemera-divider';
      divider.setAttribute('role', 'separator');
      ephemeraListEl.appendChild(divider);
    }

    const li = document.createElement('li');
    li.className = 'ephemera-list-item'
      + (sameId(note.id, ephemeraActiveId) ? ' active' : '')
      + (note.pinned ? ' pinned' : '');
    li.dataset.id = note.id;
    li.draggable = true;
    li.tabIndex = 0;

    if (note.pinned) {
      const pin = document.createElement('span');
      pin.className = 'ephemera-pin-icon';
      pin.innerHTML = PIN_SVG;
      li.appendChild(pin);
    }
    const title = document.createElement('span');
    title.className = 'ephemera-item-title';
    title.textContent = note.title?.trim() || 'Untitled';
    li.appendChild(title);

    li.addEventListener('click', () => selectEphemeraNote(note.id));
    li.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectEphemeraNote(note.id); }
    });
    ephemeraListEl.appendChild(li);
  });

  ephemeraListEl.scrollTop = scroll;
}

/* ---------- select / leave ---------- */
function selectEphemeraNote(id) {
  if (sameId(id, ephemeraActiveId)) return;
  leaveActiveEphemeraNote();            // autosave the note we're leaving

  const note = findEphemeraNote(id);
  if (!note) return;
  ephemeraActiveId = note.id;
  ephemeraTitleInput.disabled = false;
  ephemeraTextarea.disabled   = false;
  ephemeraTitleInput.value = note.title   || '';
  ephemeraTextarea.value   = note.content || '';
  ephemeraDirty = false;
  updateEphemeraStatus('');
  syncEphemeraControls();
  renderEphemeraList();
}

function leaveActiveEphemeraNote() {
  const prev = activeEphemeraNote();
  if (!prev) return;
  saveEphemeraNote();
  // Don't leave empty notes lying around
  if (!prev.title?.trim() && !prev.content?.trim()) {
    ephemeraNotes = ephemeraNotes.filter(n => n !== prev);
    queueEphemeraDb(async () => {
      const { error } = await db.from('ephemera_notes').delete().eq('id', prev.id);
      if (error) console.error('[Ephemera] cleanup error:', error);
    });
  }
}

/* ---------- autosave ---------- */
function markEphemeraDirty() {
  ephemeraDirty = true;
  updateEphemeraStatus('Unsaved changes');
  clearTimeout(ephemeraSaveTimer);
  ephemeraSaveTimer = setTimeout(saveEphemeraNote, EPHEMERA_AUTOSAVE);
}

function saveEphemeraNote() {
  clearTimeout(ephemeraSaveTimer);
  const note = activeEphemeraNote();
  if (!note || !ephemeraDirty) return ephemeraSaveQueue;

  const id      = note.id;
  const title   = (note.title || '').trim();
  const content = note.content || '';
  const now     = new Date().toISOString();

  note.title = title;
  note.updated_at = now;
  ephemeraDirty = false;
  updateEphemeraStatus('Saving…');
  renderEphemeraList();

  return queueEphemeraDb(async () => {
    const { error } = await db.from('ephemera_notes')
      .update({ title, content, updated_at: now })
      .eq('id', id);
    if (error) {
      console.error('[Ephemera] save error:', error);
      if (sameId(id, ephemeraActiveId)) { ephemeraDirty = true; updateEphemeraStatus('Save failed'); }
    } else if (sameId(id, ephemeraActiveId) && !ephemeraDirty) {
      updateEphemeraStatus('Saved ✓');
    }
  });
}

ephemeraTitleInput.addEventListener('input', () => {
  const note = activeEphemeraNote();
  if (note) { note.title = ephemeraTitleInput.value; renderEphemeraList(); }
  markEphemeraDirty();
});
ephemeraTextarea.addEventListener('input', () => {
  const note = activeEphemeraNote();
  if (note) note.content = ephemeraTextarea.value;
  markEphemeraDirty();
});

ephemeraSaveBtn.addEventListener('click', () => { ephemeraDirty = true; saveEphemeraNote(); });

// Save when the tab is hidden / page is closed
document.addEventListener('visibilitychange', () => {
  if (document.hidden && !ephemeraModal.classList.contains('hidden')) saveEphemeraNote();
});
window.addEventListener('beforeunload', e => {
  if (ephemeraDirty) { saveEphemeraNote(); e.preventDefault(); e.returnValue = ''; }
});

/* ---------- new / delete ---------- */
ephemeraNewBtn.addEventListener('click', async () => {
  // Reuse an existing blank note instead of stacking empty ones
  const blank = ephemeraNotes.find(n => !n.title?.trim() && !n.content?.trim());
  if (blank) {
    selectEphemeraNote(blank.id);
    ephemeraTitleInput.focus();
    return;
  }
  if (ephemeraCreating) return;
  ephemeraCreating = true;

  try {
    const { data: { session } } = await db.auth.getSession();
    const unpinned = ephemeraNotes.filter(n => !n.pinned);
    const sort_order = unpinned.length ? Math.min(...unpinned.map(n => n.sort_order || 0)) - 1 : 0;

    const { data, error } = await db.from('ephemera_notes')
      .insert([{
        title: '',
        content: '',
        author: currentUsername,
        user_id: session.user.id,
        pinned: false,
        sort_order,
        updated_at: new Date().toISOString()
      }])
      .select().single();
    if (error) throw error;

    ephemeraNotes.push(data);
    sortEphemeraNotes();
    selectEphemeraNote(data.id);
    updateEphemeraStatus('New note');
    ephemeraTitleInput.focus();
  } catch (err) {
    console.error('[Ephemera] create error:', err);
    updateEphemeraStatus('Could not create note');
  } finally {
    ephemeraCreating = false;
  }
});

ephemeraDeleteBtn.addEventListener('click', async () => {
  const note = activeEphemeraNote();
  if (!note) return;
  if (!confirm('Delete this note? This cannot be undone.')) return;

  clearTimeout(ephemeraSaveTimer);
  ephemeraDirty = false;
  try {
    await ephemeraSaveQueue;
    const { error } = await db.from('ephemera_notes').delete().eq('id', note.id);
    if (error) throw error;
    ephemeraNotes = ephemeraNotes.filter(n => n !== note);
    ephemeraActiveId = null;
    if (ephemeraNotes.length) {
      renderEphemeraList();
      selectEphemeraNote(ephemeraNotes[0].id);
    } else {
      showEphemeraEmptyState();
    }
  } catch (err) {
    console.error('[Ephemera] delete error:', err);
    alert('Could not delete note.');
  }
});

/* ---------- pin + ordering ---------- */
function persistEphemeraOrder(changes) {
  // changes: [{ id, pinned, sort_order }]
  if (!changes.length) return;
  queueEphemeraDb(async () => {
    const results = await Promise.all(changes.map(c =>
      db.from('ephemera_notes')
        .update({ pinned: c.pinned, sort_order: c.sort_order })
        .eq('id', c.id)));
    results.forEach(r => r.error && console.error('[Ephemera] order error:', r.error));
  });
}

function toggleEphemeraPin() {
  const note = activeEphemeraNote();
  if (!note) return;
  const pinned = !note.pinned;
  const mates = ephemeraNotes.filter(n => n !== note && !!n.pinned === pinned);
  note.pinned = pinned;
  note.sort_order = mates.length ? Math.min(...mates.map(n => n.sort_order || 0)) - 1 : 0;
  sortEphemeraNotes();
  renderEphemeraList();
  syncEphemeraControls();
  persistEphemeraOrder([{ id: note.id, pinned, sort_order: note.sort_order }]);
}
ephemeraPinBtn.addEventListener('click', toggleEphemeraPin);

function moveEphemeraNote(dragId, targetId, before) {
  const dragged = findEphemeraNote(dragId);
  const target  = findEphemeraNote(targetId);
  if (!dragged || !target || dragged === target) return;

  const others = ephemeraNotes.filter(n => n !== dragged);
  let idx = others.indexOf(target);
  if (!before) idx += 1;

  dragged.pinned = !!target.pinned;   // dropping into a group adopts its pin state
  ephemeraNotes = [...others.slice(0, idx), dragged, ...others.slice(idx)];

  const changes = [];
  ephemeraNotes.forEach((n, i) => {
    if (n.sort_order !== i || n === dragged) {
      n.sort_order = i;
      changes.push({ id: n.id, pinned: !!n.pinned, sort_order: i });
    }
  });
  renderEphemeraList();
  syncEphemeraControls();
  persistEphemeraOrder(changes);
}

/* ---------- drag & drop (event delegation on the list) ---------- */
function clearEphemeraDropMarks() {
  ephemeraListEl.querySelectorAll('.drop-before, .drop-after')
    .forEach(el => el.classList.remove('drop-before', 'drop-after'));
}
function endEphemeraDrag() {
  ephemeraDragId = null;
  clearEphemeraDropMarks();
  ephemeraListEl.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
}

ephemeraListEl.addEventListener('dragstart', e => {
  const li = e.target.closest('.ephemera-list-item');
  if (!li) return;
  ephemeraDragId = li.dataset.id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', ephemeraDragId);
  requestAnimationFrame(() => li.classList.add('dragging'));
});

ephemeraListEl.addEventListener('dragover', e => {
  if (ephemeraDragId == null) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  clearEphemeraDropMarks();

  const li = e.target.closest('.ephemera-list-item');
  if (li) {
    if (!sameId(li.dataset.id, ephemeraDragId)) {
      const r = li.getBoundingClientRect();
      li.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
    }
  } else {
    // Empty space below the items → drop at the very bottom
    const items = ephemeraListEl.querySelectorAll('.ephemera-list-item');
    const last = items[items.length - 1];
    if (last && !sameId(last.dataset.id, ephemeraDragId)) last.classList.add('drop-after');
  }
});

ephemeraListEl.addEventListener('dragleave', e => {
  if (!ephemeraListEl.contains(e.relatedTarget)) clearEphemeraDropMarks();
});

ephemeraListEl.addEventListener('drop', e => {
  if (ephemeraDragId == null) return;
  e.preventDefault();
  const before = ephemeraListEl.querySelector('.drop-before');
  const after  = ephemeraListEl.querySelector('.drop-after');
  const dragId = ephemeraDragId;
  endEphemeraDrag();
  const marker = before || after;
  if (marker) moveEphemeraNote(dragId, marker.dataset.id, !!before);
});

ephemeraListEl.addEventListener('dragend', endEphemeraDrag);

/* ---------- textarea: Tab indentation + list continuation ---------- */
function ephemeraReplace(start, end, text) {
  const ta = ephemeraTextarea;
  ta.focus();
  ta.setSelectionRange(start, end);
  // execCommand keeps the native undo stack intact
  const ok = text === ''
    ? document.execCommand('delete')
    : document.execCommand('insertText', false, text);
  if (!ok) {
    ta.setRangeText(text, start, end, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function handleEphemeraTab(e) {
  e.preventDefault();
  const ta = ephemeraTextarea;
  const value = ta.value;
  const s = ta.selectionStart;
  const en = ta.selectionEnd;
  const multiLine = value.slice(s, en).includes('\n');

  // Plain Tab with no multi-line selection → insert indent at cursor
  if (!e.shiftKey && !multiLine) {
    ephemeraReplace(s, en, EPHEMERA_INDENT);
    return;
  }

  const lineStart = value.lastIndexOf('\n', s - 1) + 1;
  let lineEnd = value.indexOf('\n', en);
  if (lineEnd === -1) lineEnd = value.length;
  if (en > s && value[en - 1] === '\n') lineEnd = en - 1;   // ignore trailing empty selected line

  const block = value.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  const manyLines = lines.length > 1;

  const newLines = lines.map(l => {
    if (e.shiftKey) {
      if (l.startsWith(EPHEMERA_INDENT)) return l.slice(EPHEMERA_INDENT.length);
      if (l.startsWith('\t')) return l.slice(1);
      return l.replace(/^ /, '');
    }
    return (manyLines && !l.trim()) ? l : EPHEMERA_INDENT + l;
  });
  const newBlock = newLines.join('\n');

  ephemeraReplace(lineStart, lineEnd, newBlock);
  const firstDelta = newLines[0].length - lines[0].length;
  const newStart = Math.max(lineStart, s + firstDelta);
  const newEnd   = Math.max(newStart, en + (newBlock.length - block.length));
  ta.setSelectionRange(newStart, newEnd);
}

function handleEphemeraEnter(e) {
  const ta = ephemeraTextarea;
  const { value, selectionStart: s, selectionEnd: en } = ta;
  if (s !== en) return;

  const lineStart = value.lastIndexOf('\n', s - 1) + 1;
  const before = value.slice(lineStart, s);
  const nl = value.indexOf('\n', s);
  const after = value.slice(s, nl === -1 ? value.length : nl);

  const list = before.match(/^(\s*)([-*•]|\d+[.)])\s+/);
  if (list) {
    e.preventDefault();
    if (before.length === list[0].length && !after.trim()) {
      ephemeraReplace(lineStart, s, '');            // empty item → end the list
      return;
    }
    const marker = /^\d/.test(list[2])
      ? (parseInt(list[2], 10) + 1) + list[2].slice(-1)
      : list[2];
    ephemeraReplace(s, s, '\n' + list[1] + marker + ' ');
    return;
  }

  const indent = before.match(/^\s*/)[0];
  if (indent) {                                     // keep indentation on plain lines
    e.preventDefault();
    ephemeraReplace(s, s, '\n' + indent);
  }
}

ephemeraTextarea.addEventListener('keydown', e => {
  if (e.isComposing) return;
  if (e.key === 'Tab') handleEphemeraTab(e);
  else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) handleEphemeraEnter(e);
});

/* ---------- close handlers ---------- */
ephemeraCloseBtn.addEventListener('click', closeEphemeraModal);
ephemeraModal.addEventListener('click', e => { if (e.target === ephemeraModal) closeEphemeraModal(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !ephemeraModal.classList.contains('hidden')) closeEphemeraModal();
});

// Signed out mid-session: nothing can be saved, just reset and close
db.auth.onAuthStateChange((_e, session) => {
  if (!session && !ephemeraModal.classList.contains('hidden')) {
    clearTimeout(ephemeraSaveTimer);
    ephemeraDirty = false;
    ephemeraActiveId = null;
    ephemeraModal.classList.add('hidden');
    document.body.style.overflow = '';
  }
});