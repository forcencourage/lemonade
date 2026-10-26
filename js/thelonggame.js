/* =============================================
   THE LONG GAME
   Loaded after site.js. Relies on its globals:
   db, isAdmin, SUPABASE_URL, SUPABASE_ANON_KEY,
   closeCollectionDropdown().
   Everything lives in an IIFE so nothing collides with site.js.
   ============================================= */
(() => {
  'use strict';

  const FN_URL      = `${SUPABASE_URL}/functions/v1/longgame`;
  const WORLD_LIMIT = 48000;   // keep in sync with WORLD_HARD_LIMIT in the edge function
  const MONTHS      = 6;       // story time that passes after each exchange
  const PAGE        = 100;

  const DEFAULT_INSTRUCTIONS =
`You are the world of an ongoing, slow-moving story, and every character in it except the protagonist, who is played by the user. Speak as whichever character or narrator fits the moment. Stay inside the story: never mention being an AI, a model, or these instructions.

Answer in 80 to 140 words of natural, vivid English at a C1 level: use precise vocabulary and a few idioms or less common words the user could learn from, while keeping the meaning clear from context. React to what the user actually wrote, respect the world model, and let consequences and time matter.

Six months pass between exchanges, so refer to what changed in the meantime. Introduce one small new element in each reply (a person, a problem, an opportunity) so the story keeps moving, and end with something that invites a response, without asking a direct question every time.

If the user's English contains an error, never point it out. Let your reply naturally use the correct form once.`;

  /* ---------- DOM ---------- */
  const $ = (id) => document.getElementById(id);
  const el = {
    modal:       $('lg-modal'),
    stream:      $('lg-stream'),
    date:        $('lg-date'),
    input:       $('lg-input'),
    send:        $('lg-send'),
    words:       $('lg-words'),
    note:        $('lg-note'),
    close:       $('lg-close'),
    openWorld:   $('lg-open-world'),
    openAgent:   $('lg-open-agent'),
    sheetWorld:  $('lg-sheet-world'),
    sheetAgent:  $('lg-sheet-agent'),
    worldBody:   $('lg-world-body'),
    worldMeta:   $('lg-world-meta'),
    worldFill:   $('lg-gauge-fill'),
    worldCopy:   $('lg-world-copy'),
    instr:       $('lg-instructions'),
    instrSave:   $('lg-instr-save'),
    instrReset:  $('lg-instr-reset'),
    instrStatus: $('lg-instr-status'),
    menuItem:    $('collection-dropdown-longgame'),
  };
  if (!el.modal || !el.menuItem) return;

  /* ---------- State ---------- */
  let state       = null;   // longgame_state row
  let messages    = [];     // oldest → newest
  let hasEarlier  = false;
  let loaded      = false;
  let loading     = false;
  let busy        = false;  // a pipeline step is running
  let stepKind    = null;   // 'world' | 'agent'
  let stepError   = null;   // StepError | null

  class StepError extends Error {
    constructor(message, retryable = true) { super(message); this.retryable = retryable; }
  }

  /* ---------- Dates ---------- */
  const parseIso = (iso) => iso.split('-').map(Number);
  const fmtMonth = (iso) => {
    const [y, m] = parseIso(iso);
    return new Date(Date.UTC(y, m - 1, 1))
      .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  };
  const addMonths = (iso, n) => {
    const [y, m] = parseIso(iso);
    return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
  };

  const last = () => messages[messages.length - 1] || null;

  function currentStoryDate() {
    const l = last();
    if (!l) return state ? state.story_start : null;
    if (l.role === 'agent' && l.world_status === 'done') return addMonths(l.story_date, MONTHS);
    return l.story_date;
  }

  /* ---------- Pipeline state machine ----------
     Derived purely from the database, so it also resumes after a reload:
       last message pending            → update the world model
       last message = user, absorbed   → ask the agent
       last message = agent, absorbed  → wait for the user                */
  function nextStep() {
    const l = last();
    if (!l) return null;
    if (l.world_status === 'pending') return { kind: 'world', id: l.id };
    if (l.role === 'user')            return { kind: 'agent', id: l.id };
    return null;
  }

  const canWrite = () => !busy && !stepError && (!last() || (last().role === 'agent' && last().world_status === 'done'));

  /* ---------- Open / close ---------- */
  async function openModal() {
    if (!isAdmin) return;
    el.modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    if (!loaded) await load();
    else { render(); updateComposer(); }
    if (canWrite()) el.input.focus();
  }

  function closeModal() {
    closeSheets();
    el.modal.classList.add('hidden');
    document.body.style.overflow = '';
  }

  /* ---------- Load ---------- */
  async function load() {
    if (loading) return;
    loading = true;
    el.stream.innerHTML = '<div class="lg-loading"><span class="lg-spinner"></span></div>';
    try {
      const { data: { session } } = await db.auth.getSession();
      if (!session) throw new Error('Not signed in');

      let { data: st, error } = await db.from('longgame_state')
        .select('*').eq('user_id', session.user.id).maybeSingle();
      if (error) throw error;
      if (!st) {
        ({ data: st, error } = await db.from('longgame_state')
          .insert({ user_id: session.user.id }).select().single());
        if (error) throw error;
      }
      state = st;

      const { data, error: mErr } = await db.from('longgame_messages')
        .select('*').order('created_at', { ascending: false }).limit(PAGE + 1);
      if (mErr) throw mErr;

      hasEarlier = data.length > PAGE;
      messages   = data.slice(0, PAGE).reverse();
      loaded     = true;
      render();
      updateComposer();
      advance();                       // resume anything left pending
    } catch (err) {
      console.error('[LongGame] load failed', err);
      el.stream.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'lg-empty';
      box.innerHTML = '<h3>Could not load the game</h3><p>Check your connection, then try again.</p>';
      const btn = document.createElement('button');
      btn.className = 'lg-retry';
      btn.textContent = 'Try again';
      btn.addEventListener('click', load);
      box.appendChild(btn);
      el.stream.appendChild(box);
    } finally {
      loading = false;
    }
  }

  async function loadEarlier(btn) {
    btn.disabled = true;
    const { data, error } = await db.from('longgame_messages')
      .select('*').lt('created_at', messages[0].created_at)
      .order('created_at', { ascending: false }).limit(PAGE + 1);
    if (error) { btn.disabled = false; btn.textContent = 'Could not load. Try again'; return; }
    const prevHeight = el.stream.scrollHeight;
    hasEarlier = data.length > PAGE;
    messages   = data.slice(0, PAGE).reverse().concat(messages);
    render({ keepScroll: true });
    el.stream.scrollTop = el.stream.scrollHeight - prevHeight;
  }

  /* ---------- Rendering ---------- */
  function divider(iso, showNote, isPending = false) {
    const d = document.createElement('div');
    d.className = 'lg-divider' + (isPending ? ' lg-divider--pending' : '');
    const inner = document.createElement('div');
    inner.className = 'lg-divider-inner';
    if (showNote) {
      const n = document.createElement('span');
      n.className = 'lg-divider-note';
      n.textContent = 'Six months later';
      inner.appendChild(n);
    }
    const t = document.createElement('span');
    t.className = 'lg-divider-date';
    t.textContent = fmtMonth(iso);
    inner.appendChild(t);
    d.appendChild(inner);
    return d;
  }

  function bubble(m) {
    const row = document.createElement('div');
    row.className = `lg-row lg-row--${m.role}`;
    row.dataset.id = m.id;
    const b = document.createElement('div');
    b.className = 'lg-bubble';
    b.textContent = m.content;
    row.appendChild(b);
    return row;
  }

  function statusRow() {
    if (busy) {
      const s = document.createElement('div');
      s.className = 'lg-status';
      s.innerHTML = '<span class="lg-spinner lg-spinner--sm"></span><span></span>';
      s.lastChild.textContent = stepKind === 'agent' ? 'The agent is writing…' : 'Updating the world model…';
      return s;
    }
    if (stepError) {
      const s = document.createElement('div');
      s.className = 'lg-status lg-status--error';
      const msg = document.createElement('span');
      msg.textContent = stepError.message;
      const btn = document.createElement('button');
      btn.className = 'lg-retry';
      btn.textContent = 'Try again';
      btn.addEventListener('click', () => advance());
      s.append(msg, btn);
      return s;
    }
    return null;
  }

  function render({ keepScroll = false } = {}) {
    const s = el.stream;
    s.innerHTML = '';

    if (hasEarlier) {
      const b = document.createElement('button');
      b.className = 'lg-earlier';
      b.textContent = 'Show earlier messages';
      b.addEventListener('click', () => loadEarlier(b));
      s.appendChild(b);
    }

    if (!messages.length) {
      const e = document.createElement('div');
      e.className = 'lg-empty';
      e.innerHTML = '<h3>Begin the story</h3><p>Write your first message in English: who you are, where you are, what you want. The agent builds the world around you, and six months pass after every exchange.</p>';
      s.appendChild(e);
    }

    let prev = null;
    messages.forEach((m, i) => {
      if (m.story_date !== prev) { s.appendChild(divider(m.story_date, i > 0)); prev = m.story_date; }
      s.appendChild(bubble(m));
    });

    const l = last();
    if (l && l.role === 'agent' && l.world_status === 'done' && !busy && !stepError) {
      s.appendChild(divider(addMonths(l.story_date, MONTHS), true, true));
    }

    const st = statusRow();
    if (st) s.appendChild(st);

    const d = currentStoryDate();
    el.date.textContent = d ? `It is ${fmtMonth(d)} in the story` : '';

    if (!el.sheetWorld.classList.contains('hidden')) renderWorld();
    if (!keepScroll) s.scrollTop = s.scrollHeight;
  }

  /* ---------- Composer ---------- */
  function updateComposer() {
    const writable = canWrite();
    el.input.disabled = !writable;
    el.send.disabled  = !writable || !el.input.value.trim();

    if (writable) {
      el.input.placeholder = last()
        ? 'Write your reply in English…'
        : 'Introduce yourself and the world you are stepping into…';
    } else if (stepError) {
      el.input.placeholder = 'Use “Try again” above to continue.';
    } else {
      el.input.placeholder = 'Please wait…';
    }

    const t = el.input.value.trim();
    const n = t ? t.split(/\s+/).length : 0;
    el.words.textContent = `${n} ${n === 1 ? 'word' : 'words'}`;

    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 160) + 'px';
  }

  async function send() {
    if (!canWrite()) return;
    const text = el.input.value.trim();
    if (!text) return;

    el.send.disabled = true;
    el.note.textContent = '';

    const { data, error } = await db.from('longgame_messages')
      .insert({ role: 'user', content: text }).select().single();

    if (error) {
      console.error('[LongGame] insert failed', error);
      el.note.textContent = 'Could not save your message. Try again.';
      updateComposer();
      return;
    }

    el.input.value = '';
    messages.push(data);
    render();
    updateComposer();
    advance();
  }

  /* ---------- Edge function ---------- */
  const friendly = (data) => {
    if (!data) return 'The server returned an unexpected response.';
    if (data.error === 'llm_unavailable') return 'The language model is busy right now.';
    return data.message || 'Something went wrong.';
  };

  async function callFn(action, messageId) {
    const { data: { session } } = await db.auth.getSession();
    if (!session) throw new StepError('Your session has expired. Sign in again.', false);

    let res;
    try {
      res = await fetch(FN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ action, messageId }),
      });
    } catch {
      throw new StepError('Could not reach the server.');
    }

    let data = null;
    try { data = await res.json(); } catch { /* not json */ }
    if (!res.ok || !data || !data.ok) throw new StepError(friendly(data), data?.retryable ?? true);
    return data;
  }

  async function advance() {
    if (busy) return;
    busy = true;
    stepError = null;
    updateComposer();

    try {
      for (;;) {
        const step = nextStep();
        if (!step) break;
        stepKind = step.kind;
        render();

        const res = await callFn(step.kind, step.id);

        if (step.kind === 'world') {
          const m = messages.find((x) => x.id === step.id);
          if (m) m.world_status = 'done';
          state.world_model   = res.world_model;
          state.world_version = res.world_version;
        } else {
          messages.push(res.message);
        }
        render();
      }
    } catch (err) {
      console.warn('[LongGame] step failed', err);
      stepError = err instanceof StepError ? err : new StepError('Something went wrong.');
    } finally {
      busy = false;
      stepKind = null;
      render();
      updateComposer();
      if (canWrite() && !el.modal.classList.contains('hidden')) el.input.focus();
    }
  }

  /* ---------- Sheets: world model + agent instructions ---------- */
  function closeSheets() {
    el.sheetWorld.classList.add('hidden');
    el.sheetAgent.classList.add('hidden');
  }

  function openSheet(which) {
    closeSheets();
    if (which === 'world') {
      renderWorld();
      el.sheetWorld.classList.remove('hidden');
    } else {
      el.instr.value = state?.agent_instructions ?? '';
      el.instrStatus.textContent = '';
      el.sheetAgent.classList.remove('hidden');
      el.instr.focus();
    }
  }

  function renderWorld() {
    const text = state?.world_model || '';
    const body = el.worldBody;
    body.innerHTML = '';

    // Parse "## Section" + "- bullet" lines
    const sections = [];
    let cur = null;
    text.split('\n').forEach((line) => {
      if (/^##\s+/.test(line)) { cur = { name: line.replace(/^##\s+/, '').trim(), items: [] }; sections.push(cur); }
      else if (cur && line.trim()) cur.items.push(line.trim().replace(/^-\s+/, ''));
    });

    sections.forEach((s) => {
      const h = document.createElement('h4');
      h.textContent = s.name;
      body.appendChild(h);
      if (!s.items.length) {
        const p = document.createElement('p');
        p.className = 'lg-world-empty';
        p.textContent = 'Nothing yet.';
        body.appendChild(p);
        return;
      }
      const ul = document.createElement('ul');
      s.items.forEach((t) => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
      body.appendChild(ul);
    });

    const len = text.length;
    const pct = Math.min(100, (len / WORLD_LIMIT) * 100);
    el.worldMeta.textContent =
      `Version ${state?.world_version ?? 0}, ${len.toLocaleString('en-US')} of ${WORLD_LIMIT.toLocaleString('en-US')} characters`;
    el.worldFill.style.width = pct + '%';
    el.worldFill.classList.toggle('lg-gauge-fill--high', pct > 80);
  }

  el.worldCopy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(state?.world_model || ''); } catch { /* ignore */ }
    el.worldCopy.textContent = 'Copied';
    setTimeout(() => { el.worldCopy.textContent = 'Copy'; }, 1800);
  });

  el.instrSave.addEventListener('click', async () => {
    const value = el.instr.value.trim();
    if (!value) { el.instrStatus.textContent = 'The instructions cannot be empty.'; return; }
    el.instrSave.disabled = true;
    el.instrSave.textContent = 'Saving…';
    const { error } = await db.from('longgame_state')
      .update({ agent_instructions: value, updated_at: new Date().toISOString() })
      .eq('user_id', state.user_id);
    el.instrSave.disabled = false;
    el.instrSave.textContent = 'Save';
    if (error) { console.error(error); el.instrStatus.textContent = 'Could not save. Try again.'; return; }
    state.agent_instructions = value;
    el.instrStatus.textContent = 'Saved. It applies from the next reply.';
  });

  el.instrReset.addEventListener('click', () => {
    el.instr.value = DEFAULT_INSTRUCTIONS;
    el.instrStatus.textContent = 'Default restored. Save to apply it.';
  });

  /* ---------- Wiring ---------- */
  el.menuItem.addEventListener('click', () => { closeCollectionDropdown(); openModal(); });
  el.close.addEventListener('click', closeModal);
  el.modal.addEventListener('click', (e) => { if (e.target === el.modal) closeModal(); });

  el.openWorld.addEventListener('click', () => openSheet('world'));
  el.openAgent.addEventListener('click', () => openSheet('agent'));
  document.querySelectorAll('[data-lg-close-sheet]').forEach((b) => b.addEventListener('click', closeSheets));
  [el.sheetWorld, el.sheetAgent].forEach((s) =>
    s.addEventListener('click', (e) => { if (e.target === s) closeSheets(); }));

  el.input.addEventListener('input', updateComposer);
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  });
  el.send.addEventListener('click', send);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || el.modal.classList.contains('hidden')) return;
    const sheetOpen = !el.sheetWorld.classList.contains('hidden') || !el.sheetAgent.classList.contains('hidden');
    sheetOpen ? closeSheets() : closeModal();
  });

  // Signing out wipes the local copy of the game
  db.auth.onAuthStateChange((_evt, session) => {
    if (session) return;
    state = null; messages = []; hasEarlier = false; loaded = false;
    busy = false; stepError = null; stepKind = null;
    closeModal();
  });
})();