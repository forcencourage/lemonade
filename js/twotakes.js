/* =============================================
   TWOTAKES — two personas debate one question
   Depends on globals from site.js:
   db, SUPABASE_URL, SUPABASE_ANON_KEY, isAdmin, personalityMap,
   loadPersonalities, personaAvatarHtml, escapeHtml, detectLanguage,
   saveToast, closeCollectionDropdown
   ============================================= */
(() => {
  'use strict';

  const modal = document.getElementById('tt-modal');
  if (!modal) return;

  const FN_URL      = `${SUPABASE_URL}/functions/v1/twotakes`;
  const MAX_AXIOM   = 400;
  const $           = id => document.getElementById(id);
  const esc         = s => escapeHtml(s ?? '');
  const box         = $('tt-box');
  const main        = $('tt-main');
  const listEl      = $('tt-list');
  const toast       = msg => (typeof saveToast === 'function' ? saveToast(msg) : console.log(msg));

  const CHEVRON = `<svg class="tt-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
  const ARROW   = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;

  /* ---------- state ---------- */
  const S = {
    debates: [],
    current: null,          // debate row
    turns: [],
    loaded: false,
    loadingTurns: false,
    generating: null,       // 'a' | 'b' while a reply is being written
    token: 0,               // invalidates in-flight requests when switching debate
    error: null,
    fresh: null,            // id of the turn that should animate in
    draft: { question: '', axioms: [], a: null, b: null },
    picker: null,
    axiomsOpen: false,
    composer: null,         // turn id whose "add to axioms" composer is open
    composerText: ''
  };

  /* ---------- persona helpers ---------- */
  const personas = () => Object.values(personalityMap || {});
  const personaById = id => personas().find(p => String(p.id) === String(id)) || null;
  async function ensurePersonas() {
    if (!personas().length) await loadPersonalities();
  }
  const av = (name, color, url, size = 36) =>
    personaAvatarHtml(name, color, size, url || null, false);

  function slotData(slot) {
    const d = S.current;
    const id = d[`persona_${slot}_id`];
    const live = personaById(id);
    return {
      slot, id,
      live: !!live,
      name: live?.name || d[`persona_${slot}_name`],
      color: live?.color || d[`persona_${slot}_color`] || '#1a1a1a',
      avatar: live?.avatar || null,
      description: live?.persona || ''
    };
  }
  const slotOfTurn = t => (t.persona_id === S.current.persona_a_id ? 'a' : 'b');
  const nextSlot = () => {
    const last = S.turns[S.turns.length - 1];
    return last ? (slotOfTurn(last) === 'a' ? 'b' : 'a') : 'a';
  };

  /* ---------- data ---------- */
  const normAxioms = raw => (Array.isArray(raw) ? raw : [])
    .map(a => (typeof a === 'string' ? { text: a, source: 'manual' } : a))
    .filter(a => a && a.text);

  async function loadDebates() {
    const { data, error } = await db
      .from('twotakes_debates').select('*')
      .order('updated_at', { ascending: false });
    if (error) { console.error('[Twotakes] load', error); toast('Could not load debates.'); return; }
    S.debates = (data || []).map(d => ({ ...d, axioms: normAxioms(d.axioms) }));
  }

  async function saveAxioms() {
    const { error } = await db.from('twotakes_debates')
      .update({ axioms: S.current.axioms, updated_at: new Date().toISOString() })
      .eq('id', S.current.id);
    if (error) throw error;
  }

  function touch(id) {
    const d = S.debates.find(x => x.id === id);
    if (!d) return;
    d.updated_at = new Date().toISOString();
    S.debates.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    renderList();
    db.from('twotakes_debates').update({ updated_at: d.updated_at }).eq('id', id).then(() => {});
  }

  /* ---------- sidebar ---------- */
  function renderList() {
    if (!S.debates.length) {
      listEl.innerHTML = '<li class="tt-list-empty">No debates yet.<br>Start one with the + button.</li>';
      return;
    }
    listEl.innerHTML = S.debates.map(d => `
      <li class="tt-item${S.current?.id === d.id ? ' active' : ''}">
        <button class="tt-item-main" data-action="open" data-id="${d.id}">
          <span class="tt-item-q">${esc(d.question)}</span>
          <span class="tt-item-meta">${esc(d.persona_a_name)} <i>vs</i> ${esc(d.persona_b_name)}</span>
        </button>
        <button class="tt-item-del" data-action="delete" data-id="${d.id}" title="Delete debate" aria-label="Delete debate">✕</button>
      </li>`).join('');
  }

  /* ---------- axioms (shared by setup + debate) ---------- */
  const axiomItems = arr => arr.length
    ? arr.map((a, i) => `
        <li class="tt-axiom">
          <span class="tt-axiom-dot"></span>
          <span class="tt-axiom-t">${esc(a.text)}</span>
          ${a.source === 'turn' ? '<span class="tt-axiom-tag" title="Born from the debate">from the debate</span>' : ''}
          <button class="tt-x" data-action="axiom-remove" data-i="${i}" aria-label="Remove axiom">✕</button>
        </li>`).join('')
    : '<li class="tt-axiom-empty">No axioms yet. The debaters will argue from scratch.</li>';

  const axiomAddRow = () => `
    <div class="tt-add">
      <input id="tt-axiom-input" type="text" maxlength="${MAX_AXIOM}" autocomplete="off"
             placeholder="Add an axiom, then press Enter">
      <button type="button" class="tt-plus" data-action="axiom-add" title="Add axiom" aria-label="Add axiom">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>`;

  const currentAxioms = () => (S.current ? S.current.axioms : S.draft.axioms);

  function refreshAxioms() {
    const arr = currentAxioms();
    const ol = $('tt-axioms');
    if (ol) ol.innerHTML = axiomItems(arr);
    const c = $('tt-axiom-count');
    if (c) c.textContent = arr.length;
  }

  async function addAxiom(text, source = 'manual', turnId = null) {
    text = (text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_AXIOM);
    if (!text) return false;
    const arr = currentAxioms();
    if (arr.some(a => a.text.toLowerCase() === text.toLowerCase())) {
      toast('That axiom is already listed.');
      return false;
    }
    arr.push({ text, source, turn_id: turnId });
    if (S.current) {
      try { await saveAxioms(); }
      catch (err) {
        arr.pop();
        console.error('[Twotakes] axiom save', err);
        toast('Could not save the axiom.');
        return false;
      }
    }
    return true;
  }

  async function removeAxiom(i) {
    const arr = currentAxioms();
    const [removed] = arr.splice(i, 1);
    if (!removed) return;
    if (S.current) {
      try { await saveAxioms(); }
      catch (err) {
        arr.splice(i, 0, removed);
        toast('Could not remove the axiom.');
      }
    }
    refreshAxioms();
  }

  async function submitAxiomInput() {
    const inp = $('tt-axiom-input');
    if (!inp) return;
    if (await addAxiom(inp.value)) { inp.value = ''; refreshAxioms(); }
    inp.focus();
  }

  /* ---------- setup view ---------- */
  function renderSetup() {
    S.picker = null;
    main.innerHTML = `
      <div class="tt-scroll">
        <div class="tt-setup">
          <h2 class="tt-title">What should they argue about?</h2>
          <p class="tt-lede">Pick a question, give them common ground, choose two adversaries. They will keep answering each other without leaving the question.</p>

          <section class="tt-field">
            <label class="tt-label" for="tt-q">Question</label>
            <textarea id="tt-q" class="tt-q" rows="3" maxlength="600"
              placeholder="Can a belief be rational if it can never be tested?">${esc(S.draft.question)}</textarea>
          </section>

          <section class="tt-field">
            <div class="tt-label-row">
              <span class="tt-label">Axioms</span>
              <span class="tt-hint">Premises both sides accept as true</span>
            </div>
            ${axiomAddRow()}
            <ul class="tt-axioms" id="tt-axioms">${axiomItems(S.draft.axioms)}</ul>
          </section>

          <section class="tt-field">
            <span class="tt-label">Adversaries</span>
            <div class="tt-duel" id="tt-duel"></div>
          </section>

          <div class="tt-setup-actions">
            <button class="btn-primary tt-begin" id="tt-begin" data-action="begin" disabled>Begin debate</button>
          </div>
        </div>
      </div>`;
    renderDuel();
    updateBegin();
  }

  function slotHtml(slot) {
    const p = S.draft[slot];
    const other = S.draft[slot === 'a' ? 'b' : 'a'];
    const open = S.picker === slot;
    const label = slot === 'a' ? 'First take' : 'Second take';
    const face = p
      ? `${av(p.name, p.color, p.avatar, 38)}<span class="tt-slot-name" style="color:${esc(p.color || '#1a1a1a')}">${esc(p.name)}</span>`
      : `<span class="tt-slot-ghost"></span><span class="tt-slot-empty">Choose a persona</span>`;
    const options = personas().filter(x => !other || String(x.id) !== String(other.id));

    const menu = open ? `
      <ul class="tt-menu" role="listbox">
        ${options.length ? options.map(x => `
          <li>
            <button type="button" class="tt-menu-item${p && String(p.id) === String(x.id) ? ' sel' : ''}"
                    data-action="choose-persona" data-slot="${slot}" data-id="${esc(x.id)}">
              ${av(x.name, x.color, x.avatar, 30)}
              <span class="tt-menu-txt">
                <b>${esc(x.name)}${x.active === false ? ' <em>inactive</em>' : ''}</b>
                <small>${esc((x.persona || '').replace(/\s+/g, ' ').slice(0, 80))}</small>
              </span>
            </button>
          </li>`).join('') : '<li class="tt-menu-empty">No personas available.</li>'}
      </ul>` : '';

    return `
      <div class="tt-slot${open ? ' open' : ''}">
        <button type="button" class="tt-slot-btn" data-action="pick-slot" data-slot="${slot}"
                aria-haspopup="listbox" aria-expanded="${open}">
          <span class="tt-slot-label">${label}</span>
          <span class="tt-slot-face">${face}${CHEVRON}</span>
        </button>
        ${menu}
      </div>`;
  }

  function renderDuel() {
    const el = $('tt-duel');
    if (el) el.innerHTML = slotHtml('a') + '<span class="tt-vs">vs</span>' + slotHtml('b');
  }

  function updateBegin() {
    const btn = $('tt-begin');
    if (btn) btn.disabled = !(S.draft.question.trim() && S.draft.a && S.draft.b);
  }

  function choosePersona(slot, id) {
    const p = personaById(id);
    if (!p) return;
    S.draft[slot] = { id: String(p.id), name: p.name, color: p.color, avatar: p.avatar || null };
    S.picker = null;
    renderDuel();
    updateBegin();
  }

  async function begin() {
    const q = S.draft.question.trim();
    const { a, b } = S.draft;
    if (!q || !a || !b) return;

    const btn = $('tt-begin');
    btn.disabled = true;
    btn.textContent = 'Starting…';

    try {
      const { data, error } = await db.from('twotakes_debates').insert({
        question: q,
        axioms: S.draft.axioms,
        persona_a_id: a.id, persona_a_name: a.name, persona_a_color: a.color,
        persona_b_id: b.id, persona_b_name: b.name, persona_b_color: b.color
      }).select().single();
      if (error) throw error;

      data.axioms = normAxioms(data.axioms);
      S.debates.unshift(data);
      S.current = data;
      S.turns = [];
      S.error = null;
      S.token++;
      S.draft = { question: '', axioms: [], a: null, b: null };
      renderList();
      renderDebate();
      generate('a');
    } catch (err) {
      console.error('[Twotakes] begin', err);
      toast('Could not start the debate.');
      btn.disabled = false;
      btn.textContent = 'Begin debate';
    }
  }

  /* ---------- debate view ---------- */
  function renderDebate() {
    const d = S.current;
    const A = slotData('a'), B = slotData('b');
    const n = d.axioms.length;

    main.innerHTML = `
      <header class="tt-dhead">
        <h2 class="tt-question">${esc(d.question)}</h2>
        <div class="tt-versus">
          <span class="tt-side">${av(A.name, A.color, A.avatar, 28)}<b style="color:${esc(A.color)}">${esc(A.name)}</b></span>
          <span class="tt-vs">vs</span>
          <span class="tt-side">${av(B.name, B.color, B.avatar, 28)}<b style="color:${esc(B.color)}">${esc(B.name)}</b></span>
        </div>
        <button class="tt-axioms-toggle" data-action="toggle-axioms" aria-expanded="${S.axiomsOpen}">
          <span>Axioms</span><span class="tt-count" id="tt-axiom-count">${n}</span>${CHEVRON}
        </button>
        <div class="tt-axioms-panel${S.axiomsOpen ? ' open' : ''}" id="tt-axioms-panel">
          <div class="tt-axioms-inner">
            <ul class="tt-axioms" id="tt-axioms">${axiomItems(d.axioms)}</ul>
            ${axiomAddRow()}
          </div>
        </div>
      </header>
      <div class="tt-stream" id="tt-stream"></div>`;
    renderStream('instant');
  }

  function turnHtml(t, i) {
    const slot = slotOfTurn(t);
    const live = personaById(t.persona_id);
    const color = live?.color || t.persona_color || '#1a1a1a';
    const name = live?.name || t.persona_name;
    const isNew = S.fresh === t.id;

    const composer = S.composer === t.id ? `
      <div class="tt-composer">
        <label class="tt-label" for="tt-composer-input">Distil it into an axiom</label>
        <textarea id="tt-composer-input" rows="3" maxlength="${MAX_AXIOM}">${esc(S.composerText)}</textarea>
        <div class="tt-composer-actions">
          <button class="btn-ghost btn-sm" data-action="compose-cancel">Cancel</button>
          <button class="btn-primary btn-sm" data-action="compose-save">Add axiom</button>
        </div>
      </div>` : '';

    return `
      <article class="tt-turn tt-turn--${slot}${isNew ? ' tt-turn--new' : ''}" style="--c:${esc(color)}" data-turn="${t.id}">
        <div class="tt-turn-head">
          ${av(name, color, live?.avatar, 30)}
          <span class="tt-turn-name">${esc(name)}</span>
        </div>
        <p class="tt-turn-text">${esc(t.content)}</p>
        <div class="tt-turn-foot">
          <button class="tt-ghost" data-action="compose" data-id="${t.id}">+ Add to axioms</button>
        </div>
        ${composer}
      </article>`;
  }

  function renderStream(scroll) {
    const st = $('tt-stream');
    if (!st || !S.current) return;

    if (S.loadingTurns) {
      st.innerHTML = '<div class="tt-loading"><div class="spinner"></div></div>';
      return;
    }

    const turns = S.turns.map(turnHtml).join('');
    let tail;

    if (S.generating) {
      const sp = slotData(S.generating);
      tail = `
        <article class="tt-turn tt-turn--${S.generating} tt-turn--typing" style="--c:${esc(sp.color)}">
          <div class="tt-turn-head">
            ${av(sp.name, sp.color, sp.avatar, 30)}
            <span class="tt-turn-name">${esc(sp.name)}</span>
          </div>
          <div class="tt-dots" aria-label="${esc(sp.name)} is writing"><span></span><span></span><span></span></div>
        </article>`;
    } else {
      const slot = nextSlot();
      const n = slotData(slot);
      tail = `
        <div class="tt-next">
          ${S.error ? `<p class="tt-error">${esc(S.error)}</p>` : ''}
          <button class="tt-continue" data-action="continue" data-slot="${slot}" style="--c:${esc(n.color)}">
            ${av(n.name, n.color, n.avatar, 26)}
            <span>${S.turns.length ? `Let ${esc(n.name)} answer` : `Let ${esc(n.name)} open`}</span>
            ${ARROW}
          </button>
          ${S.turns.length ? '<button class="tt-regen" data-action="regen">Rewrite last reply</button>' : ''}
        </div>`;
    }

    st.innerHTML = `<div class="tt-stream-inner">${turns}${tail}</div>`;
    S.fresh = null;

    if (scroll === 'smooth') requestAnimationFrame(() => st.scrollTo({ top: st.scrollHeight, behavior: 'smooth' }));
    else if (scroll === 'instant') requestAnimationFrame(() => { st.scrollTop = st.scrollHeight; });
  }

  /* ---------- generation ---------- */
  async function generate(slot) {
    const d = S.current;
    if (!d || S.generating) return;

    const sp = slotData(slot);
    const op = slotData(slot === 'a' ? 'b' : 'a');

    if (!sp.live) {
      S.error = `${sp.name} no longer exists in your personas, so it cannot answer.`;
      renderStream();
      return;
    }

    const token = ++S.token;
    const debateId = d.id;
    S.generating = slot;
    S.error = null;
    S.composer = null;
    renderStream('smooth');

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60000);

    try {
      const res = await fetch(FN_URL, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        },
        body: JSON.stringify({
          question: d.question,
          axioms: d.axioms.map(a => a.text),
          speaker:  { name: sp.name, description: sp.description },
          opponent: { name: op.name, description: op.description },
          history: S.turns.map(t => ({ name: t.persona_name, content: t.content })),
          language: detectLanguage(d.question)
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const content = (data.content || '').trim();
      if (!content) throw new Error(data.error || 'Empty reply');

      if (token !== S.token) return;   // user switched debate meanwhile

      const { data: row, error } = await db.from('twotakes_turns').insert({
        debate_id: debateId,
        turn_index: S.turns.length,
        persona_id: String(sp.id),
        persona_name: sp.name,
        persona_color: sp.color,
        content
      }).select().single();
      if (error) throw error;

      S.turns.push(row);
      S.fresh = row.id;
      touch(debateId);

    } catch (err) {
      console.error('[Twotakes] generate', err);
      if (token === S.token) S.error = 'Could not get a reply. Try again.';
    } finally {
      clearTimeout(timer);
      if (token === S.token) {
        S.generating = null;
        renderStream('smooth');
      }
    }
  }

  async function regen() {
    if (S.generating || !S.turns.length) return;
    const last = S.turns[S.turns.length - 1];
    const slot = slotOfTurn(last);
    const { error } = await db.from('twotakes_turns').delete().eq('id', last.id);
    if (error) { toast('Could not remove the reply.'); return; }
    S.turns.pop();
    S.composer = null;
    generate(slot);
  }

  /* ---------- add a reply to the axioms ---------- */
  function openComposer(id) {
    const t = S.turns.find(x => x.id === id);
    if (!t) return;
    S.composer = id;
    S.composerText = t.content;
    renderStream();
    const ta = $('tt-composer-input');
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  async function saveComposer() {
    const t = S.turns.find(x => x.id === S.composer);
    if (await addAxiom(S.composerText, 'turn', t?.id || null)) {
      S.composer = null;
      S.composerText = '';
      refreshAxioms();
      renderStream();
      toast('Added to your axioms ✓');
    }
  }

  /* ---------- navigation ---------- */
  function newDebate() {
    S.token++;
    S.generating = null;
    S.current = null;
    S.turns = [];
    S.error = null;
    S.composer = null;
    box.classList.remove('sidebar-open');
    renderList();
    renderSetup();
  }

  async function openDebate(id) {
    const d = S.debates.find(x => x.id === id);
    if (!d) return;

    S.token++;
    S.generating = null;
    S.error = null;
    S.composer = null;
    S.current = d;
    S.turns = [];
    S.loadingTurns = true;
    box.classList.remove('sidebar-open');
    renderList();
    renderDebate();

    const { data, error } = await db.from('twotakes_turns')
      .select('*').eq('debate_id', id).order('turn_index', { ascending: true });

    if (S.current?.id !== id) return;
    S.loadingTurns = false;
    if (error) { console.error('[Twotakes] turns', error); toast('Could not load this debate.'); }
    S.turns = data || [];
    renderStream('instant');
  }

  async function deleteDebate(id) {
    if (!confirm('Delete this debate and all its replies?')) return;
    const { error } = await db.from('twotakes_debates').delete().eq('id', id);
    if (error) { toast('Could not delete the debate.'); return; }
    S.debates = S.debates.filter(d => d.id !== id);
    if (S.current?.id === id) {
      S.current = null;
      S.token++;
      S.generating = null;
      S.debates.length ? openDebate(S.debates[0].id) : (renderList(), renderSetup());
    } else {
      renderList();
    }
  }

  /* ---------- open / close ---------- */
  async function openTwotakes() {
    if (!isAdmin) return;
    modal.classList.remove('hidden');

    if (S.loaded) return;
    main.innerHTML = '<div class="tt-loading"><div class="spinner"></div></div>';
    await ensurePersonas();
    await loadDebates();
    S.loaded = true;
    renderList();
    S.debates.length ? openDebate(S.debates[0].id) : renderSetup();
  }

  function closeTwotakes() {
    modal.classList.add('hidden');
    S.picker = null;
    box.classList.remove('sidebar-open');
  }
  window.openTwotakes = openTwotakes;

  /* ---------- events ---------- */
  modal.addEventListener('click', e => {
    if (e.target === modal) { closeTwotakes(); return; }
    if (e.target === box && box.classList.contains('sidebar-open')) {
      box.classList.remove('sidebar-open');
      return;
    }
    if (S.picker && !e.target.closest('.tt-slot')) { S.picker = null; renderDuel(); }

    const el = e.target.closest('[data-action]');
    if (!el || !modal.contains(el)) return;

    switch (el.dataset.action) {
      case 'close':          closeTwotakes(); break;
      case 'toggle-sidebar': box.classList.toggle('sidebar-open'); break;
      case 'new':            newDebate(); break;
      case 'open':           openDebate(el.dataset.id); break;
      case 'delete':         deleteDebate(el.dataset.id); break;
      case 'pick-slot':
        S.picker = S.picker === el.dataset.slot ? null : el.dataset.slot;
        renderDuel();
        break;
      case 'choose-persona': choosePersona(el.dataset.slot, el.dataset.id); break;
      case 'axiom-add':      submitAxiomInput(); break;
      case 'axiom-remove':   removeAxiom(Number(el.dataset.i)); break;
      case 'begin':          begin(); break;
      case 'continue':       generate(el.dataset.slot); break;
      case 'regen':          regen(); break;
      case 'toggle-axioms': {
        S.axiomsOpen = !S.axiomsOpen;
        $('tt-axioms-panel')?.classList.toggle('open', S.axiomsOpen);
        el.setAttribute('aria-expanded', String(S.axiomsOpen));
        break;
      }
      case 'compose':        openComposer(el.dataset.id); break;
      case 'compose-cancel': S.composer = null; renderStream(); break;
      case 'compose-save':   saveComposer(); break;
    }
  });

  modal.addEventListener('input', e => {
    if (e.target.id === 'tt-q') { S.draft.question = e.target.value; updateBegin(); }
    else if (e.target.id === 'tt-composer-input') { S.composerText = e.target.value; }
  });

  modal.addEventListener('keydown', e => {
    if (e.isComposing) return;
    if (e.key === 'Enter' && e.target.id === 'tt-axiom-input') {
      e.preventDefault();
      submitAxiomInput();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.id === 'tt-composer-input') {
      e.preventDefault();
      saveComposer();
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || modal.classList.contains('hidden')) return;
    if (S.picker) { S.picker = null; renderDuel(); return; }
    if (S.composer) { S.composer = null; renderStream(); return; }
    closeTwotakes();
  });

  // Entry in the collection dropdown
  $('collection-dropdown-twotakes')?.addEventListener('click', () => {
    if (typeof closeCollectionDropdown === 'function') closeCollectionDropdown();
    openTwotakes();
  });

  // Reset when the user signs in/out
  db.auth.onAuthStateChange(() => {
    S.loaded = false;
    S.debates = [];
    S.current = null;
    S.turns = [];
    S.generating = null;
    S.token++;
    main.innerHTML = '';
    listEl.innerHTML = '';
    if (!isAdmin) modal.classList.add('hidden');
  });
})();