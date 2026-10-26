/* =============================================
   EPHEMERA
   Depends on globals from site.js: db, isAdmin, currentUsername
   ============================================= */
let ephemeraNotes    = [];
let ephemeraActiveId = null;
let ephemeraDirty    = false;

const ephemeraModal      = document.getElementById('ephemera-modal');
const ephemeraCloseBtn   = document.getElementById('ephemera-close');
const ephemeraListEl     = document.getElementById('ephemera-list');
const ephemeraNewBtn     = document.getElementById('ephemera-new-btn');
const ephemeraTitleInput = document.getElementById('ephemera-title-input');
const ephemeraTextarea   = document.getElementById('ephemera-textarea');
const ephemeraSaveBtn    = document.getElementById('ephemera-save-btn');
const ephemeraDeleteBtn  = document.getElementById('ephemera-delete-btn');
const ephemeraStatusEl   = document.getElementById('ephemera-status');

function updateEphemeraStatus(text) { ephemeraStatusEl.textContent = text; }
function markEphemeraDirty() { ephemeraDirty = true; updateEphemeraStatus('Unsaved changes'); }

async function openEphemeraModal() {
  if (!isAdmin) return;
  ephemeraModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  await loadEphemeraNotes();
}

function closeEphemeraModal() {
  if (ephemeraDirty && !confirm('Discard unsaved changes?')) return;
  ephemeraModal.classList.add('hidden');
  document.body.style.overflow = '';
  ephemeraActiveId = null;
  ephemeraDirty = false;
}

async function loadEphemeraNotes() {
  ephemeraListEl.innerHTML = '<li class="ephemera-loading">Loading…</li>';
  const { data, error } = await db
    .from('ephemera_notes')
    .select('id, title, content, updated_at')
    .eq('author', currentUsername)
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('[Ephemera] load error:', error);
    ephemeraListEl.innerHTML = '<li class="ephemera-empty">Could not load notes.</li>';
    return;
  }

  ephemeraNotes = data || [];
  renderEphemeraList();

  if (ephemeraNotes.length) {
    selectEphemeraNote(ephemeraNotes[0].id);
  } else {
    ephemeraActiveId = null;
    ephemeraTitleInput.value = '';
    ephemeraTextarea.value   = '';
    ephemeraTitleInput.disabled = true;
    ephemeraTextarea.disabled   = true;
    updateEphemeraStatus('');
  }
}

function renderEphemeraList() {
  ephemeraListEl.innerHTML = '';
  if (!ephemeraNotes.length) {
    ephemeraListEl.innerHTML = '<li class="ephemera-empty">No notes yet.</li>';
    return;
  }
  ephemeraNotes.forEach(note => {
    const li = document.createElement('li');
    li.className = 'ephemera-list-item' + (note.id === ephemeraActiveId ? ' active' : '');
    li.textContent = note.title?.trim() || 'Untitled';
    li.addEventListener('click', () => selectEphemeraNote(note.id));
    ephemeraListEl.appendChild(li);
  });
}

function selectEphemeraNote(id) {
  if (ephemeraDirty && !confirm('Discard unsaved changes to this note?')) return;
  ephemeraActiveId = id;
  const note = ephemeraNotes.find(n => n.id === id);
  ephemeraTitleInput.disabled = false;
  ephemeraTextarea.disabled   = false;
  ephemeraTitleInput.value = note?.title   || '';
  ephemeraTextarea.value   = note?.content || '';
  ephemeraDirty = false;
  updateEphemeraStatus('');
  renderEphemeraList();
}

ephemeraTitleInput.addEventListener('input', markEphemeraDirty);
ephemeraTextarea.addEventListener('input', markEphemeraDirty);

ephemeraNewBtn.addEventListener('click', () => {
  if (ephemeraDirty && !confirm('Discard unsaved changes?')) return;
  ephemeraActiveId = null;
  ephemeraTitleInput.disabled = false;
  ephemeraTextarea.disabled   = false;
  ephemeraTitleInput.value = '';
  ephemeraTextarea.value   = '';
  ephemeraDirty = false;
  updateEphemeraStatus('New note — not yet saved');
  document.querySelectorAll('.ephemera-list-item.active').forEach(el => el.classList.remove('active'));
  ephemeraTitleInput.focus();
});

ephemeraSaveBtn.addEventListener('click', async () => {
  const title   = ephemeraTitleInput.value.trim() || 'Untitled';
  const content = ephemeraTextarea.value;

  ephemeraSaveBtn.disabled = true;
  ephemeraSaveBtn.textContent = 'Saving…';

  try {
    if (ephemeraActiveId) {
      const { error } = await db.from('ephemera_notes')
        .update({ title, content, updated_at: new Date().toISOString() })
        .eq('id', ephemeraActiveId);
      if (error) throw error;
    } else {
      const { data: { session } } = await db.auth.getSession();
      const { data, error } = await db.from('ephemera_notes')
        .insert([{
          title,
          content,
          author: currentUsername,
          user_id: session.user.id,
          updated_at: new Date().toISOString()
        }])
        .select().single();
      if (error) throw error;
      ephemeraActiveId = data.id;
    }
    ephemeraDirty = false;
    updateEphemeraStatus('Saved ✓');
    await loadEphemeraNotes();
    ephemeraActiveId && selectEphemeraNote(ephemeraActiveId);
  } catch (err) {
    console.error('[Ephemera] save error:', err);
    updateEphemeraStatus('Save failed');
  } finally {
    ephemeraSaveBtn.disabled = false;
    ephemeraSaveBtn.textContent = 'Save';
  }
});

ephemeraDeleteBtn.addEventListener('click', async () => {
  if (!ephemeraActiveId) return;
  if (!confirm('Delete this note? This cannot be undone.')) return;
  try {
    const { error } = await db.from('ephemera_notes').delete().eq('id', ephemeraActiveId);
    if (error) throw error;
    ephemeraNotes = ephemeraNotes.filter(n => n.id !== ephemeraActiveId);
    ephemeraActiveId = null;
    if (ephemeraNotes.length) {
      selectEphemeraNote(ephemeraNotes[0].id);
    } else {
      ephemeraTitleInput.value = '';
      ephemeraTextarea.value   = '';
      ephemeraTitleInput.disabled = true;
      ephemeraTextarea.disabled   = true;
      updateEphemeraStatus('');
      renderEphemeraList();
    }
  } catch (err) {
    console.error('[Ephemera] delete error:', err);
    alert('Could not delete note.');
  }
});

ephemeraCloseBtn.addEventListener('click', closeEphemeraModal);
ephemeraModal.addEventListener('click', e => { if (e.target === ephemeraModal) closeEphemeraModal(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !ephemeraModal.classList.contains('hidden')) closeEphemeraModal();
});

// Close/reset if the user signs out mid-session
db.auth.onAuthStateChange((_e, session) => {
  if (!session && !ephemeraModal.classList.contains('hidden')) {
    ephemeraDirty = false;
    closeEphemeraModal();
  }
});