/* =============================================
   ANTILIBRARY
   A personal "books to read" list, backed by Supabase
   and searched live via the Google Books API.

   Depends on globals already defined in site.js
   (loaded before this file): db, isAdmin,
   currentUsername, escapeHtml, closeCollectionDropdown.
   ============================================= */
(function () {

  const GOOGLE_BOOKS_API = 'https://www.googleapis.com/books/v1/volumes';
  const GOOGLE_BOOKS_API_KEY = 'AIzaSyAkSNhBy8KNIlq1RVvsAEArOKOoKmQSkt4';
  const SEARCH_DEBOUNCE_MS = 450;

  /* ---------- DOM refs ---------- */
  const modal          = document.getElementById('antilibrary-modal');
  const closeBtn        = document.getElementById('antilibrary-close');
  const searchInput     = document.getElementById('antilibrary-search-input');
  const searchClearBtn  = document.getElementById('antilibrary-search-clear');
  const searchResultsEl = document.getElementById('antilibrary-search-results');
  const gridEl          = document.getElementById('antilibrary-grid');
  const loadingEl       = document.getElementById('antilibrary-loading');
  const emptyEl         = document.getElementById('antilibrary-empty');
  const dropdownBtn     = document.getElementById('collection-dropdown-antilibrary');

  // Markup not present on this page (e.g. old cached HTML) — bail quietly.
  if (!modal) return;

  let books        = [];
  let searchTimer   = null;
  let searchToken   = 0; // guards against out-of-order async responses

  /* =============================================
     OPEN / CLOSE
     ============================================= */
  function openAntilibraryModal() {
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    resetSearch();
    loadBooks();
  }

  function closeAntilibraryModal() {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    searchResultsEl.classList.add('hidden');
  }

  dropdownBtn?.addEventListener('click', () => {
    closeCollectionDropdown();
    openAntilibraryModal();
  });

  closeBtn.addEventListener('click', closeAntilibraryModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeAntilibraryModal(); });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || modal.classList.contains('hidden')) return;
    if (searchInput.value.trim()) { resetSearch(); return; }
    closeAntilibraryModal();
  });

  // Close automatically if the admin signs out mid-session
  db.auth.onAuthStateChange((_e, session) => {
    if (!session && !modal.classList.contains('hidden')) closeAntilibraryModal();
  });

  /* =============================================
     LOAD + RENDER SAVED BOOKS
     ============================================= */
  async function loadBooks() {
    gridEl.innerHTML = '';
    emptyEl.classList.add('hidden');
    loadingEl.classList.remove('hidden');

    const { data, error } = await db
      .from('antilibrary_books')
      .select('*')
      .eq('author', currentUsername)
      .order('created_at', { ascending: false });

    loadingEl.classList.add('hidden');

    if (error) {
      console.error('[Antilibrary] load error:', error);
      gridEl.innerHTML = `<p class="antilibrary-error">Could not load your antilibrary.</p>`;
      return;
    }

    books = data || [];
    renderGrid();
  }

  function renderGrid() {
    gridEl.innerHTML = '';
    if (!books.length) {
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    books.forEach(book => gridEl.appendChild(buildBookCard(book)));
  }

  function buildBookCard(book) {
    const card = document.createElement('div');
    card.className = 'antilibrary-card';
    card.dataset.id = book.id;

    const authors = (book.authors && book.authors.length)
      ? book.authors.join(', ')
      : 'Unknown author';

    const cover = book.cover_url
      ? `<img src="${escapeHtml(book.cover_url)}" alt="${escapeHtml(book.title)}" loading="lazy">`
      : `<div class="antilibrary-cover-fallback">${escapeHtml((book.title || '?')[0])}</div>`;

    card.innerHTML = `
      <div class="antilibrary-cover">${cover}</div>
      <div class="antilibrary-info">
        <div class="antilibrary-title">${escapeHtml(book.title)}</div>
        <div class="antilibrary-authors">${escapeHtml(authors)}${book.published_year ? ' · ' + escapeHtml(book.published_year) : ''}</div>
        ${book.language ? `<span class="antilibrary-lang">${escapeHtml(book.language.toUpperCase())}</span>` : ''}
        <p class="antilibrary-blurb">${escapeHtml(book.description || 'No description available.')}</p>
      </div>
      <button class="antilibrary-remove" title="Remove from antilibrary">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6h16Z"
                stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    `;

    card.querySelector('.antilibrary-remove').addEventListener('click', () => removeBook(book.id, card));
    return card;
  }

  async function removeBook(id, card) {
    card.classList.add('antilibrary-card--removing');
    const { error } = await db.from('antilibrary_books').delete().eq('id', id);

    if (error) {
      console.error('[Antilibrary] delete error:', error);
      card.classList.remove('antilibrary-card--removing');
      alert('Could not remove this book.');
      return;
    }

    books = books.filter(b => b.id !== id);
    setTimeout(() => {
      card.remove();
      if (!books.length) emptyEl.classList.remove('hidden');
    }, 180);
  }

  /* =============================================
     SEARCH (Google Books API)
     ============================================= */
  function resetSearch() {
    searchInput.value = '';
    searchResultsEl.innerHTML = '';
    searchResultsEl.classList.add('hidden');
    searchClearBtn.classList.add('hidden');
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    searchClearBtn.classList.toggle('hidden', !q);

    if (!q) {
      searchResultsEl.innerHTML = '';
      searchResultsEl.classList.add('hidden');
      return;
    }

    searchTimer = setTimeout(() => runSearch(q), SEARCH_DEBOUNCE_MS);
  });

  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      clearTimeout(searchTimer);
      const q = searchInput.value.trim();
      if (q) runSearch(q);
    }
    if (e.key === 'Escape' && searchInput.value.trim()) {
      e.stopPropagation(); // let the modal-level Escape handler decide separately
      resetSearch();
    }
  });

  searchInput.addEventListener('focus', () => {
    if (searchInput.value.trim() && searchResultsEl.innerHTML) {
      searchResultsEl.classList.remove('hidden');
    }
  });

  searchClearBtn.addEventListener('click', () => {
    resetSearch();
    searchInput.focus();
  });

  document.addEventListener('click', e => {
    if (modal.classList.contains('hidden')) return;
    if (!searchResultsEl.contains(e.target) && e.target !== searchInput) {
      searchResultsEl.classList.add('hidden');
    }
  });

  let currentSearchController = null;

  async function runSearch(query, attempt = 0) {
    const token = ++searchToken;

    // Cancel any request still in flight so retyping doesn't pile up calls
    currentSearchController?.abort();
    currentSearchController = new AbortController();

    searchResultsEl.classList.remove('hidden');
    if (attempt === 0) {
      searchResultsEl.innerHTML = `<div class="antilibrary-search-loading"><div class="spinner" style="width:22px;height:22px;margin:16px auto;"></div></div>`;
    }

    try {
      const keyParam = GOOGLE_BOOKS_API_KEY ? `&key=${GOOGLE_BOOKS_API_KEY}` : '';
      const url = `${GOOGLE_BOOKS_API}?q=${encodeURIComponent(query)}&maxResults=10&printType=books${keyParam}`;
      const res = await fetch(url, { signal: currentSearchController.signal });

      if (token !== searchToken) return; // superseded by a newer search

      if (res.status === 429) {
        if (attempt < 2) {
          // Back off and retry once or twice before giving up
          await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
          if (token !== searchToken) return;
          return runSearch(query, attempt + 1);
        }
        searchResultsEl.innerHTML = `<p class="antilibrary-search-empty">Search is rate-limited right now — wait a moment and try again.</p>`;
        return;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data  = await res.json();
      const items = (data.items || []).filter(it => it.volumeInfo?.title);

      if (!items.length) {
        searchResultsEl.innerHTML = `<p class="antilibrary-search-empty">No results found.</p>`;
        return;
      }

      searchResultsEl.innerHTML = '';
      items.forEach(item => searchResultsEl.appendChild(buildResultRow(item)));

    } catch (err) {
      if (err.name === 'AbortError') return; // expected when a newer search cancels this one
      if (token !== searchToken) return;
      console.error('[Antilibrary] search error:', err);
      searchResultsEl.innerHTML = `<p class="antilibrary-search-empty">Search failed. Try again.</p>`;
    }
  }

  function buildResultRow(item) {
    const info    = item.volumeInfo || {};
    const authors = info.authors ? info.authors.join(', ') : 'Unknown author';
    const thumb   = (info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail || '').replace('http://', 'https://');
    const already = books.some(b => b.google_books_id === item.id);

    const row = document.createElement('div');
    row.className = 'antilibrary-result-row';
    row.innerHTML = `
      <div class="antilibrary-result-cover">
        ${thumb
          ? `<img src="${escapeHtml(thumb)}" alt="">`
          : `<div class="antilibrary-cover-fallback">${escapeHtml((info.title || '?')[0])}</div>`}
      </div>
      <div class="antilibrary-result-info">
        <div class="antilibrary-result-title">${escapeHtml(info.title)}</div>
        <div class="antilibrary-result-authors">${escapeHtml(authors)}${info.publishedDate ? ' · ' + escapeHtml(info.publishedDate.slice(0, 4)) : ''}</div>
      </div>
      <button class="antilibrary-add-btn" ${already ? 'disabled' : ''}>${already ? 'Added' : 'Add'}</button>
    `;

    const btn = row.querySelector('.antilibrary-add-btn');
    if (!already) btn.addEventListener('click', () => addBook(item, btn));
    return row;
  }

  function stripHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.innerHTML = str;
    return (div.textContent || div.innerText || '').trim();
  }

  async function addBook(item, btn) {
    btn.disabled = true;
    btn.textContent = 'Adding…';

    const info  = item.volumeInfo || {};
    const cover = (info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail || '').replace('http://', 'https://');

    const { data: { session } } = await db.auth.getSession();
    if (!session) { btn.disabled = false; btn.textContent = 'Add'; return; }

    const payload = {
      google_books_id: item.id,
      title:           info.title || 'Untitled',
      authors:         info.authors || [],
      cover_url:       cover || null,
      description:     stripHtml(info.description).slice(0, 800) || null,
      language:        info.language || null,
      published_year:  info.publishedDate ? info.publishedDate.slice(0, 4) : null,
      author:          currentUsername,
      user_id:         session.user.id
    };

    const { data, error } = await db
      .from('antilibrary_books')
      .insert([payload])
      .select()
      .single();

    if (error) {
      console.error('[Antilibrary] insert error:', error);
      btn.textContent = error.code === '23505' ? 'Already added' : 'Add';
      btn.disabled = error.code !== '23505' ? false : true;
      return;
    }

    books.unshift(data);
    renderGrid();
    btn.textContent = 'Added';
  }

})();