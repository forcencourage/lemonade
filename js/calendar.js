/* ============================================================
   Weekly calendar modal (Supabase-backed)
   - Navigate weeks (buttons, ←/→ keys, horizontal swipe/scroll)
   - Click + drag top→bottom in a day column to create a slot
   - On release, a text field (max 180 chars) appears
   - Click an existing slot to edit or delete it
   Requires the global Supabase client `db` defined in site.js,
   and the `calendar_events` table (see SQL).
   ============================================================ */
(function () {
  'use strict';

  // ---------- Config ----------
  var TABLE     = 'calendar_events';
  var HOUR_PX   = 48;               // must match --cal-hour in calendar.css
  var PPM       = HOUR_PX / 60;     // pixels per minute
  var SNAP      = 15;               // minutes
  var MIN_LEN   = 15;               // minimum slot length (minutes)
  var MAX_CHARS = 180;
  var DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // ---------- State ----------
  var events = [];                    // cache of loaded events
  var weekStart = startOfWeek(new Date());
  var composer = null;                // { mode, dayKey, start, end, id, anchor }
  var drag = null;
  var saving = false;
  var loadToken = 0;
  var busyCount = 0;

  // ---------- Supabase data layer ----------
  function client() {
    if (typeof db === 'undefined') throw new Error('Supabase client not found (load site.js first).');
    return db;
  }
  function fromRow(r) {
    return { id: r.id, date: r.event_date, start: r.start_min, end: r.end_min, text: r.content };
  }
  async function fetchWeek(fromKey, toKey) {
    var res = await client().from(TABLE).select('*')
      .gte('event_date', fromKey).lte('event_date', toKey)
      .order('start_min', { ascending: true });
    if (res.error) throw res.error;
    return res.data.map(fromRow);
  }
  async function insertEvent(ev) {
    var res = await client().from(TABLE)
      .insert({ event_date: ev.date, start_min: ev.start, end_min: ev.end, content: ev.text })
      .select().single();
    if (res.error) throw res.error;
    return fromRow(res.data);
  }
  async function updateEvent(id, text) {
    var res = await client().from(TABLE).update({ content: text }).eq('id', id);
    if (res.error) throw res.error;
  }
  async function deleteEvent(id) {
    var res = await client().from(TABLE).delete().eq('id', id);
    if (res.error) throw res.error;
  }

  // ---------- Build DOM ----------
  var overlay = document.createElement('div');
  overlay.id = 'calendar-modal';
  overlay.className = 'cal-overlay cal-hidden';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Calendar');
  overlay.innerHTML =
    '<div class="cal-box">' +
      '<header class="cal-header">' +
        '<div class="cal-title-wrap">' +
          '<h2 class="cal-title">Calendar</h2>' +
          '<span class="cal-range" id="cal-range"></span>' +
        '</div>' +
        '<div class="cal-header-actions">' +
          '<div class="cal-nav">' +
            '<button type="button" id="cal-prev" aria-label="Previous week">' +
              '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>' +
            '</button>' +
            '<button type="button" id="cal-today">Today</button>' +
            '<button type="button" id="cal-next" aria-label="Next week">' +
              '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>' +
            '</button>' +
          '</div>' +
          '<button type="button" class="cal-close" id="cal-close" aria-label="Close">✕</button>' +
        '</div>' +
      '</header>' +
      '<div class="cal-days" id="cal-days"></div>' +
      '<div class="cal-body" id="cal-body">' +
        '<div class="cal-grid" id="cal-grid"></div>' +
      '</div>' +
      '<div class="cal-hint">Click and drag down a day to create a slot · Click a slot to edit · ← → to change week</div>' +
      '<div class="cal-toast" id="cal-toast" role="status"></div>' +
      '<div class="cal-composer cal-hidden" id="cal-composer">' +
        '<div class="cal-composer-time" id="cal-composer-time"></div>' +
        '<textarea class="cal-textarea" id="cal-text" maxlength="' + MAX_CHARS + '" placeholder="What’s happening?" rows="3"></textarea>' +
        '<div class="cal-composer-foot">' +
          '<span class="cal-counter" id="cal-counter">0 / ' + MAX_CHARS + '</span>' +
          '<button type="button" class="cal-btn cal-hidden" id="cal-delete">Delete</button>' +
          '<button type="button" class="cal-btn" id="cal-cancel">Cancel</button>' +
          '<button type="button" class="cal-btn cal-btn-primary" id="cal-save">Save</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);

  var $ = function (id) { return document.getElementById(id); };
  var box = overlay.querySelector('.cal-box');
  var elDays = $('cal-days'), elBody = $('cal-body'), elGrid = $('cal-grid');
  var elRange = $('cal-range'), elToast = $('cal-toast');
  var elComposer = $('cal-composer'), elText = $('cal-text'), elCounter = $('cal-counter');
  var elComposerTime = $('cal-composer-time');
  var btnSave = $('cal-save'), btnCancel = $('cal-cancel'), btnDelete = $('cal-delete');

  // ---------- Helpers ----------
  function startOfWeek(d) {                    // Monday
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return x;
  }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function dayKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fmtTime(min) { return pad(Math.floor(min / 60) % 24) + ':' + pad(min % 60); }
  function fmtRange(a, b) { return fmtTime(a) + ' – ' + (b >= 1440 ? '24:00' : fmtTime(b)); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function snap(min) { return Math.round(min / SNAP) * SNAP; }

  var toastTimer;
  function toast(msg) {
    elToast.textContent = msg;
    elToast.classList.add('cal-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { elToast.classList.remove('cal-show'); }, 4200);
  }
  function errMsg(err) {
    var m = (err && err.message) || 'Something went wrong.';
    if (/row-level security|JWT|permission/i.test(m)) return 'Not allowed — please sign in first.';
    return m;
  }
  function busy(on) {
    busyCount = Math.max(0, busyCount + (on ? 1 : -1));
    box.classList.toggle('cal-busy', busyCount > 0);
  }

  // ---------- Rendering ----------
  function buildStatic() {
    var gutter = document.createElement('div');
    gutter.className = 'cal-gutter';
    for (var h = 1; h < 24; h++) {
      var l = document.createElement('div');
      l.className = 'cal-hour-label';
      l.style.top = (h * HOUR_PX) + 'px';
      l.textContent = pad(h) + ':00';
      gutter.appendChild(l);
    }
    elGrid.appendChild(gutter);
    for (var i = 0; i < 7; i++) {
      var col = document.createElement('div');
      col.className = 'cal-col';
      elGrid.appendChild(col);
    }
  }

  function render() {
    closeComposer();
    var todayKey = dayKey(new Date());
    var end = addDays(weekStart, 6);

    elRange.textContent =
      weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' – ' +
      end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

    elDays.innerHTML = '<div></div>';
    var cols = elGrid.querySelectorAll('.cal-col');
    for (var i = 0; i < 7; i++) {
      var d = addDays(weekStart, i), key = dayKey(d);
      var head = document.createElement('div');
      head.className = 'cal-day-head' + (key === todayKey ? ' cal-today' : '');
      head.innerHTML = '<span class="cal-day-name">' + DAY_NAMES[i] + '</span><span class="cal-day-num">' + d.getDate() + '</span>';
      elDays.appendChild(head);
      cols[i].dataset.key = key;
      cols[i].classList.toggle('cal-today', key === todayKey);
    }
    paintColumns();
    syncScrollbar();
    loadWeek();
  }

  // Redraw events + "now" line without touching an in-progress ghost slot.
  function paintColumns() {
    var todayKey = dayKey(new Date());
    var cols = elGrid.querySelectorAll('.cal-col');
    cols.forEach(function (col) {
      col.querySelectorAll('.cal-event, .cal-now').forEach(function (n) { n.remove(); });
      var key = col.dataset.key;
      renderEvents(col, key);
      if (key === todayKey) {
        var now = new Date();
        var line = document.createElement('div');
        line.className = 'cal-now';
        line.style.top = ((now.getHours() * 60 + now.getMinutes()) * PPM) + 'px';
        col.appendChild(line);
      }
    });
    // keep an open "edit" composer attached to its (re-created) element
    if (composer && composer.mode === 'edit') {
      var el = elGrid.querySelector('.cal-event[data-id="' + composer.id + '"]');
      if (el) { el.classList.add('cal-active'); composer.anchor = el; }
    }
  }

  async function loadWeek() {
    var token = ++loadToken;
    var from = dayKey(weekStart), to = dayKey(addDays(weekStart, 6));
    busy(true);
    try {
      var rows = await fetchWeek(from, to);
      if (token !== loadToken) return;            // user already moved to another week
      events = events.filter(function (e) { return e.date < from || e.date > to; }).concat(rows);
      paintColumns();
    } catch (err) {
      if (token === loadToken) toast('Could not load events — ' + errMsg(err));
    } finally {
      busy(false);
    }
  }

  function renderEvents(col, key) {
    var list = events.filter(function (e) { return e.date === key; })
                     .sort(function (a, b) { return a.start - b.start || b.end - a.end; });
    var clusters = [], cur = null, curEnd = -1;
    list.forEach(function (e) {
      if (!cur || e.start >= curEnd) { cur = []; clusters.push(cur); curEnd = -1; }
      cur.push(e); curEnd = Math.max(curEnd, e.end);
    });
    clusters.forEach(function (cluster) {
      var laneEnds = [];
      cluster.forEach(function (e) {
        var lane = laneEnds.findIndex(function (t) { return t <= e.start; });
        if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
        laneEnds[lane] = e.end; e._lane = lane;
      });
      cluster.forEach(function (e) { e._lanes = laneEnds.length; });
    });
    list.forEach(function (e) { col.appendChild(eventEl(e)); });
  }

  function eventEl(e) {
    var el = document.createElement('div');
    el.className = 'cal-event';
    el.dataset.id = e.id;
    var h = Math.max((e.end - e.start) * PPM, 14);
    var w = 100 / e._lanes;
    el.style.top = (e.start * PPM) + 'px';
    el.style.height = h + 'px';
    el.style.left = 'calc(' + (e._lane * w) + '% + 2px)';
    el.style.width = 'calc(' + w + '% - 4px)';

    var showTime = h >= 40;
    var lines = Math.max(1, Math.floor((h - 10 - (showTime ? 14 : 0)) / 16));

    el.innerHTML =
      (showTime ? '<span class="cal-event-time">' + fmtRange(e.start, e.end) + '</span>' : '') +
      '<span class="cal-event-text"></span>';
    var t = el.querySelector('.cal-event-text');
    t.textContent = e.text;
    t.style.webkitLineClamp = lines;
    el.title = fmtRange(e.start, e.end) + ' — ' + e.text;
    return el;
  }

  function syncScrollbar() {
    elDays.style.setProperty('--cal-scrollbar', (elBody.offsetWidth - elBody.clientWidth) + 'px');
  }

  // ---------- Week navigation ----------
  function shiftWeek(n) { weekStart = addDays(weekStart, n * 7); render(); }
  function goToday() { weekStart = startOfWeek(new Date()); render(); scrollToWork(); }
  function isWeekCurrent() { return dayKey(weekStart) === dayKey(startOfWeek(new Date())); }
  function scrollToWork() {
    var now = new Date();
    elBody.scrollTop = isWeekCurrent() ? Math.max(0, (now.getHours() - 2) * HOUR_PX) : 7 * HOUR_PX;
  }

  // ---------- Drag to create ----------
  elGrid.addEventListener('pointerdown', function (ev) {
    var col = ev.target.closest('.cal-col');
    if (!col || ev.button !== 0) return;

    var evEl = ev.target.closest('.cal-event');
    if (evEl) { openEdit(evEl); return; }

    closeComposer();
    var rect = col.getBoundingClientRect();
    var y0 = ev.clientY - rect.top;
    drag = {
      col: col, key: col.dataset.key, rect: rect, y0: y0,
      anchorMin: clamp(Math.floor(y0 / PPM / SNAP) * SNAP, 0, 1440 - MIN_LEN),
      moved: false, ghost: null, start: 0, end: 0, pid: ev.pointerId
    };
    col.setPointerCapture(ev.pointerId);
    col.classList.add('cal-dragging');
  });

  elGrid.addEventListener('pointermove', function (ev) {
    if (!drag || ev.pointerId !== drag.pid) return;
    var y = ev.clientY - drag.rect.top;
    if (!drag.moved && Math.abs(y - drag.y0) < 5) return;
    drag.moved = true;

    var cur = clamp(y / PPM, 0, 1440);
    var a, b;
    if (cur >= drag.anchorMin) { a = drag.anchorMin; b = Math.max(snap(cur), a + MIN_LEN); }
    else { b = drag.anchorMin + SNAP; a = Math.floor(cur / SNAP) * SNAP; }
    a = clamp(a, 0, 1440 - MIN_LEN); b = clamp(b, a + MIN_LEN, 1440);
    drag.start = a; drag.end = b;

    if (!drag.ghost) {
      drag.ghost = document.createElement('div');
      drag.ghost.className = 'cal-ghost';
      drag.ghost.style.left = '2px'; drag.ghost.style.right = '2px';
      drag.ghost.innerHTML = '<span class="cal-event-time"></span>';
      drag.col.appendChild(drag.ghost);
    }
    drag.ghost.style.top = (a * PPM) + 'px';
    drag.ghost.style.height = ((b - a) * PPM) + 'px';
    drag.ghost.firstChild.textContent = fmtRange(a, b);

    var r = elBody.getBoundingClientRect();
    if (ev.clientY > r.bottom - 30) elBody.scrollTop += 12;
    else if (ev.clientY < r.top + 30) elBody.scrollTop -= 12;
  });

  function endDrag(ev, cancelled) {
    if (!drag || ev.pointerId !== drag.pid) return;
    var d = drag; drag = null;
    d.col.classList.remove('cal-dragging');
    try { d.col.releasePointerCapture(ev.pointerId); } catch (e) {}
    if (cancelled || !d.moved || !d.ghost) { if (d.ghost) d.ghost.remove(); return; }
    openComposer({ mode: 'new', dayKey: d.key, start: d.start, end: d.end, anchor: d.ghost });
  }
  elGrid.addEventListener('pointerup', function (e) { endDrag(e, false); });
  elGrid.addEventListener('pointercancel', function (e) { endDrag(e, true); });

  // ---------- Composer ----------
  function openEdit(evEl) {
    var e = events.find(function (x) { return String(x.id) === evEl.dataset.id; });
    if (!e) return;
    closeComposer();
    evEl.classList.add('cal-active');
    openComposer({ mode: 'edit', id: e.id, dayKey: e.date, start: e.start, end: e.end, text: e.text, anchor: evEl });
  }

  function openComposer(cfg) {
    composer = cfg;
    elText.value = cfg.text || '';
    elComposerTime.textContent = fmtRange(cfg.start, cfg.end);
    btnDelete.classList.toggle('cal-hidden', cfg.mode !== 'edit');
    elComposer.classList.remove('cal-hidden');
    updateCounter();
    placeComposer();
    setTimeout(function () {
      elText.focus();
      elText.setSelectionRange(elText.value.length, elText.value.length);
    }, 0);
  }

  function placeComposer() {
    if (!composer || !composer.anchor || !composer.anchor.isConnected) return;
    var b = box.getBoundingClientRect();
    var a = composer.anchor.getBoundingClientRect();
    var w = elComposer.offsetWidth || 300, h = elComposer.offsetHeight || 190;
    var left = a.right - b.left + 10;
    if (left + w > b.width - 8) left = a.left - b.left - w - 10;
    left = clamp(left, 8, b.width - w - 8);
    elComposer.style.left = left + 'px';
    elComposer.style.top = clamp(a.top - b.top, 56, b.height - h - 8) + 'px';
  }

  function closeComposer() {
    if (saving) return;
    if (composer && composer.mode === 'new' && composer.anchor) composer.anchor.remove();
    resetComposer();
  }
  function resetComposer() {
    var act = elGrid.querySelector('.cal-event.cal-active');
    if (act) act.classList.remove('cal-active');
    composer = null;
    elComposer.classList.add('cal-hidden');
  }
  function setSaving(on) {
    saving = on;
    elComposer.classList.toggle('cal-saving', on);
    btnSave.textContent = on ? 'Saving…' : 'Save';
  }

  function updateCounter() {
    var n = elText.value.length;
    elCounter.textContent = n + ' / ' + MAX_CHARS;
    elCounter.classList.toggle('cal-limit', n >= MAX_CHARS);
    btnSave.disabled = elText.value.trim().length === 0;
  }

  async function commit() {
    var text = elText.value.trim().slice(0, MAX_CHARS);
    if (!composer || !text || saving) return;
    var c = composer;
    setSaving(true); busy(true);
    try {
      if (c.mode === 'new') {
        var row = await insertEvent({ date: c.dayKey, start: c.start, end: c.end, text: text });
        events.push(row);
        if (c.anchor) c.anchor.remove();
      } else {
        await updateEvent(c.id, text);
        var e = events.find(function (x) { return x.id === c.id; });
        if (e) e.text = text;
      }
      setSaving(false);
      resetComposer();
      paintColumns();
    } catch (err) {
      setSaving(false);
      toast('Could not save — ' + errMsg(err));
    } finally {
      busy(false);
    }
  }

  async function removeCurrent() {
    if (!composer || composer.mode !== 'edit' || saving) return;
    var id = composer.id;
    setSaving(true); busy(true);
    try {
      await deleteEvent(id);
      events = events.filter(function (x) { return x.id !== id; });
      setSaving(false);
      resetComposer();
      paintColumns();
    } catch (err) {
      setSaving(false);
      toast('Could not delete — ' + errMsg(err));
    } finally {
      busy(false);
    }
  }

  elText.addEventListener('input', updateCounter);
  elText.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
  });
  btnSave.addEventListener('click', commit);
  btnCancel.addEventListener('click', closeComposer);
  btnDelete.addEventListener('click', removeCurrent);
  elBody.addEventListener('scroll', placeComposer);

  // ---------- Open / close ----------
  function isOpen() { return !overlay.classList.contains('cal-hidden'); }
  function open() {
    overlay.classList.remove('cal-hidden');
    document.body.style.overflow = 'hidden';
    weekStart = startOfWeek(new Date());
    render();
    scrollToWork();
  }
  function close() {
    closeComposer();
    overlay.classList.add('cal-hidden');
    document.body.style.overflow = '';
  }

  $('cal-close').addEventListener('click', close);
  $('cal-prev').addEventListener('click', function () { shiftWeek(-1); });
  $('cal-next').addEventListener('click', function () { shiftWeek(1); });
  $('cal-today').addEventListener('click', goToday);
  overlay.addEventListener('pointerdown', function (e) {
    if (e.target === overlay) close();
    else if (composer && !e.target.closest('.cal-composer') && !e.target.closest('.cal-grid')) closeComposer();
  });

  document.addEventListener('keydown', function (e) {
    if (!isOpen()) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      composer ? closeComposer() : close();
      return;
    }
    var typing = /^(INPUT|TEXTAREA)$/.test((document.activeElement || {}).tagName || '');
    if (typing) return;
    if (e.key === 'ArrowLeft')  { e.preventDefault(); shiftWeek(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); shiftWeek(1); }
  }, true);

  // horizontal trackpad swipe / shift+wheel → change week
  var wheelLock = 0;
  elBody.addEventListener('wheel', function (e) {
    var dx = e.deltaX || (e.shiftKey ? e.deltaY : 0);
    if (Math.abs(dx) < 40 || (Math.abs(dx) < Math.abs(e.deltaY) && !e.shiftKey)) return;
    e.preventDefault();
    var now = Date.now();
    if (now - wheelLock < 450) return;
    wheelLock = now;
    shiftWeek(dx > 0 ? 1 : -1);
  }, { passive: false });

  window.addEventListener('resize', function () { if (isOpen()) { syncScrollbar(); placeComposer(); } });

  // ---------- Init ----------
  buildStatic();
  var trigger = document.getElementById('collection-dropdown-calendar');
  if (trigger) trigger.addEventListener('click', open);
  window.openCalendar = open;
})();