/* =============================================
   PERSONAS MANAGER
   Depends on globals from site.js:
   db, isAdmin, loadPersonalities, closeCollectionDropdown
   ============================================= */
const PM_PRESETS = [
  '#4f8ef7', '#ff4500', '#adff2f', '#e11d48', '#ffa500',
  '#111111', '#006400', '#8b5cf6', '#14b8a6', '#ec4899'
];
const PM_HEX_RE = /^#[0-9a-f]{6}$/i;

let pmRows     = [];     // personas as stored in the database
let pmActiveId = null;   // id of the persona being edited
let pmIsNew    = false;  // true while editing an unsaved new persona
let pmDirty    = false;

const pmModal        = document.getElementById('pm-modal');
const pmCloseBtn     = document.getElementById('pm-close');
const pmListEl       = document.getElementById('pm-list');
const pmNewBtn       = document.getElementById('pm-new-btn');
const pmNameInput    = document.getElementById('pm-name-input');
const pmColorInput   = document.getElementById('pm-color-input');
const pmHexInput     = document.getElementById('pm-hex-input');
const pmSwatchesEl   = document.getElementById('pm-swatches');
const pmDescInput    = document.getElementById('pm-desc-input');
const pmPreview      = document.getElementById('pm-preview');
const pmPreviewName  = document.getElementById('pm-preview-name');
const pmSaveBtn      = document.getElementById('pm-save-btn');
const pmDeleteBtn    = document.getElementById('pm-delete-btn');
const pmStatusEl     = document.getElementById('pm-status');

/* ── Helpers ─────────────────────────────── */
function pmSetStatus(text, isError = false) {
  pmStatusEl.textContent = text;
  pmStatusEl.classList.toggle('pm-status--error', isError);
}

function pmMarkDirty() {
  pmDirty = true;
  pmSetStatus('Unsaved changes');
}

// Turns any CSS color ("lightblue", "#abc", …) into #rrggbb
function pmNormalizeColor(c) {
  if (PM_HEX_RE.test(c)) return c.toLowerCase();
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillStyle = c;
  return ctx.fillStyle.toLowerCase();
}

function pmSetFormEnabled(on) {
  [pmNameInput, pmColorInput, pmHexInput, pmDescInput].forEach(el => el.disabled = !on);
  pmSwatchesEl.classList.toggle('pm-swatches--disabled', !on);
  pmSaveBtn.disabled   = !on;
  pmDeleteBtn.disabled = !on || pmIsNew;
}

function pmUpdatePreview() {
  const color = PM_HEX_RE.test(pmColorInput.value) ? pmColorInput.value : '#888888';
  pmPreview.style.setProperty('--comment-color', color);
  pmPreviewName.textContent = pmNameInput.value.trim() || 'Persona';
  pmPreviewName.style.color = color;
}

function pmSetColor(hex, { markDirty = false } = {}) {
  hex = hex.toLowerCase();
  pmColorInput.value = hex;
  pmHexInput.value   = hex;
  pmSwatchesEl.querySelectorAll('.pm-swatch').forEach(s =>
    s.classList.toggle('active', s.dataset.color === hex)
  );
  pmUpdatePreview();
  if (markDirty) pmMarkDirty();
}

/* ── Color presets (built once) ──────────── */
PM_PRESETS.forEach(color => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pm-swatch';
  b.dataset.color = color;
  b.style.background = color;
  b.title = color;
  b.addEventListener('click', () => {
    if (pmColorInput.disabled) return;
    pmSetColor(color, { markDirty: true });
  });
  pmSwatchesEl.appendChild(b);
});

/* ── Open / close ────────────────────────── */
async function openPersonasModal() {
  if (!isAdmin) return;
  pmModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  pmDirty = false;
  await pmLoadRows();
}

function closePersonasModal() {
  if (pmDirty && !confirm('Discard unsaved changes?')) return;
  pmModal.classList.add('hidden');
  document.body.style.overflow = '';
  pmActiveId = null;
  pmIsNew = false;
  pmDirty = false;
}

/* ── Load + render ───────────────────────── */
async function pmLoadRows(selectId = null) {
  pmListEl.innerHTML = '<li class="pm-loading">Loading…</li>';

  const { data, error } = await db
    .from('personas')
    .select('id, name, color, description')
    .order('sort_order', { ascending: true });

  if (error) {
    console.error('[Personas] load error:', error);
    pmListEl.innerHTML = '<li class="pm-empty">Could not load personas.</li>';
    pmSetFormEnabled(false);
    return;
  }

  pmRows = data || [];

  if (selectId && pmRows.some(r => r.id === selectId)) pmSelect(selectId, true);
  else if (pmRows.length)                              pmSelect(pmRows[0].id, true);
  else                                                 pmStartNew(true);
}

function pmRenderList() {
  pmListEl.innerHTML = '';

  pmRows.forEach(row => {
    const li = document.createElement('li');
    li.className = 'pm-item' + (!pmIsNew && row.id === pmActiveId ? ' active' : '');
    li.innerHTML = `<span class="pm-dot"></span><span class="pm-item-name"></span>`;
    li.querySelector('.pm-dot').style.background = pmNormalizeColor(row.color);
    li.querySelector('.pm-item-name').textContent = row.name;
    li.addEventListener('click', () => pmSelect(row.id));
    pmListEl.appendChild(li);
  });

  if (pmIsNew) {
    const li = document.createElement('li');
    li.className = 'pm-item pm-item--pending active';
    li.innerHTML = `<span class="pm-dot"></span><span class="pm-item-name">New persona</span>`;
    li.querySelector('.pm-dot').style.background = pmColorInput.value;
    pmListEl.appendChild(li);
  }
}

function pmSelect(id, force = false) {
  if (!force && pmDirty && !confirm('Discard unsaved changes?')) return;
  const row = pmRows.find(r => r.id === id);
  if (!row) return;

  pmActiveId = id;
  pmIsNew    = false;
  pmDirty    = false;

  pmSetFormEnabled(true);
  pmNameInput.value = row.name;
  pmDescInput.value = row.description;
  pmSetColor(pmNormalizeColor(row.color));
  pmSetStatus('');
  pmRenderList();
}

function pmStartNew(force = false) {
  if (!force && pmDirty && !confirm('Discard unsaved changes?')) return;

  pmActiveId = null;
  pmIsNew    = true;
  pmDirty    = false;

  pmSetFormEnabled(true);
  pmNameInput.value = '';
  pmDescInput.value = '';

  // Suggest a preset that no existing persona is using yet
  const used = pmRows.map(r => pmNormalizeColor(r.color));
  pmSetColor(PM_PRESETS.find(c => !used.includes(c)) || PM_PRESETS[0]);

  pmSetStatus('New persona — not yet saved');
  pmRenderList();
  pmNameInput.focus();
}

/* ── Field events ────────────────────────── */
pmNameInput.addEventListener('input', () => { pmUpdatePreview(); pmMarkDirty(); });
pmDescInput.addEventListener('input', pmMarkDirty);

pmColorInput.addEventListener('input', () => pmSetColor(pmColorInput.value, { markDirty: true }));

pmHexInput.addEventListener('input', () => {
  let v = pmHexInput.value.trim();
  if (v && v[0] !== '#') v = '#' + v;
  if (PM_HEX_RE.test(v)) pmSetColor(v, { markDirty: true });
});
pmHexInput.addEventListener('blur', () => { pmHexInput.value = pmColorInput.value; });

pmNewBtn.addEventListener('click', () => pmStartNew());

/* ── Save ────────────────────────────────── */
function pmFail(message, field) {
  pmSetStatus(message, true);
  field?.focus();
}

async function pmSave() {
  const name        = pmNameInput.value.trim();
  const description = pmDescInput.value.trim();
  const color       = PM_HEX_RE.test(pmColorInput.value) ? pmColorInput.value.toLowerCase() : null;

  if (!name)        return pmFail('Give the persona a name.', pmNameInput);
  if (!description) return pmFail('Add a description.', pmDescInput);
  if (!color)       return pmFail('Choose a valid color.', pmHexInput);
  if (pmRows.some(r => r.id !== pmActiveId && r.name.toLowerCase() === name.toLowerCase())) {
    return pmFail('Another persona already uses this name.', pmNameInput);
  }

  pmSaveBtn.disabled = true;
  pmSaveBtn.textContent = 'Saving…';

  try {
    let savedId = pmActiveId;

    if (pmIsNew) {
      const { data, error } = await db.from('personas')
        .insert([{ name, color, description }])
        .select('id').single();
      if (error) throw error;
      savedId = data.id;
    } else {
      const previous = pmRows.find(r => r.id === pmActiveId);

      const { error } = await db.from('personas')
        .update({ name, color, description })
        .eq('id', pmActiveId);
      if (error) throw error;

      // Keep existing comments in sync so their names stay clickable
      if (previous && (previous.name !== name || pmNormalizeColor(previous.color) !== color)) {
        const { error: cErr } = await db.from('comments')
          .update({ persona_name: name, persona_color: color })
          .eq('persona_name', previous.name);
        if (cErr) console.warn('[Personas] could not update existing comments:', cErr);
      }
    }

    pmDirty = false;
    await loadPersonalities();   // refresh the live list used by AI comments (site.js)
    await pmLoadRows(savedId);
    pmSetStatus('Saved ✓');

  } catch (err) {
    console.error('[Personas] save error:', err);
    pmSetStatus(err.code === '23505' ? 'Another persona already uses this name.' : 'Save failed', true);
  } finally {
    pmSaveBtn.disabled = false;
    pmSaveBtn.textContent = 'Save';
  }
}

pmSaveBtn.addEventListener('click', pmSave);

/* ── Delete ──────────────────────────────── */
pmDeleteBtn.addEventListener('click', async () => {
  if (pmIsNew || !pmActiveId) return;
  const row = pmRows.find(r => r.id === pmActiveId);
  if (!row) return;

  if (!confirm(`Delete “${row.name}”? Its existing comments stay, but it will no longer comment on new posts.`)) return;

  try {
    const { error } = await db.from('personas').delete().eq('id', pmActiveId);
    if (error) throw error;
    pmDirty = false;
    await loadPersonalities();
    await pmLoadRows();
  } catch (err) {
    console.error('[Personas] delete error:', err);
    pmSetStatus('Delete failed', true);
  }
});

/* ── Wiring ──────────────────────────────── */
document.getElementById('collection-dropdown-personas').addEventListener('click', () => {
  closeCollectionDropdown();
  openPersonasModal();
});

pmCloseBtn.addEventListener('click', closePersonasModal);
pmModal.addEventListener('click', e => { if (e.target === pmModal) closePersonasModal(); });

document.addEventListener('keydown', e => {
  if (pmModal.classList.contains('hidden')) return;
  if (e.key === 'Escape') closePersonasModal();
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (!pmSaveBtn.disabled) pmSave();
  }
});

// Close if the user signs out mid-session
db.auth.onAuthStateChange((_e, session) => {
  if (!session && !pmModal.classList.contains('hidden')) {
    pmDirty = false;
    closePersonasModal();
  }
});