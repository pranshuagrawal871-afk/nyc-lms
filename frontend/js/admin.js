/* ============================================================
   NYC LMS — Admin Dashboard
   Frontend only. Talks to the Express/PostgreSQL course,
   module, lesson and upload APIs (endpoints and payloads are
   unchanged from the previous version).
   ============================================================ */

'use strict';

/* ------------------------------------------------------------
 * Config
 * ---------------------------------------------------------- */
const API = {
  courses: '/api/courses',
  modules: '/api/modules',
  lessons: '/api/lessons',
  upload: '/api/upload',
};

const MEDIA_ACCEPT = {
  video: '.mp4,.webm,.mov',
  audio: '.mp3,.wav,.m4a',
  any: '.mp4,.webm,.mov,.mp3,.wav,.m4a',
};

const FOCUSABLE =
  'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])';

/* ------------------------------------------------------------
 * State
 * ---------------------------------------------------------- */
const state = {
  courses: [],        // raw list from the backend
  students: [],       // raw list from the backend
  searchQuery: '',
  activeCourse: null,
  activeModules: [],
  activeLessons: [],
};

let lastFocusedElement = null;
let lessonsRequestId = 0;   // ignores stale lesson responses
let modulesRequestId = 0;   // ignores stale module responses
let activeUploads = 0;      // warns before leaving mid-upload
let thumbnailObjectUrl = null;

/* ------------------------------------------------------------
 * Element references
 * ---------------------------------------------------------- */
const el = {
  // stats
  statTotalCourses: document.getElementById('statTotalCourses'),
  statPublishedCourses: document.getElementById('statPublishedCourses'),
  overviewCourses: document.getElementById('overviewCourses'),
  overviewStudents: document.getElementById('overviewStudents'),

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

  // create-course modal
  modal: document.getElementById('createModal'),
  form: document.getElementById('createCourseForm'),
  inputTitle: document.getElementById('courseTitle'),
  inputDescription: document.getElementById('courseDescription'),
  inputThumbnail: document.getElementById('courseThumbnail'),
  inputThumbnailFile: document.getElementById('courseThumbnailFile'),
  thumbnailPreview: document.getElementById('thumbnailPreview'),
  thumbnailPreviewImage: document.getElementById('thumbnailPreviewImage'),
  thumbnailPreviewLabel: document.getElementById('thumbnailPreviewLabel'),
  inputPublished: document.getElementById('coursePublished'),
  titleError: document.getElementById('titleError'),
  formError: document.getElementById('formError'),
  btnSubmitCreate: document.getElementById('btnSubmitCreate'),

  // course-content modal
  courseContentModal: document.getElementById('courseContentModal'),
  courseContentTitle: document.getElementById('courseContentTitle'),
  courseContentThumbnail: document.getElementById('courseContentThumbnail'),
  courseContentPublished: document.getElementById('courseContentPublished'),
  moduleSelect: document.getElementById('moduleSelect'),
  createModuleForm: document.getElementById('createModuleForm'),
  newModuleTitle: document.getElementById('newModuleTitle'),
  addModuleButton: document.getElementById('addModuleButton'),
  createLessonForm: document.getElementById('createLessonForm'),
  newLessonTitle: document.getElementById('newLessonTitle'),
  newLessonType: document.getElementById('newLessonType'),
  addLessonButton: document.getElementById('addLessonButton'),
  courseContentStatus: document.getElementById('courseContentStatus'),
  courseLessonsList: document.getElementById('courseLessonsList'),

  // toasts
  toasts: document.getElementById('toasts'),
};

/* ============================================================
 * Utilities
 * ============================================================ */

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

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  if (hours) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  }
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function formatFileSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function resolveThumbnailUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim(), API_BASE_URL);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.origin === API_BASE_URL && !url.pathname.startsWith('/media/thumbnails/')) return null;
    return url.href;
  } catch (_) { return null; }
}

function setThumbnailPreview(source, label) {
  if (thumbnailObjectUrl && thumbnailObjectUrl !== source) {
    URL.revokeObjectURL(thumbnailObjectUrl);
    thumbnailObjectUrl = null;
  }
  if (!source) { el.thumbnailPreview.hidden = true; el.thumbnailPreviewImage.removeAttribute('src'); return; }
  if (source.startsWith('blob:')) thumbnailObjectUrl = source;
  el.thumbnailPreviewImage.onerror = () => { el.thumbnailPreview.hidden = true; };
  el.thumbnailPreviewImage.onload = () => { el.thumbnailPreview.hidden = false; };
  el.thumbnailPreviewImage.src = source;
  el.thumbnailPreviewLabel.textContent = label || 'Preview';
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}

/** JSON request helper. Throws an Error carrying the server's message. */
async function apiJson(url, options = {}) {
  let response;
  try {
    const headers = new Headers(options.headers || {});
    const token = localStorage.getItem('token');
    if (token) headers.set('Authorization', `Bearer ${token}`);
    response = await fetch(apiUrl(url), { ...options, headers });
  } catch (_) {
    throw new Error('Cannot reach the backend server. Make sure the Express server is running.');
  }
  let body = {};
  try { body = await response.json(); } catch (_) { /* not JSON */ }
  if (!response.ok) throw new Error(body.message || `Request failed (${response.status})`);
  return body;
}

/**
 * Multipart upload with real progress (fetch can't report upload progress).
 * Same endpoint and form field as before; resolves with the parsed JSON.
 */
function uploadWithProgress(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl(url));
    const token = localStorage.getItem('token');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.responseType = 'text';

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && typeof onProgress === 'function') {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });

    xhr.addEventListener('load', () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch (_) { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body);
      } else {
        reject(new Error(body.message || `Request failed (${xhr.status})`));
      }
    });
    xhr.addEventListener('error', () => {
      reject(new Error('Cannot reach the backend server. The upload did not complete.'));
    });
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled.')));

    xhr.send(formData);
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

/** Keep the page from scrolling behind an open modal. */
function syncBodyScroll() {
  const anyOpen = !el.modal.hidden || !el.courseContentModal.hidden;
  document.body.style.overflow = anyOpen ? 'hidden' : '';
}

/** Keep Tab focus inside a modal, skipping disabled/hidden controls. */
function trapFocus(event, container) {
  if (event.key !== 'Tab') return;

  const focusable = Array.from(container.querySelectorAll(FOCUSABLE)).filter(
    (node) => !node.disabled && node.offsetParent !== null
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

function handleModalKeydown(event) { trapFocus(event, el.modal); }
function handleContentKeydown(event) { trapFocus(event, el.courseContentModal); }

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

  const visibleDuration = type === 'error' ? 5500 : 3500;
  window.setTimeout(() => {
    if (!toast.isConnected) return;

    toast.classList.add('is-leaving');
    const removeToast = () => toast.remove();
    toast.addEventListener('animationend', removeToast, { once: true });
    // Keep cleanup reliable when animations are disabled or interrupted.
    window.setTimeout(removeToast, 300);
  }, visibleDuration);
}

/* ============================================================
 * Courses — fetching & rendering
 * ============================================================ */

/** Fetch courses from the backend and re-render the UI. */
async function loadCourses() {
  showCourseState('loading');
  const serverStatus = document.getElementById('serverStatus');
  const serverStatusText = document.getElementById('serverStatusText');
  serverStatus.classList.remove('is-online', 'is-offline');
  serverStatus.classList.add('is-checking');
  serverStatusText.textContent = 'Checking server';

  let data;
  try {
    data = await apiJson(API.courses, {
      method: 'GET',
      cache: 'no-store',
      headers: { 'Accept': 'application/json' },
    });
  } catch (err) {
    // Network failure (server down, DNS, CORS…) or bad JSON
    serverStatus.classList.remove('is-checking', 'is-online');
    serverStatus.classList.add('is-offline');
    serverStatusText.textContent = 'Server unavailable';
    el.overviewCourses.textContent = 'Course data is unavailable right now.';
    showCourseState('error', err);
    return;
  }

  if (!Array.isArray(data)) {
    serverStatus.classList.remove('is-checking', 'is-online');
    serverStatus.classList.add('is-offline');
    serverStatusText.textContent = 'Server unavailable';
    el.overviewCourses.textContent = 'Course data is unavailable right now.';
    showCourseState('error', new Error('The server returned an unexpected response.'));
    return;
  }

  serverStatus.classList.remove('is-checking', 'is-offline');
  serverStatus.classList.add('is-online');
  serverStatusText.textContent = 'Server connected';
  state.courses = data;
  updateStats();
  renderCourses();
  renderOverviewCourses();
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
  if (window.NYC3D && window.NYC3D.animateCounters) {
    window.NYC3D.animateCounters();
  }
}

function renderOverviewCourses() {
  const list = el.overviewCourses;
  if (!list) return;
  list.textContent = '';
  const recent = state.courses.slice().sort((a, b) => new Date(b.created_at || b.createdAt || 0) - new Date(a.created_at || a.createdAt || 0)).slice(0, 4);
  if (!recent.length) {
    const empty = document.createElement('p'); empty.className = 'overview-empty'; empty.textContent = 'No courses in your catalog yet.'; list.appendChild(empty); return;
  }
  recent.forEach((course) => {
    const row = document.createElement('div'); row.className = 'overview-course-item';
    const imageUrl = resolveThumbnailUrl(course.thumbnail);
    if (imageUrl) { const img = document.createElement('img'); img.src = imageUrl; img.alt = ''; img.loading = 'lazy'; img.className = 'overview-thumb'; row.appendChild(img); }
    else row.appendChild(buildThumbPlaceholder());
    const details = document.createElement('div'); details.className = 'overview-item-details';
    const title = document.createElement('strong'); title.textContent = course.title || 'Untitled course';
    const meta = document.createElement('span'); meta.textContent = `${course.published === true || course.published === 't' ? 'Published' : 'Draft'} · ${Number(course.lesson_count) || 0} lessons`;
    details.append(title, meta);
    const manage = document.createElement('button'); manage.type = 'button'; manage.className = 'icon-btn overview-manage'; manage.textContent = 'Manage'; manage.setAttribute('aria-label', `Manage ${course.title || 'course'}`); manage.addEventListener('click', () => { showAdminScreen('courses'); document.getElementById('coursesHeading').focus(); openCourseContent(course); });
    row.append(details, manage); list.appendChild(row);
  });
}

function renderOverviewStudents() {
  const list = el.overviewStudents;
  if (!list) return;
  list.textContent = '';
  state.students.slice(0, 4).forEach((student) => {
    const row = document.createElement('div'); row.className = 'overview-student-item';
    const avatar = document.createElement('span'); avatar.className = 'overview-avatar'; avatar.textContent = String(student.name || '?').trim().charAt(0).toUpperCase();
    const details = document.createElement('div'); details.className = 'overview-item-details';
    const name = document.createElement('strong'); name.textContent = student.name || 'Unnamed student';
    const meta = document.createElement('span'); meta.textContent = student.email || 'Email unavailable';
    details.append(name, meta); row.append(avatar, details); list.appendChild(row);
  });
  if (!state.students.length) { const empty = document.createElement('p'); empty.className = 'overview-empty'; empty.textContent = 'No student accounts yet.'; list.appendChild(empty); }
}

function renderStudents() {
  const body = document.getElementById('studentsTableBody');
  const wrap = document.getElementById('studentsTableWrap');
  const status = document.getElementById('studentsStatus');
  const query = (document.getElementById('studentSearch').value || '').trim().toLowerCase();
  const students = state.students.filter((student) => !query || `${student.name || ''} ${student.email || ''}`.toLowerCase().includes(query));
  body.textContent = '';
  students.forEach((student) => {
    const row = document.createElement('tr');
    [student.name, student.email, student.enrolled_courses, student.completed_lessons, formatDate(student.created_at)].forEach((value) => {
      const cell = document.createElement('td'); cell.textContent = String(value ?? '—'); row.appendChild(cell);
    });
    body.appendChild(row);
  });
  wrap.hidden = students.length === 0;
  status.hidden = students.length > 0;
  status.textContent = students.length ? '' : query ? 'No students match your search.' : 'No students have registered yet.';
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
    cell.colSpan = 6;
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

    const thumbnailUrl = resolveThumbnailUrl(course.thumbnail);
    if (thumbnailUrl) {
      const img = document.createElement('img');
      img.className = 'course-thumb';
      img.src = thumbnailUrl;
      img.referrerPolicy = 'no-referrer';
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
    title.title = course.title ?? '';

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

    const tdLessons = document.createElement('td');
    tdLessons.className = 'cell-lessons';
    tdLessons.textContent = String(Number(course.lesson_count) || 0);

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

    const courseName = course.title || 'course';

    const viewBtn = document.createElement('button');
    viewBtn.type = 'button';
    viewBtn.className = 'btn btn--secondary btn--sm';
    viewBtn.textContent = 'View';
    viewBtn.setAttribute('aria-label', `View ${courseName}`);
    viewBtn.addEventListener('click', () => {
      window.location.href = `player.html?course=${encodeURIComponent(course.id)}`;
    });

    const manageBtn = document.createElement('button');
    manageBtn.type = 'button';
    manageBtn.className = 'btn btn--secondary btn--sm';
    manageBtn.textContent = 'Manage';
    manageBtn.setAttribute('aria-label', `Manage content for ${courseName}`);
    manageBtn.addEventListener('click', () => {
      openCourseContent(course);
    });

    const publishBtn = document.createElement('button');
    publishBtn.type = 'button'; publishBtn.className = 'btn btn--secondary btn--sm';
    publishBtn.textContent = isPublished ? 'Unpublish' : 'Publish';
    publishBtn.setAttribute('aria-label', `${isPublished ? 'Unpublish' : 'Publish'} ${courseName}`);
    publishBtn.addEventListener('click', async () => {
      publishBtn.disabled = true;
      try {
        await apiJson(`${API.courses}/${encodeURIComponent(course.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ published: !isPublished }) });
        showToast(`Course ${isPublished ? 'unpublished' : 'published'}.`);
        await loadCourses();
      } catch (error) { showToast(error.message, 'error'); publishBtn.disabled = false; }
    });

    actionsWrap.appendChild(viewBtn);
    actionsWrap.appendChild(manageBtn);
    actionsWrap.appendChild(publishBtn);
    tdActions.appendChild(actionsWrap);

    tr.append(tdCourse, tdStatus, tdLessons, tdId, tdDate, tdActions);
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
  syncBodyScroll();
  clearFormErrors();
  window.setTimeout(() => el.inputTitle.focus(), 60);
  document.addEventListener('keydown', handleModalKeydown);
}

function closeModal() {
  if (el.modal.hidden) return;
  el.modal.hidden = true;
  syncBodyScroll();
  el.form.reset();
  clearFormErrors();
  document.removeEventListener('keydown', handleModalKeydown);
  if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
    lastFocusedElement.focus();
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

function setSubmitLoading(isLoading) {
  el.btnSubmitCreate.classList.toggle('is-loading', isLoading);
  el.btnSubmitCreate.disabled = isLoading;
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
    if (el.inputThumbnailFile.files && el.inputThumbnailFile.files[0]) {
      const formData = new FormData();
      formData.append('thumbnail', el.inputThumbnailFile.files[0]);
      const upload = await apiJson(`${API.upload}/thumbnail`, { method: 'POST', body: formData });
      payload.thumbnail = upload.thumbnailUrl;
    }
    await apiJson(API.courses, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
    });

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

/* ============================================================
 * Course content modal (modules, lessons, media upload)
 * ============================================================ */

function openCourseContent(course) {
  lastFocusedElement = document.activeElement;
  state.activeCourse = course;
  state.activeModules = [];
  state.activeLessons = [];
  lessonsRequestId += 1;
  modulesRequestId += 1;

  el.courseContentTitle.textContent = course.title || 'Course content';
  el.courseContentThumbnail.textContent = '';
  const courseImageUrl = resolveThumbnailUrl(course.thumbnail);
  if (courseImageUrl) {
    const image = document.createElement('img');
    image.src = courseImageUrl; image.alt = ''; image.referrerPolicy = 'no-referrer';
    image.onerror = () => { el.courseContentThumbnail.textContent = ''; el.courseContentThumbnail.appendChild(buildThumbPlaceholder()); };
    el.courseContentThumbnail.appendChild(image);
  } else el.courseContentThumbnail.appendChild(buildThumbPlaceholder());
  const published = course.published === true || course.published === 't';
  el.courseContentPublished.textContent = published ? 'Published' : 'Draft';
  el.courseContentPublished.className = `badge ${published ? 'badge--published' : 'badge--draft'}`;
  el.courseContentStatus.textContent = 'Loading modules…';
  el.courseLessonsList.textContent = '';
  el.moduleSelect.textContent = '';
  el.addLessonButton.disabled = true;
  el.newModuleTitle.value = '';
  el.newLessonTitle.value = '';

  el.courseContentModal.hidden = false;
  el.courseContentModal.querySelector('.course-content-modal').scrollTop = 0;
  syncBodyScroll();
  document.addEventListener('keydown', handleContentKeydown);
  loadCourseModules();
  window.setTimeout(() => el.courseContentModal.querySelector('.workspace-back').focus({ preventScroll: true }), 40);
}

function closeCourseContent() {
  if (el.courseContentModal.hidden) return;
  el.courseContentModal.hidden = true;
  syncBodyScroll();
  document.removeEventListener('keydown', handleContentKeydown);
  state.activeCourse = null;
  lessonsRequestId += 1;
  modulesRequestId += 1;
  if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
    lastFocusedElement.focus();
  }
}

async function loadCourseModules(preferredModuleId) {
  const course = state.activeCourse;
  if (!course) return;
  const requestId = ++modulesRequestId;

  try {
    const modules = await apiJson(`${API.modules}/course/${course.id}`);
    // Ignore the response if the modal was closed/switched meanwhile.
    if (requestId !== modulesRequestId || state.activeCourse !== course) return;

    state.activeModules = modules;
    el.moduleSelect.textContent = '';
    modules.forEach((module) => {
      const option = document.createElement('option');
      option.value = module.id;
      option.textContent = module.title;
      el.moduleSelect.appendChild(option);
    });

    if (!modules.length) {
      el.courseContentStatus.textContent = 'Add a module to start building this course.';
      el.courseLessonsList.textContent = '';
      el.addLessonButton.disabled = true;
      return;
    }

    const selected = modules.find((module) => String(module.id) === String(preferredModuleId));
    el.moduleSelect.value = String(selected ? selected.id : modules[0].id);
    el.addLessonButton.disabled = false;
    await loadModuleLessons();
  } catch (error) {
    if (requestId !== modulesRequestId) return;
    el.courseContentStatus.textContent = error.message;
  }
}

async function loadModuleLessons() {
  const moduleId = el.moduleSelect.value;
  if (!moduleId) return;
  const requestId = ++lessonsRequestId;

  try {
    const lessons = await apiJson(`${API.lessons}/module/${moduleId}`);
    // Ignore if the user switched modules or closed the modal meanwhile.
    if (requestId !== lessonsRequestId || !state.activeCourse) return;

    state.activeLessons = lessons;
    el.courseContentStatus.textContent = lessons.length
      ? ''
      : 'No lessons yet. Add one above, then upload its media.';
    renderModuleLessons();
  } catch (error) {
    if (requestId !== lessonsRequestId) return;
    el.courseContentStatus.textContent = error.message;
  }
}

function renderModuleLessons() {
  el.courseLessonsList.textContent = '';
  const fragment = document.createDocumentFragment();

  state.activeLessons.forEach((lesson) => {
    const row = document.createElement('div');
    row.className = 'course-lesson-row';

    /* --- Lesson details --- */
    const details = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = lesson.title;

    const duration = document.createElement('span');
    duration.className = 'course-lesson-duration';
    const seconds = Number(lesson.duration);
    const hasDuration =
      Boolean(lesson.has_media || lesson.file_path) &&
      lesson.duration !== null &&
      lesson.duration !== undefined &&
      Number.isFinite(seconds) &&
      seconds >= 0;
    const typeLabel = typeof lesson.type === 'string' && lesson.type
      ? `${lesson.type.charAt(0).toUpperCase()}${lesson.type.slice(1)} · `
      : '';
    duration.textContent = hasDuration
      ? `${typeLabel}Duration: ${formatDuration(seconds)}`
      : `${typeLabel}Duration will be detected after upload.`;
    details.append(title, duration);

    /* --- Upload controls --- */
    const controls = document.createElement('div');
    controls.className = 'course-lesson-upload';

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = MEDIA_ACCEPT[lesson.type] || MEDIA_ACCEPT.any;
    input.setAttribute('aria-label', `Select media for ${lesson.title}`);

    const dropzone = document.createElement('label');
    dropzone.className = 'lesson-upload-dropzone';
    const dropIcon = document.createElement('span'); dropIcon.className = 'lesson-upload-icon'; dropIcon.setAttribute('aria-hidden', 'true'); dropIcon.textContent = '↑';
    const mediaLabel = lesson.type === 'audio' ? 'audio' : 'video';
    const dropTitle = document.createElement('strong'); dropTitle.textContent = hasDuration ? `Drop to replace ${mediaLabel}` : `Drop ${mediaLabel} here`;
    const dropHint = document.createElement('span'); dropHint.textContent = 'or browse files';
    dropzone.append(dropIcon, dropTitle, dropHint, input);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn--secondary btn--sm';
    button.textContent = hasDuration ? `Replace ${mediaLabel}` : `Add ${mediaLabel}`;
    button.disabled = true;

    const fileMeta = document.createElement('span');
    fileMeta.className = 'upload-file-meta';
    const progress = document.createElement('progress');
    progress.className = 'upload-progress';
    progress.max = 100;
    progress.value = 0;
    progress.hidden = true;
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      button.disabled = !file;
      fileMeta.textContent = file ? `${file.name} · ${formatFileSize(file.size)}` : '';
      dropzone.classList.toggle('is-selected', Boolean(file));
      if (file) dropTitle.textContent = file.name;
    });
    ['dragenter', 'dragover'].forEach((eventName) => dropzone.addEventListener(eventName, (event) => { event.preventDefault(); dropzone.classList.add('is-dragging'); }));
    ['dragleave', 'drop'].forEach((eventName) => dropzone.addEventListener(eventName, (event) => { event.preventDefault(); dropzone.classList.remove('is-dragging'); }));
    dropzone.addEventListener('drop', (event) => {
      if (!event.dataTransfer || !event.dataTransfer.files.length) return;
      input.files = event.dataTransfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    button.addEventListener('click', async () => {
      if (!input.files.length) return;
      const idleLabel = button.textContent;

      button.disabled = true;
      input.disabled = true;
      button.textContent = 'Uploading… 0%';
      progress.hidden = false;
      progress.value = 0;
      el.courseContentStatus.textContent = '';
      activeUploads += 1;

      const form = new FormData();
      form.append('media', input.files[0]);

      try {
        const result = await uploadWithProgress(
          `${API.upload}/lesson/${lesson.id}`,
          form,
          (percent) => {
            button.textContent = percent >= 100 ? 'Processing…' : `Uploading… ${percent}%`;
            progress.value = percent;
          }
        );

        const detectedSeconds = Number(result && result.lesson && result.lesson.duration);
        if (!Number.isFinite(detectedSeconds) || detectedSeconds < 0) {
          throw new Error('The server did not return a detected media duration.');
        }

        const doneMessage = `Upload complete. Detected duration: ${formatDuration(detectedSeconds)}.`;
        el.courseContentStatus.textContent = doneMessage;
        showToast(`"${lesson.title}" uploaded. Duration ${formatDuration(detectedSeconds)}.`);
        await loadModuleLessons();
      } catch (error) {
        el.courseContentStatus.textContent = error.message;
        showToast(error.message, 'error');
      } finally {
        activeUploads = Math.max(0, activeUploads - 1);
        // The row may have been re-rendered; only touch it if still attached.
        if (button.isConnected) {
          button.textContent = idleLabel;
          input.disabled = false;
          button.disabled = !input.files.length;
        }
      }
    });

    controls.append(dropzone, button, fileMeta, progress);
    row.append(details, controls);
    fragment.appendChild(row);
  });

  el.courseLessonsList.appendChild(fragment);
}

async function handleCreateModule(event) {
  event.preventDefault();
  const title = el.newModuleTitle.value.trim();
  if (!title || !state.activeCourse) return;

  el.addModuleButton.disabled = true;
  try {
    const result = await apiJson(`${API.modules}/course/${state.activeCourse.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, module_order: state.activeModules.length + 1 }),
    });
    el.newModuleTitle.value = '';
    showToast(`Module "${title}" added.`);
    await loadCourseModules(result.module.id);
  } catch (error) {
    el.courseContentStatus.textContent = error.message;
  } finally {
    el.addModuleButton.disabled = false;
  }
}

async function handleCreateLesson(event) {
  event.preventDefault();
  const title = el.newLessonTitle.value.trim();
  const moduleId = el.moduleSelect.value;
  if (!title || !moduleId) return;

  el.addLessonButton.disabled = true;
  try {
    await apiJson(`${API.lessons}/module/${moduleId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        type: el.newLessonType.value,
        lesson_order: state.activeLessons.length + 1,
      }),
    });
    el.newLessonTitle.value = '';
    showToast(`Lesson "${title}" added.`);
    await loadModuleLessons();
  } catch (error) {
    el.courseContentStatus.textContent = error.message;
  } finally {
    el.addLessonButton.disabled = !el.moduleSelect.value;
  }
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

const SCREEN_COPY = {
  overview: ['Overview', 'A live view of your learning platform.'],
  courses: ['Courses', 'Manage your course catalog.'],
  students: ['Students', 'Manage learners and review course activity.'],
  analytics: ['Analytics', 'Live metrics from your LMS database.'],
  settings: ['Settings', 'Account security and workspace preferences.'],
};

function showAdminScreen(name) {
  if (!SCREEN_COPY[name]) return;
  document.querySelectorAll('[data-admin-screen]').forEach((screen) => {
    screen.hidden = screen.dataset.adminScreen !== name;
    screen.classList.toggle('is-active', !screen.hidden);
  });
  document.querySelectorAll('.sidebar__nav [data-screen]').forEach((link) => {
    const active = link.dataset.screen === name;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  document.querySelector('.topbar__search').hidden = name !== 'courses';
  el.btnOpenCreateModal.hidden = name === 'overview' || name === 'courses';
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  closeSidebar();
  window.scrollTo({ top: 0, behavior: 'auto' });
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

/** Show the logged-in user's name/email if the login page stored them. */
function hydrateUser() {
  let user = null;
  try { user = JSON.parse(localStorage.getItem('user') || 'null'); } catch (_) { /* ignore */ }
  if (!user || typeof user !== 'object') return;

  const name = String(user.name || '').trim();
  const email = String(user.email || '').trim();

  if (name) {
    document.querySelectorAll('.profile__name, .sidebar__user-name').forEach((node) => {
      node.textContent = name;
    });
    document.querySelectorAll('.avatar').forEach((node) => {
      node.textContent = name.charAt(0).toUpperCase();
    });
  }
  if (email) {
    document.querySelectorAll('.profile__role').forEach((node) => {
      node.textContent = email;
    });
  }
}

function signOut() {
  try {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
  } catch (_) { /* ignore */ }
  window.location.href = 'login.html';
}

async function verifyAdminSession() {
  if (!localStorage.getItem('token')) { window.location.replace('login.html'); return false; }
  try {
    const result = await apiJson('/api/auth/me');
    if (result.user.role !== 'admin') { window.location.replace('dashboard.html'); return false; }
    localStorage.setItem('user', JSON.stringify(result.user));
    return true;
  } catch (_) { signOut(); return false; }
}

async function loadAdminData() {
  const [studentsResult, analyticsResult] = await Promise.allSettled([
    apiJson('/api/admin/students'), apiJson('/api/admin/analytics')
  ]);
  const studentsStatus = document.getElementById('studentsStatus');
  if (studentsResult.status === 'fulfilled') {
    state.students = studentsResult.value;
    renderStudents();
    renderOverviewStudents();
    document.getElementById('statTotalStudents').textContent = String(state.students.length);
  } else {
    studentsStatus.hidden = false; studentsStatus.textContent = studentsResult.reason.message;
    el.overviewStudents.textContent = 'Student data is unavailable right now.';
  }

  const analyticsStatus = document.getElementById('analyticsStatus');
  if (analyticsResult.status === 'fulfilled') {
    const values = analyticsResult.value;
    const metrics = document.getElementById('analyticsMetrics'); metrics.textContent = '';
    [['Students','total_students'],['Courses','total_courses'],['Published courses','published_courses'],['Lessons','total_lessons'],['Enrollments','total_enrollments'],['Completed lessons','completed_lessons'],['Completed courses','completed_courses']].forEach(([label,key]) => {
      const item = document.createElement('article'); item.className = 'admin-metric';
      const caption = document.createElement('span'); caption.textContent = label;
      const number = document.createElement('strong'); number.textContent = String(Number(values[key]) || 0);
      item.append(caption, number); metrics.appendChild(item);
    });
    metrics.hidden = false; analyticsStatus.hidden = true;
    document.getElementById('statTotalLessons').textContent = String(Number(values.total_lessons) || 0);
  } else analyticsStatus.textContent = analyticsResult.reason.message;
}

async function changePassword(event) {
  event.preventDefault();
  const form = document.getElementById('passwordForm');
  const button = document.getElementById('savePassword');
  const message = document.getElementById('passwordMessage');
  const currentPassword = document.getElementById('currentPassword').value;
  const newPassword = document.getElementById('newPassword').value;
  const confirmPassword = document.getElementById('confirmPassword').value;
  message.hidden = false; message.className = 'settings-alert settings-alert--error';
  if (newPassword.length < 8 || newPassword.length > 72) { message.textContent = 'New password must be between 8 and 72 characters.'; return; }
  if (newPassword !== confirmPassword) { message.textContent = 'The new passwords do not match.'; return; }
  button.disabled = true; button.textContent = 'Saving…'; message.hidden = true;
  try {
    const result = await apiJson('/api/auth/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword, newPassword }) });
    form.reset(); message.className = 'settings-alert settings-alert--success'; message.textContent = result.message; message.hidden = false;
  } catch (error) { message.textContent = error.message; message.hidden = false; }
  finally { button.disabled = false; button.textContent = 'Save password'; }
}

function updatePasswordHints() {
  const password = document.getElementById('newPassword').value;
  const confirmation = document.getElementById('confirmPassword').value;
  const strength = document.getElementById('passwordStrength');
  const strengthLabel = strength.querySelector('.password-strength__label');
  const score = password.length >= 8 ? 1 + [password.length >= 12, /[A-Z]/.test(password) && /[a-z]/.test(password), /\d/.test(password) || /[^A-Za-z0-9]/.test(password)].filter(Boolean).length : 0;
  strength.dataset.strength = String(score);
  strengthLabel.textContent = !password ? 'Password strength' : (password.length < 8 ? 'Too short' : ['','Weak','Fair','Good','Strong'][score]);
  const match = document.getElementById('passwordMatch');
  match.className = 'password-match';
  if (!confirmation) match.textContent = '';
  else if (password === confirmation) { match.textContent = 'Passwords match'; match.classList.add('is-match'); }
  else { match.textContent = 'Passwords do not match'; match.classList.add('is-mismatch'); }
}

/* ============================================================
 * Event wiring
 * ============================================================ */

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function bindEvents() {
  // Create-course triggers
  el.btnOpenCreateModal.addEventListener('click', openModal);
  el.btnOpenCreateModal2.addEventListener('click', openModal);
  el.btnEmptyCreate.addEventListener('click', openModal);
  document.getElementById('btnOverviewCreate').addEventListener('click', openModal);
  document.querySelectorAll('[data-navigate-screen]').forEach((button) => {
    button.addEventListener('click', () => showAdminScreen(button.dataset.navigateScreen));
  });

  // Modal close triggers (backdrop, X, Cancel)
  el.modal.querySelectorAll('[data-close-modal]').forEach((node) => {
    node.addEventListener('click', closeModal);
  });

  // Forms
  document.getElementById('passwordForm').addEventListener('submit', changePassword);
  document.querySelectorAll('[data-toggle-password]').forEach((button) => button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.togglePassword);
    input.type = input.type === 'password' ? 'text' : 'password';
    button.textContent = input.type === 'password' ? 'Show' : 'Hide';
  }));
  document.getElementById('newPassword').addEventListener('input', updatePasswordHints);
  document.getElementById('confirmPassword').addEventListener('input', updatePasswordHints);
  const reduceMotion = document.getElementById('reduceMotion');
  reduceMotion.checked = localStorage.getItem('nyc-lms:reduce-motion') === 'true';
  document.documentElement.classList.toggle('reduce-motion', reduceMotion.checked);
  reduceMotion.addEventListener('change', () => {
    localStorage.setItem('nyc-lms:reduce-motion', String(reduceMotion.checked));
    document.documentElement.classList.toggle('reduce-motion', reduceMotion.checked);
    if (window.NYC3D && window.NYC3D.setReducedMotion) window.NYC3D.setReducedMotion(reduceMotion.checked);
  });
  el.form.addEventListener('submit', handleCreateSubmit);
  el.form.addEventListener('reset', () => window.setTimeout(() => setThumbnailPreview(null), 0));
  el.inputThumbnailFile.addEventListener('change', () => {
    const file = el.inputThumbnailFile.files && el.inputThumbnailFile.files[0];
    if (file) {
      el.inputThumbnail.value = '';
      setThumbnailPreview(URL.createObjectURL(file), file.name);
    } else updateExternalThumbnailPreview();
  });
  const thumbnailDropzone = document.getElementById('thumbnailDropzone');
  ['dragenter', 'dragover'].forEach((eventName) => thumbnailDropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    thumbnailDropzone.classList.add('is-dragging');
  }));
  ['dragleave', 'drop'].forEach((eventName) => thumbnailDropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    thumbnailDropzone.classList.remove('is-dragging');
  }));
  thumbnailDropzone.addEventListener('drop', (event) => {
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (!file) return;
    el.inputThumbnailFile.files = event.dataTransfer.files;
    el.inputThumbnailFile.dispatchEvent(new Event('change', { bubbles: true }));
  });
  el.inputThumbnail.addEventListener('input', () => {
    if (el.inputThumbnail.value.trim()) el.inputThumbnailFile.value = '';
    updateExternalThumbnailPreview();
  });
  el.createModuleForm.addEventListener('submit', handleCreateModule);
  el.createLessonForm.addEventListener('submit', handleCreateLesson);
  el.moduleSelect.addEventListener('change', loadModuleLessons);
  el.courseContentModal.querySelectorAll('[data-close-course-content]').forEach((node) => {
    node.addEventListener('click', closeCourseContent);
  });

  // Live-clear the title error as the user types
  el.inputTitle.addEventListener('input', () => {
    if (!el.titleError.hidden) {
      el.titleError.hidden = true;
      el.inputTitle.classList.remove('is-invalid');
    }
  });

  // Retry button on error state
  el.btnRetryLoad.addEventListener('click', loadCourses);

  // Search filter (debounced) + Escape clears it
  const applySearch = debounce((value) => {
    state.searchQuery = value;
    renderCourses();
  }, 150);
  el.courseSearch.addEventListener('input', (event) => applySearch(event.target.value));
  el.courseSearch.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && el.courseSearch.value) {
      el.courseSearch.value = '';
      state.searchQuery = '';
      renderCourses();
    }
  });
  document.getElementById('studentSearch').addEventListener('input', renderStudents);

  // Mobile sidebar
  el.btnToggleSidebar.addEventListener('click', () => toggleSidebar());
  el.scrim.addEventListener('click', closeSidebar);

  // Profile dropdown
  el.btnProfile.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleProfileMenu();
  });

  el.profileMenu.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const label = link.textContent.trim().toLowerCase();
      closeProfileMenu();
      if (label === 'logout' || label === 'sign out') {
        signOut();
      } else if (link.dataset.screen) showAdminScreen(link.dataset.screen);
    });
  });

  document.addEventListener('click', (event) => {
    if (!el.profileMenu.hidden && !el.profileMenu.contains(event.target)) {
      closeProfileMenu();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!el.modal.hidden) closeModal();
      if (!el.courseContentModal.hidden) closeCourseContent();
      closeProfileMenu();
      closeSidebar();
      return;
    }

    // "/" jumps to the course search (like most dashboards)
    if (
      event.key === '/' &&
      !event.ctrlKey && !event.metaKey && !event.altKey &&
      !isTypingTarget(event.target) &&
      el.modal.hidden && el.courseContentModal.hidden
    ) {
      event.preventDefault();
      showAdminScreen('courses');
      el.courseSearch.focus();
    }
  });

  // Sidebar links switch app screens instead of scrolling a long page.
  document.querySelectorAll('.sidebar__nav a').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      showAdminScreen(link.dataset.screen);
    });
  });

  window.addEventListener('hashchange', () => {
    const screen = location.hash.slice(1);
    if (SCREEN_COPY[screen]) showAdminScreen(screen);
  });

  // Don't lose an in-progress upload by accident
  window.addEventListener('beforeunload', (event) => {
    if (activeUploads > 0) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}

function updateExternalThumbnailPreview() {
  const source = resolveThumbnailUrl(el.inputThumbnail.value);
  setThumbnailPreview(source, 'External image preview');
}

/* ============================================================
 * Init
 * ============================================================ */

async function init() {
  if (!(await verifyAdminSession())) return;
  hydrateUser();
  bindEvents();
  loadCourses();
  loadAdminData();
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  document.getElementById('settingsName').textContent = user.name || 'Administrator';
  document.getElementById('settingsEmail').textContent = user.email || '';
  document.getElementById('settingsAvatar').textContent = (user.name || 'A').charAt(0).toUpperCase();
  const requestedScreen = location.hash.slice(1);
  showAdminScreen(SCREEN_COPY[requestedScreen] ? requestedScreen : 'overview');
}

document.addEventListener('DOMContentLoaded', init);
