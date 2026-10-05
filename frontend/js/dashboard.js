/* ============================================================
   NYC LMS — Student Dashboard
   Loads enrolled courses (with progress) and published courses
   from existing backend APIs. Endpoints, headers, and payloads
   are 100% unchanged.
   ============================================================ */

'use strict';

(function () {
  /* ------------------------------------------------------------*
   * Auth guard
   * ---------------------------------------------------------- */
  const token = localStorage.getItem('token');
  if (!token) {
    window.location.replace('login.html');
    return;
  }

  const AUTH_HEADER = { Authorization: 'Bearer ' + token };
  const REFRESH_AFTER_MS = 15000;

  /* ------------------------------------------------------------*
   * Element references
   * ---------------------------------------------------------- */
  const el = {
    welcome: document.getElementById('welcome'),
    welcomeSub: document.getElementById('welcomeSub'),
    avatar: document.getElementById('avatar'),
    studentName: document.getElementById('studentName'),
    logout: document.getElementById('logout'),

    enrolledStatus: document.getElementById('enrolledStatus'),
    enrolledCount: document.getElementById('enrolledCount'),
    courses: document.getElementById('courses'),

    browseSection: document.getElementById('browseSection'),
    browseStatus: document.getElementById('browseStatus'),
    browseGrid: document.getElementById('browseGrid'),

    dashSearch: document.getElementById('dashSearch'),
    continueSpotlight: document.getElementById('continueSpotlight'),
    spotlightThumb: document.getElementById('spotlightThumb'),
    spotlightTitle: document.getElementById('spotlightTitle'),
    spotlightProgressFill: document.getElementById('spotlightProgressFill'),
    spotlightPct: document.getElementById('spotlightPct'),
    spotlightCta: document.getElementById('spotlightCta'),
  };

  let user = {};
  try { user = JSON.parse(localStorage.getItem('user') || '{}') || {}; } catch (_) { user = {}; }

  let loadId = 0;
  let lastLoadedAt = 0;
  let rawEnrolled = [];
  let rawAvailable = [];
  let currentFilter = 'all';
  let searchQuery = '';

  /* ------------------------------------------------------------*
   * Helpers
   * ---------------------------------------------------------- */
  async function getJson(url, options) {
    let response;
    try {
      response = await fetch(url, options || {});
    } catch (_) {
      throw new Error('Cannot reach the server. Check your connection and try again.');
    }
    const data = await response.json().catch(function () { return {}; });

    if (response.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.replace('login.html');
      throw new Error('Your session has expired. Please log in again.');
    }
    if (!response.ok) {
      throw new Error(data.message || 'Request failed (' + response.status + ')');
    }
    return data;
  }

  function setState(node, message, isError, withRetry) {
    node.textContent = '';
    node.classList.toggle('error', Boolean(isError));
    node.appendChild(document.createTextNode(message));

    if (withRetry) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'retry-btn';
      retry.style.cssText = 'margin-left: 12px; padding: 4px 12px; border-radius: 6px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: #fff; cursor: pointer;';
      retry.textContent = 'Try again';
      retry.addEventListener('click', function () { load(); });
      node.appendChild(retry);
    }
  }

  function clearState(node) {
    node.textContent = '';
    node.classList.remove('error');
  }

  function percentOf(course) {
    const value = Math.round(Number(course.progress_percent) || 0);
    return Math.max(0, Math.min(100, value));
  }

  function plural(count, singular) {
    return count + ' ' + singular + (count === 1 ? '' : 's');
  }

  function firstName(fullName) {
    return String(fullName || '').trim().split(/\s+/)[0] || '';
  }

  function resolveThumbnailUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value.trim(), window.location.origin);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
      if (url.origin === window.location.origin && !url.pathname.startsWith('/media/thumbnails/')) return null;
      return url.href;
    } catch (_) { return null; }
  }

  function buildThumb(course) {
    const thumb = document.createElement('div');
    thumb.className = 'card-thumb';

    function addPlaceholder() {
      const placeholder = document.createElement('div');
      placeholder.className = 'thumb-placeholder';
      placeholder.setAttribute('aria-hidden', 'true');
      placeholder.innerHTML =
        '<svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>';
      thumb.appendChild(placeholder);
    }

    const thumbnailUrl = resolveThumbnailUrl(course.thumbnail);
    if (thumbnailUrl) {
      const img = document.createElement('img');
      img.src = thumbnailUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', function () {
        img.remove();
        addPlaceholder();
      });
      thumb.appendChild(img);
    } else {
      addPlaceholder();
    }
    return thumb;
  }

  function statusOf(course) {
    if (course.completed) return 'completed';
    if (percentOf(course) > 0) return 'progress';
    return 'new';
  }

  function badgeFor(course) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    const status = statusOf(course);

    if (status === 'completed') {
      badge.classList.add('done');
      badge.textContent = 'Completed';
    } else if (status === 'progress') {
      badge.classList.add('progress');
      badge.textContent = 'In progress';
    } else {
      badge.classList.add('new');
      badge.textContent = 'Not started';
    }
    return badge;
  }

  /* ------------------------------------------------------------*
   * Loading skeletons
   * ---------------------------------------------------------- */
  function renderSkeleton(container, count) {
    container.textContent = '';
    for (let i = 0; i < count; i += 1) {
      const card = document.createElement('article');
      card.className = 'course-card skeleton';
      card.setAttribute('aria-hidden', 'true');

      const thumb = document.createElement('div');
      thumb.className = 'card-thumb';

      const body = document.createElement('div');
      body.className = 'card-body';
      ['sk-line sk-title', 'sk-line', 'sk-line sk-short', 'sk-line sk-bar'].forEach(function (cls) {
        const line = document.createElement('div');
        line.className = cls;
        body.appendChild(line);
      });

      card.append(thumb, body);
      container.appendChild(card);
    }
  }

  /* ------------------------------------------------------------*
   * Spotlight Hero Update
   * ---------------------------------------------------------- */
  function updateSpotlight(enrolled) {
    if (!el.continueSpotlight) return;

    // Find course in progress
    const active = enrolled.find(function (c) { return statusOf(c) === 'progress'; }) || enrolled[0];

    if (!active) {
      el.continueSpotlight.hidden = true;
      return;
    }

    el.continueSpotlight.hidden = false;
    el.spotlightTitle.textContent = active.title;
    const percent = percentOf(active);
    el.spotlightProgressFill.style.width = percent + '%';
    el.spotlightPct.textContent = percent + '%';
    el.spotlightCta.href = 'player.html?course=' + encodeURIComponent(active.course_id);

    // Spotlight thumbnail
    el.spotlightThumb.textContent = '';
    const thumbnailUrl = resolveThumbnailUrl(active.thumbnail);
    if (thumbnailUrl) {
      const img = document.createElement('img');
      img.src = thumbnailUrl;
      img.alt = '';
      el.spotlightThumb.appendChild(img);
    } else {
      el.spotlightThumb.innerHTML = '<div style="width:100%;height:100%;display:grid;place-items:center;background:#261f1a;color:#ff6b2b;font-weight:800;">NYC</div>';
    }
  }

  function updateGreeting(enrolled) {
    if (!el.welcomeSub) return;

    if (!enrolled.length) {
      el.welcomeSub.textContent = 'Browse the available courses in the catalog to begin.';
      return;
    }

    const inProgress = enrolled.filter(function (c) { return statusOf(c) === 'progress'; }).length;
    const completed = enrolled.filter(function (c) { return statusOf(c) === 'completed'; }).length;

    if (inProgress > 0) {
      el.welcomeSub.textContent =
        'You have ' + plural(inProgress, 'course') + ' in progress. Pick up where you left off.';
    } else if (completed === enrolled.length) {
      el.welcomeSub.textContent = 'Outstanding! You have completed all your enrolled courses.';
    } else {
      el.welcomeSub.textContent = 'Start your first lesson whenever you are ready.';
    }
  }

  /* ------------------------------------------------------------*
   * Render Enrolled Courses
   * ---------------------------------------------------------- */
  function renderEnrolled() {
    let courses = rawEnrolled.slice();

    if (currentFilter === 'progress') {
      courses = courses.filter(function (c) { return statusOf(c) === 'progress'; });
    } else if (currentFilter === 'completed') {
      courses = courses.filter(function (c) { return statusOf(c) === 'completed'; });
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      courses = courses.filter(function (c) {
        return (c.title || '').toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q);
      });
    }

    el.courses.textContent = '';
    el.enrolledCount.textContent = rawEnrolled.length ? plural(rawEnrolled.length, 'course') : '';

    if (!rawEnrolled.length) {
      setState(
        el.enrolledStatus,
        'You are not enrolled in any courses yet. Browse the catalog below to get started.',
        false,
        false
      );
      return;
    }

    if (!courses.length) {
      setState(el.enrolledStatus, 'No enrolled courses match your filter.', false, false);
      return;
    }

    clearState(el.enrolledStatus);

    const rank = { progress: 0, new: 1, completed: 2 };
    const ordered = courses.sort(function (a, b) {
      return rank[statusOf(a)] - rank[statusOf(b)];
    });

    const fills = [];

    ordered.forEach(function (course) {
      const status = statusOf(course);
      const percent = percentOf(course);
      const totalLessons = Number(course.total_lessons) || 0;
      const doneLessons = Number(course.completed_lessons) || 0;

      const card = document.createElement('article');
      card.className = 'course-card' + (course.completed ? ' completed' : '');
      card.setAttribute('data-tilt', '');

      card.appendChild(buildThumb(course));

      const body = document.createElement('div');
      body.className = 'card-body';

      const head = document.createElement('div');
      head.className = 'card-head';
      const title = document.createElement('h3');
      title.className = 'card-title';
      title.textContent = course.title;
      head.appendChild(title);
      head.appendChild(badgeFor(course));

      const desc = document.createElement('p');
      desc.className = 'card-desc';
      desc.textContent = course.description || 'No description provided for this course.';

      const progressBlock = document.createElement('div');
      progressBlock.className = 'progress-block';
      const row = document.createElement('div');
      row.className = 'progress-row';
      const track = document.createElement('div');
      track.className = 'progress-track';
      track.setAttribute('role', 'progressbar');
      track.setAttribute('aria-valuenow', String(percent));
      const fill = document.createElement('div');
      fill.className = 'progress-fill';
      fill.style.width = '0%';
      fills.push({ node: fill, percent: percent });
      track.appendChild(fill);
      const pct = document.createElement('span');
      pct.className = 'progress-pct';
      pct.textContent = percent + '%';
      row.append(track, pct);

      const count = document.createElement('div');
      count.className = 'lesson-count';
      if (!totalLessons) {
        count.textContent = 'No lessons added yet';
      } else if (course.completed) {
        count.textContent = 'All ' + plural(totalLessons, 'lesson') + ' completed';
      } else {
        count.textContent = doneLessons + ' of ' + plural(totalLessons, 'lesson') + ' completed';
      }
      progressBlock.append(row, count);

      const actions = document.createElement('div');
      actions.className = 'card-actions';
      const link = document.createElement('a');
      link.className = 'btn btn-primary';
      link.href = 'player.html?course=' + encodeURIComponent(course.course_id);
      const label = status === 'completed'
        ? 'Review Course'
        : (status === 'progress' ? 'Continue Learning' : 'Start Learning');
      link.textContent = label;
      link.setAttribute('aria-label', label + ': ' + course.title);
      actions.appendChild(link);

      body.append(head, desc, progressBlock, actions);
      card.appendChild(body);
      el.courses.appendChild(card);
    });

    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () {
        fills.forEach(function (item) { item.node.style.width = item.percent + '%'; });
      });
    });

    if (window.NYC3D && window.NYC3D.initCardTiltEngine) {
      window.NYC3D.initCardTiltEngine();
    }
  }

  /* ------------------------------------------------------------*
   * Render Available Catalog Courses
   * ---------------------------------------------------------- */
  function renderBrowse() {
    const enrolledIds = new Set(rawEnrolled.map(function (c) { return Number(c.course_id); }));

    let available = rawAvailable.filter(function (course) {
      const isPublished = course.published === true || course.published === 't';
      return isPublished && !enrolledIds.has(Number(course.id));
    });

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      available = available.filter(function (c) {
        return (c.title || '').toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q);
      });
    }

    el.browseGrid.textContent = '';

    if (!available.length) {
      el.browseSection.hidden = true;
      return;
    }

    el.browseSection.hidden = false;
    clearState(el.browseStatus);

    available.forEach(function (course) {
      const card = document.createElement('article');
      card.className = 'course-card';
      card.setAttribute('data-tilt', '');

      card.appendChild(buildThumb(course));

      const body = document.createElement('div');
      body.className = 'card-body';

      const head = document.createElement('div');
      head.className = 'card-head';
      const title = document.createElement('h3');
      title.className = 'card-title';
      title.textContent = course.title;
      head.appendChild(title);

      const desc = document.createElement('p');
      desc.className = 'card-desc';
      desc.textContent = course.description || 'No description provided for this course.';

      const actions = document.createElement('div');
      actions.className = 'card-actions';
      const enrollBtn = document.createElement('button');
      enrollBtn.type = 'button';
      enrollBtn.className = 'btn btn-outline';
      enrollBtn.textContent = 'Enroll in Course';
      enrollBtn.setAttribute('aria-label', 'Enroll in ' + course.title);
      enrollBtn.addEventListener('click', function () {
        enrollBtn.disabled = true;
        enrollBtn.textContent = 'Enrolling…';
        enrollInCourse(course.id, enrollBtn);
      });
      actions.appendChild(enrollBtn);

      body.append(head, desc, actions);
      card.appendChild(body);
      el.browseGrid.appendChild(card);
    });

    if (window.NYC3D && window.NYC3D.initCardTiltEngine) {
      window.NYC3D.initCardTiltEngine();
    }
  }

  async function enrollInCourse(courseId, button) {
    try {
      await getJson('/api/enrollments', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, AUTH_HEADER),
        body: JSON.stringify({ course_id: Number(courseId) })
      });
      await load({ silent: true });
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Enroll in Course';
      setState(el.browseStatus, 'Could not enroll: ' + error.message, true, false);
    }
  }

  /* ------------------------------------------------------------*
   * Load everything
   * ---------------------------------------------------------- */
  async function load(options) {
    const silent = Boolean(options && options.silent);
    const currentLoad = ++loadId;

    if (!silent) {
      clearState(el.enrolledStatus);
      clearState(el.browseStatus);
      renderSkeleton(el.courses, 3);
      el.courses.setAttribute('aria-busy', 'true');
    }

    const results = await Promise.allSettled([
      getJson('/api/enrollments/my', { headers: AUTH_HEADER }),
      getJson('/api/courses')
    ]);

    if (currentLoad !== loadId) return;
    el.courses.removeAttribute('aria-busy');

    const enrolledResult = results[0];
    const coursesResult = results[1];

    if (enrolledResult.status === 'rejected' || !Array.isArray(enrolledResult.value)) {
      if (silent) return;
      el.courses.textContent = '';
      const reason = enrolledResult.status === 'rejected'
        ? enrolledResult.reason.message
        : 'The server returned an unexpected response.';
      setState(el.enrolledStatus, 'Unable to load your courses: ' + reason, true, true);
      return;
    }

    lastLoadedAt = Date.now();
    rawEnrolled = enrolledResult.value;
    if (coursesResult.status === 'fulfilled' && Array.isArray(coursesResult.value)) {
      rawAvailable = coursesResult.value;
    }

    renderEnrolled();
    updateSpotlight(rawEnrolled);
    updateGreeting(rawEnrolled);
    renderBrowse();
  }

  /* ------------------------------------------------------------*
   * Filtering & Search Event Handlers
   * ---------------------------------------------------------- */
  document.querySelectorAll('.filter-pill').forEach(function (pill) {
    pill.addEventListener('click', function () {
      document.querySelectorAll('.filter-pill').forEach(function (p) { p.classList.remove('active'); });
      pill.classList.add('active');
      currentFilter = pill.dataset.filter;
      renderEnrolled();
    });
  });

  if (el.dashSearch) {
    el.dashSearch.addEventListener('input', function (e) {
      searchQuery = e.target.value.trim();
      renderEnrolled();
      renderBrowse();
    });
  }

  /* ------------------------------------------------------------*
   * Init
   * ---------------------------------------------------------- */
  const name = String(user.name || '').trim();
  el.welcome.textContent = name ? 'Welcome back, ' + firstName(name) : 'Your courses';
  el.studentName.textContent = name || 'Student';
  el.avatar.textContent = (name || 'S').charAt(0).toUpperCase();

  el.logout.addEventListener('click', function () {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = 'login.html';
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && Date.now() - lastLoadedAt > REFRESH_AFTER_MS) {
      load({ silent: true });
    }
  });

  load();
})();
