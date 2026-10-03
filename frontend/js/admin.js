/* ============================================================
   NYC LMS — Admin Dashboard
   Frontend only. Talks to the existing Express/PostgreSQL API:
     GET  /api/courses
     POST /api/courses
   ============================================================ */

'use strict';

/* ------------------------------------------------------------
 * Config
 * ---------------------------------------------------------- */
const API = {
  courses: '/api/courses',
};

/* ------------------------------------------------------------
 * State
 * ---------------------------------------------------------- */
const state = {
  courses: [],        // raw list from the backend
  searchQuery: '',
};

/* ------------------------------------------------------------
 * Element references
 * ---------------------------------------------------------- */
const el = {
  // stats
  statTotalCourses: document.getElementById('statTotalCourses'),
  statPublishedCourses: document.getElementById('statPublishedCourses'),

  // courses section
  coursesLoading: document.getElementById('coursesLoading'),
  coursesError: document.getElementById('coursesError'),
  coursesErrorMessage: document.getElementById('coursesErrorMessage'),
  coursesEmpty: document.getElementById('coursesEmpty'),
  coursesTableWrap: document.getElementById('coursesTableWrap'),
  coursesTableBody: document.getElementById('coursesTableBody'),
  coursesSubtitle: document.getElementById('coursesSubtitle'),
  courseSearch: document.getElementById('courseSearch'),

  // buttons
  btnRetryLoad: document.getElementById('btnRetryLoad'),
  btnOpenCreateModal: document.getElementById('btnOpenCreateModal'),
  btnOpenCreateModal2: document.getElementById('btnOpenCreateModal2'),
  btnEmptyCreate: document.getElementById('btnEmptyCreate'),
  btnToggleSidebar: document.getElementById('btnToggleSidebar'),
  scrim: document.getElementById('scrim'),

  // profile menu
  btnProfile: document.getElementById('btnProfile'),
  profileMenu: document.getElementById('profileMenu'),

  // modal
  modal: document.getElementById('createModal'),
  form: document.getElementById('createCourseForm'),
  inputTitle: document.getElementById('courseTitle'),
  inputDescription: document.getElementById('courseDescription'),
  inputThumbnail: document.getElementById('courseThumbnail'),
  inputPublished: document.getElementById('coursePublished'),
  titleError: document.getElementById('titleError'),
  formError: document.getElementById('formError'),
  btnSubmitCreate: document.getElementById('btnSubmitCreate'),

  // toasts
  toasts: document.getElementById('toasts'),
};

let lastFocusedElement = null;

/* ============================================================
 * Utilities
 * ============================================================ */

/**
 * Escape a string for safe insertion into HTML.
 * Never trust data coming from the backend or anywhere else.
 */
function escapeHTML(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Format an ISO date (or any date string) into a readable date. */
function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Format the course ID (handles numeric ids, UUIDs, etc.). */
function formatId(course) {
  const id = course.id ?? course.course_id;
  if (id === null || id === undefined) return '—';
  return String(id);
}

/** Count published courses from the fetched list. */
function countPublished(courses) {
  return courses.filter((c) => c.published === true).length;
}

/* ============================================================
 * Toast notifications
 * ============================================================ */

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

  const icon = type === 'success'
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';

  const iconEl = document.createElement('span');
  iconEl.className = 'toast__icon';
  iconEl.setAttribute('aria-hidden', 'true');
  iconEl.innerHTML = icon; // static, trusted markup only

  const msg = document.createElement('span');
  msg.textContent = message; // text node — no HTML injection possible

  toast.append(iconEl, msg);
  el.toasts.appendChild(toast);

  window.setTimeout(() => {
    toast.classList.add('is-leaving');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, 4000);
}

/* ============================================================
 * Courses — fetching & rendering
 * ============================================================ */

/**
 * Fetch courses from the backend and re-render the UI.
 */
async function loadCourses() {
  showCourseState('loading');

  let data;
  try {
    const response = await fetch(API.courses, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`The server responded with status ${response.status}.`);
    }

    data = await response.json();
  } catch (err) {
    // Network failure (server down, DNS, CORS…) or bad JSON
    showCourseState('error', err);
    return;
  }

  if (!Array.isArray(data)) {
    showCourseState('error', new Error('The server returned an unexpected response.'));
    return;
  }

  state.courses = data;
  updateStats();
  renderCourses();
}

function showCourseState(view, err) {
  el.coursesLoading.hidden = view !== 'loading';
  el.coursesError.hidden = view !== 'error';
  el.coursesEmpty.hidden = view !== 'empty';
  el.coursesTableWrap.hidden = view !== 'table';

  if (view === 'error' && err) {
    const isNetworkError = err instanceof TypeError;
    el.coursesErrorMessage.textContent = isNetworkError
      ? 'Cannot reach the backend server. Make sure the Express server is running.'
      : err.message;
  }
}

/** Update the stat cards from real data only. */
function updateStats() {
  el.statTotalCourses.textContent = String(state.courses.length);
  el.statPublishedCourses.textContent = String(countPublished(state.courses));
  // Students & Lessons are intentionally left as "Coming soon" — no fake data.
}

/** Render the course table (with search filter applied). */
function renderCourses() {
  const query = state.searchQuery.trim().toLowerCase();
  const visible = query
    ? state.courses.filter((c) =>
        String(c.title ?? '').toLowerCase().includes(query) ||
        String(c.description ?? '').toLowerCase().includes(query)
      )
    : state.courses;

  el.coursesSubtitle.textContent = query
    ? `${visible.length} of ${state.courses.length} courses match "${state.searchQuery.trim()}".`
    : 'Manage the courses in your catalog.';

  el.coursesTableBody.textContent = '';

  if (state.courses.length === 0) {
    showCourseState('empty');
    return;
  }

  if (visible.length === 0) {
    // Has courses, but none match the search — show an inline notice.
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.style.textAlign = 'center';
    cell.style.padding = '40px 24px';
    cell.style.color = 'var(--text-secondary)';
    cell.textContent = 'No courses match your search.';
    row.appendChild(cell);
    el.coursesTableBody.appendChild(row);
    showCourseState('table');
    return;
  }

  const fragment = document.createDocumentFragment();

  visible.forEach((course) => {
    const tr = document.createElement('tr');
    tr.className = 'row-enter';

    /* --- Course cell (thumbnail + title + description) --- */
    const tdCourse = document.createElement('td');
    const courseCell = document.createElement('div');
    courseCell.className = 'course-cell';

    if (course.thumbnail) {
      const img = document.createElement('img');
      img.className = 'course-thumb';
      img.src = course.thumbnail;
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => {
        // Fallback if the image fails to load.
        img.replaceWith(buildThumbPlaceholder());
      };
      courseCell.appendChild(img);
    } else {
      courseCell.appendChild(buildThumbPlaceholder());
    }

    const textWrap = document.createElement('div');

    const title = document.createElement('span');
    title.className = 'course-cell__title';
    title.textContent = course.title ?? 'Untitled course';

    const desc = document.createElement('span');
    desc.className = 'course-cell__desc';
    desc.textContent = course.description || 'No description provided.';

    textWrap.append(title, desc);
    courseCell.appendChild(textWrap);
    tdCourse.appendChild(courseCell);

    /* --- Status badge --- */
    const tdStatus = document.createElement('td');
    const badge = document.createElement('span');
    const isPublished = course.published === true;
    badge.className = `badge ${isPublished ? 'badge--published' : 'badge--draft'}`;
    badge.textContent = isPublished ? 'Published' : 'Draft';
    tdStatus.appendChild(badge);

    /* --- ID --- */
    const tdId = document.createElement('td');
    const idSpan = document.createElement('span');
    idSpan.className = 'cell-id';
    idSpan.textContent = formatId(course);
    tdId.appendChild(idSpan);

    /* --- Created date --- */
    const tdDate = document.createElement('td');
    tdDate.className = 'cell-date';
    tdDate.textContent = formatDate(course.created_at ?? course.createdAt ?? course.created);

    /* --- Actions --- */
    const tdActions = document.createElement('td');
    tdActions.className = 'col-actions';
    const actionsWrap = document.createElement('div');
    actionsWrap.className = 'row-actions';

    const viewBtn = document.createElement('button');
    viewBtn.type = 'button';
    viewBtn.className = 'btn btn--secondary btn--sm';
    viewBtn.textContent = 'View';
    viewBtn.addEventListener('click', () => {
      showToast(`"${course.title ?? 'Course'}" — full course management coming soon.`, 'success');
    });

    actionsWrap.appendChild(viewBtn);
    tdActions.appendChild(actionsWrap);

    tr.append(tdCourse, tdStatus, tdId, tdDate, tdActions);
    fragment.appendChild(tr);
  });

  el.coursesTableBody.appendChild(fragment);
  showCourseState('table');
}

/** Placeholder thumbnail when no image is provided. */
function buildThumbPlaceholder() {
  const wrap = document.createElement('span');
  wrap.className = 'course-thumb course-thumb--placeholder';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';
  return wrap;
}

/* ============================================================
 * Create course modal
 * ============================================================ */

function openModal() {
  lastFocusedElement = document.activeElement;
  el.modal.hidden = false;
  document.body.style.overflow = 'hidden';
  // Reset any previous errors each time the modal opens.
  clearFormErrors();
  window.setTimeout(() => el.inputTitle.focus(), 60);
  document.addEventListener('keydown', handleModalKeydown);
}

function closeModal() {
  el.modal.hidden = true;
  document.body.style.overflow = '';
  el.form.reset();
  clearFormErrors();
  document.removeEventListener('keydown', handleModalKeydown);
  if (lastFocusedElement) lastFocusedElement.focus();
}

/** Keep Tab focus trapped inside the modal while it's open. */
function handleModalKeydown(event) {
  if (event.key !== 'Tab') return;

  const focusable = el.modal.querySelectorAll(
    'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'
  );
  if (focusable.length === 0) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function clearFormErrors() {
  el.titleError.hidden = true;
  el.inputTitle.classList.remove('is-invalid');
  el.formError.hidden = true;
  el.formError.textContent = '';
}

function showFormError(message) {
  el.formError.textContent = message;
  el.formError.hidden = false;
}

/** Handle form submission: POST /api/courses */
async function handleCreateSubmit(event) {
  event.preventDefault();
  clearFormErrors();

  const title = el.inputTitle.value.trim();

  // Client-side validation
  if (!title) {
    el.titleError.hidden = false;
    el.inputTitle.classList.add('is-invalid');
    el.inputTitle.focus();
    return;
  }

  const payload = {
    title: title,
    description: el.inputDescription.value.trim(),
    thumbnail: el.inputThumbnail.value.trim(),
    published: el.inputPublished.checked,
  };

  setSubmitLoading(true);

  try {
    const response = await fetch(API.courses, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      // Try to read a server-provided error message.
      let serverMessage = '';
      try {
        const body = await response.json();
        serverMessage = body.message || body.error || '';
      } catch (_) { /* response wasn't JSON — ignore */ }

      throw new Error(
        serverMessage || `The server rejected the request (status ${response.status}).`
      );
    }

    // Success — the backend created the course.
    closeModal();
    showToast(`Course "${title}" created successfully.`);
    await loadCourses(); // refresh list + stats
  } catch (err) {
    if (err instanceof TypeError) {
      showFormError('Cannot reach the backend server. Check that the Express server is running.');
    } else {
      showFormError(err.message || 'Something went wrong while creating the course.');
    }
  } finally {
    setSubmitLoading(false);
  }
}

function setSubmitLoading(isLoading) {
  el.btnSubmitCreate.classList.toggle('is-loading', isLoading);
  el.btnSubmitCreate.disabled = isLoading;
}

/* ============================================================
 * Sidebar (mobile) & profile menu
 * ============================================================ */

function toggleSidebar(open) {
  const willOpen = typeof open === 'boolean' ? open : !document.body.classList.contains('sidebar-open');
  document.body.classList.toggle('sidebar-open', willOpen);
  el.scrim.hidden = !willOpen;
  el.btnToggleSidebar.setAttribute('aria-expanded', String(willOpen));
}

function closeSidebar() {
  toggleSidebar(false);
}

function toggleProfileMenu() {
  const isOpen = !el.profileMenu.hidden;
  el.profileMenu.hidden = isOpen;
  el.btnProfile.setAttribute('aria-expanded', String(!isOpen));
}

function closeProfileMenu() {
  el.profileMenu.hidden = true;
  el.btnProfile.setAttribute('aria-expanded', 'false');
}

/* ============================================================
 * Event wiring
 * ============================================================ */

function bindEvents() {
  // Create-course triggers
  el.btnOpenCreateModal.addEventListener('click', openModal);
  el.btnOpenCreateModal2.addEventListener('click', openModal);
  el.btnEmptyCreate.addEventListener('click', openModal);

  // Modal close triggers (backdrop, X, Cancel)
  el.modal.querySelectorAll('[data-close-modal]').forEach((node) => {
    node.addEventListener('click', closeModal);
  });

  // Form submit
  el.form.addEventListener('submit', handleCreateSubmit);

  // Live-clear the title error as the user types
  el.inputTitle.addEventListener('input', () => {
    if (!el.titleError.hidden) {
      el.titleError.hidden = true;
      el.inputTitle.classList.remove('is-invalid');
    }
  });

  // Retry button on error state
  el.btnRetryLoad.addEventListener('click', loadCourses);

  // Search filter
  el.courseSearch.addEventListener('input', (event) => {
    state.searchQuery = event.target.value;
    renderCourses();
  });

  // Mobile sidebar
  el.btnToggleSidebar.addEventListener('click', () => toggleSidebar());
  el.scrim.addEventListener('click', closeSidebar);

  // Profile dropdown
  el.btnProfile.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleProfileMenu();
  });

  document.addEventListener('click', (event) => {
    if (!el.profileMenu.hidden && !el.profileMenu.contains(event.target)) {
      closeProfileMenu();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!el.modal.hidden) closeModal();
      closeProfileMenu();
      closeSidebar();
    }
  });

  // Sidebar "Courses" nav link smooth-scrolls to the courses panel
  document.querySelectorAll('.sidebar__nav a[href="#courses"]').forEach((link) => {
    link.addEventListener('click', () => closeSidebar());
  });
}

/* ============================================================
 * Init
 * ============================================================ */

function init() {
  bindEvents();
  loadCourses();
}

document.addEventListener('DOMContentLoaded', init);
