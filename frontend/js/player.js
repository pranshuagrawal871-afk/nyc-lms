/* ============================================================
   NYC LMS — Course Player
   Endpoints, headers and payloads are unchanged from the previous
   version (courses, enrollments, modules, lessons, progress, stream).
   ============================================================ */

(function () {
  "use strict";

  /* ============================================================
     Element references
     ============================================================ */
  const player        = document.getElementById("player");
  const video         = document.getElementById("lessonVideo");

  const bigPlay       = document.getElementById("bigPlay");
  const playBtn       = document.getElementById("playBtn");
  const iconPlay      = document.getElementById("iconPlay");
  const iconPause     = document.getElementById("iconPause");

  const progressArea     = document.getElementById("progressArea");
  const progressFilled   = document.getElementById("progressFilled");
  const progressBuffered = document.getElementById("progressBuffered");
  const progressThumb    = document.getElementById("progressThumb");
  const progressTrack    = progressArea.querySelector(".progress-track");

  const currentTimeEl   = document.getElementById("currentTime");
  const totalDurationEl = document.getElementById("totalDuration");

  const muteBtn      = document.getElementById("muteBtn");
  const iconVolOn    = document.getElementById("iconVolOn");
  const iconVolOff   = document.getElementById("iconVolOff");
  const volumeSlider = document.getElementById("volumeSlider");

  const speedBtn    = document.getElementById("speedBtn");
  const speedMenu   = document.getElementById("speedMenu");
  const pipBtn      = document.getElementById("pipBtn");
  const fsBtn       = document.getElementById("fsBtn");
  const iconFsEnter = document.getElementById("iconFsEnter");
  const iconFsExit  = document.getElementById("iconFsExit");

  const resumePill     = document.getElementById("resumePill");
  const resumePillText = document.getElementById("resumePillText");
  const completedToast = document.getElementById("completedToast");
  const nextBtn        = document.getElementById("nextBtn");
  const prevBtn        = document.getElementById("prevBtn");
  const prevLessonName = document.getElementById("prevLessonName");
  const nextLessonName = document.getElementById("nextLessonName");
  const courseTitleEl  = document.getElementById("courseTitle");
  const studentNameEl  = document.getElementById("studentName");
  const courseCountsEl = document.getElementById("courseCounts");
  const curriculumEl   = document.getElementById("curriculum");
  const curriculumStatusEl = document.getElementById("curriculumStatus");
  const lessonMetaEl     = document.getElementById("lessonMeta");
  const lessonTitleEl    = document.getElementById("lessonTitle");
  const lessonStatusEl   = document.getElementById("lessonStatus");
  const lessonOverviewEl = document.getElementById("lessonOverview");

  const courseProgressPct  = document.getElementById("courseProgressPct");
  const courseProgressFill = document.getElementById("courseProgressFill");
  const courseCompleteNote = document.getElementById("courseCompleteNote");

  /* ============================================================
     Configuration
     ============================================================ */

  const AUTH_TOKEN = localStorage.getItem("token");
  let SESSION_USER = {};
  try { SESSION_USER = JSON.parse(localStorage.getItem("user") || "{}"); } catch (_) { SESSION_USER = {}; }
  const IS_ADMIN = SESSION_USER.role === "admin";

  const params = new URLSearchParams(window.location.search);
  const courseParam = params.get("course");
  const courseId = courseParam === null ? 1 : Number(courseParam);
  const CURRENT_LESSON_KEY = "currentLessonId:" + courseId;

  const PREF = {
    speed: "player:speed",
    volume: "player:volume",
    muted: "player:muted"
  };

  const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
  const SEEK_STEP = 5;          // arrow keys
  const SEEK_STEP_LONG = 10;    // J / L keys
  const SAVE_INTERVAL = 5000;   // save progress every 5 seconds
  const CONTROLS_IDLE_MS = 2500;

  let lessonCompleted = false;
  let wasDragging = false;
  let progressLoaded = false;
  let saveInFlight = false;
  let saveWarned = false;
  let toastTimer = null;
  let activityTimer = null;
  let currentLessonId = null;
  let currentLesson = null;
  let currentSpeed = 1;
  let courseTitleText = "Course";
  let lessonLoadSequence = 0;
  let courseModules = [];
  let flatLessons = [];
  const lessonElements = new Map();
  const progressByLesson = new Map();

  /* ============================================================
     Helper functions
     ============================================================ */

  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) return "0:00";
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) {
      return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
    }
    return m + ":" + String(s).padStart(2, "0");
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function readPref(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  function savePref(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (_) { /* ignore */ }
  }

  function hasMedia() {
    return Boolean(currentLesson && (currentLesson.has_media || currentLesson.file_path));
  }

  function handleAuthenticationFailure(response) {
    if (response.status !== 401) return false;
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    window.location.replace("login.html");
    return true;
  }

  function authHeaders() {
    return { Authorization: "Bearer " + AUTH_TOKEN };
  }

  async function getJson(url, options) {
    options = options || {};
    const headers = new Headers(options.headers || {});
    if (AUTH_TOKEN) headers.set("Authorization", "Bearer " + AUTH_TOKEN);
    let response;
    try {
      response = await fetch(url, { ...options, headers });
    } catch (_) {
      throw new Error("Cannot reach the server. Check your connection and try again.");
    }
    const data = await response.json().catch(function () { return {}; });
    if (handleAuthenticationFailure(response)) {
      throw new Error("Your session has expired. Please log in again.");
    }
    if (!response.ok) {
      throw new Error(data.message || "Request failed (" + response.status + ")");
    }
    return data;
  }

  /* ============================================================
     Toast (uses the existing completed-toast element)
     ============================================================ */

  // Wrap the toast's text in a span so it can be updated safely.
  const toastLabel = (function () {
    const svg = completedToast.querySelector("svg");
    const node = svg ? svg.nextSibling : null;
    const text = node && node.nodeType === 3 ? node.textContent.trim() : "Lesson completed";
    if (node && node.nodeType === 3) node.remove();
    const span = document.createElement("span");
    span.textContent = text;
    completedToast.appendChild(span);
    return span;
  })();

  function showToast(message, tone, duration) {
    toastLabel.textContent = message;
    if (tone === "warn") {
      completedToast.style.borderColor = "rgba(251, 146, 60, 0.55)";
      completedToast.style.color = "#fed7aa";
    } else {
      completedToast.style.borderColor = "";
      completedToast.style.color = "";
    }
    completedToast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      completedToast.classList.remove("show");
    }, duration || 4200);
  }

  /* ============================================================
     Course curriculum
     ============================================================ */

  async function loadCourseCurriculum() {
    curriculumStatusEl.hidden = false;
    curriculumStatusEl.classList.add("is-loading");
    curriculumStatusEl.textContent = "Loading course content…";

    // Reset state so "Try again" starts clean.
    courseModules = [];
    flatLessons = [];
    progressByLesson.clear();
    lessonElements.clear();

    try {
      if (!Number.isSafeInteger(courseId) || courseId <= 0) {
        throw new Error("The course URL must contain a valid course ID.");
      }
      const courses = await getJson("/api/courses");
      const course = courses.find(function (entry) {
        return Number(entry.id) === courseId;
      });
      if (!course) throw new Error("Course " + courseId + " was not found.");
      courseTitleText = course.title || "Course";
      courseTitleEl.textContent = courseTitleText;
      document.title = courseTitleText + " — NYC LMS";

      // The student must be logged in and enrolled before content loads.
      await ensureEnrolled(course);

      const modules = await getJson("/api/modules/course/" + courseId);
      courseModules = modules.slice().sort(function (a, b) {
        return Number(a.module_order) - Number(b.module_order);
      });
      if (!courseModules.length) {
        curriculumStatusEl.classList.remove("is-loading");
        curriculumStatusEl.textContent = "This course has no modules yet.";
        courseCountsEl.textContent = "0 Modules • 0 Lessons";
        setCourseProgress(0);
        return;
      }

      const moduleResults = await Promise.all(courseModules.map(async function (module) {
        try {
          const lessons = await getJson("/api/lessons/module/" + module.id);
          lessons.sort(function (a, b) {
            return Number(a.lesson_order) - Number(b.lesson_order);
          });
          return { module: module, lessons: lessons, error: null };
        } catch (error) {
          return { module: module, lessons: [], error: error };
        }
      }));

      courseModules = moduleResults;
      flatLessons = moduleResults.flatMap(function (result) {
        return result.lessons.map(function (lesson) {
          return Object.assign({ module: result.module }, lesson);
        });
      });
      renderCurriculum();
      courseCountsEl.textContent =
        moduleResults.length + (moduleResults.length === 1 ? " Module" : " Modules") +
        " • " + flatLessons.length + (flatLessons.length === 1 ? " Lesson" : " Lessons");

      if (!flatLessons.length) {
        curriculumStatusEl.classList.remove("is-loading");
        curriculumStatusEl.hidden = false;
        curriculumStatusEl.textContent = "No lessons are available in this course.";
        setCourseProgress(0);
        return;
      }

      curriculumStatusEl.hidden = true;
      curriculumStatusEl.classList.remove("is-loading");
      await loadCourseProgress();
      await loadLesson(pickResumeLesson());
    } catch (error) {
      curriculumStatusEl.classList.remove("is-loading");
      curriculumStatusEl.hidden = false;
      curriculumStatusEl.textContent = "Unable to load course content: " + error.message + " ";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "retry-btn";
      retry.textContent = "Try again";
      retry.addEventListener("click", loadCourseCurriculum);
      curriculumStatusEl.appendChild(retry);
      courseCountsEl.textContent = "";
      console.error("Course curriculum load failed:", error);
    }
  }

  function renderCurriculum() {
    curriculumEl.textContent = "";
    curriculumEl.appendChild(curriculumStatusEl);
    lessonElements.clear();

    courseModules.forEach(function (result) {
      const section = document.createElement("div");
      section.className = "module";
      section.dataset.moduleId = result.module.id;

      const header = document.createElement("div");
      header.className = "module-header";
      const label = document.createElement("div");
      label.className = "module-label";
      label.textContent = "Module " + result.module.module_order;
      const title = document.createElement("div");
      title.className = "module-title";
      title.textContent = result.module.title;
      header.append(label, title);
      section.appendChild(header);

      if (result.error) {
        const error = document.createElement("p");
        error.className = "curriculum-status";
        error.textContent = "Unable to load lessons: " + result.error.message;
        section.appendChild(error);
      }

      result.lessons.forEach(function (lesson) {
        const lessonWithModule = Object.assign({ module: result.module }, lesson);
        const item = document.createElement("button");
        item.type = "button";
        item.className = "lesson-item";
        item.dataset.lessonId = lesson.id;
        const withMedia = Boolean(lesson.has_media || lesson.file_path);
        if (!withMedia) {
          item.classList.add("unavailable");
          item.setAttribute("aria-disabled", "true");
        }

        const icon = document.createElement("span");
        icon.className = "lesson-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>';
        const info = document.createElement("span");
        info.className = "lesson-info";
        const name = document.createElement("span");
        name.className = "lesson-item-name";
        name.textContent = "Lesson " + lesson.lesson_order + " — " + lesson.title;
        name.title = name.textContent;
        const duration = document.createElement("span");
        duration.className = "lesson-item-duration";
        const seconds = Number(lesson.duration);
        duration.textContent = withMedia && lesson.duration !== null && lesson.duration !== undefined && seconds > 0
          ? "Duration: " + formatTime(seconds)
          : "Duration: —";
        info.append(name, duration);
        item.append(icon, info);
        if (!withMedia) {
          const unavailable = document.createElement("span");
          unavailable.className = "lesson-item-duration";
          unavailable.textContent = "Media not available";
          info.appendChild(unavailable);
        }
        item.addEventListener("click", function () { loadLesson(lessonWithModule); });
        section.appendChild(item);
        lessonElements.set(String(lesson.id), item);
      });
      curriculumEl.appendChild(section);
    });
  }

  // Keep the current lesson visible inside the sidebar list only
  // (never scrolls the whole page).
  function revealLessonInList(item) {
    if (!item) return;
    const box = curriculumEl.getBoundingClientRect();
    const row = item.getBoundingClientRect();
    if (row.top < box.top || row.bottom > box.bottom) {
      curriculumEl.scrollTop += (row.top - box.top) - (box.height / 2 - row.height / 2);
    }
  }

  /* ============================================================
     Enrollment check
     ============================================================ */

  // Enrolls automatically for published courses so that opening
  // a course link always leaves an enrollment record behind.
  async function ensureEnrolled(course) {
    if (IS_ADMIN) return;
    const status = await getJson("/api/enrollments/course/" + course.id, {
      headers: authHeaders()
    });

    if (status.enrolled) return;

    const isPublished = course.published === true || course.published === "t";
    if (!isPublished) {
      throw new Error("This course is not available.");
    }

    await getJson("/api/enrollments", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
      body: JSON.stringify({ course_id: course.id })
    });
  }

  /* ============================================================
     Continue Learning — pick the lesson to open on load
     ============================================================ */

  function isLessonCompleted(lesson) {
    const progress = progressByLesson.get(String(lesson.id));
    return Boolean(progress && progress.completed);
  }

  // Resume the stored lesson while it is unfinished,
  // otherwise open the first lesson that is not completed yet.
  function pickResumeLesson() {
    const storedId = localStorage.getItem(CURRENT_LESSON_KEY);
    const stored = flatLessons.find(function (lesson) {
      return String(lesson.id) === String(storedId);
    });

    if (stored && !isLessonCompleted(stored)) return stored;

    const incomplete = flatLessons.filter(function (lesson) {
      return !isLessonCompleted(lesson);
    });
    const playable = incomplete.find(function (lesson) {
      return Boolean(lesson.has_media || lesson.file_path);
    });

    return playable || incomplete[0] || stored || flatLessons[0];
  }

  async function loadCourseProgress() {
    if (!AUTH_TOKEN || IS_ADMIN || !flatLessons.length) return;
    await Promise.all(flatLessons.map(async function (lesson) {
      try {
        const progress = await getJson("/api/progress/" + lesson.id, {
          headers: authHeaders()
        });
        progressByLesson.set(String(lesson.id), progress);
        updateLessonCompletionUI(lesson.id, Boolean(progress.completed));
      } catch (error) {
        console.error("Unable to load progress for lesson " + lesson.id + ":", error);
      }
    }));
    updateCourseProgress();
  }

  function updateLessonCompletionUI(lessonId, completed) {
    const item = lessonElements.get(String(lessonId));
    if (!item) return;
    item.classList.toggle("completed", completed);
    const icon = item.querySelector(".lesson-icon");
    if (!icon) return;
    icon.innerHTML = completed
      ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>'
      : '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>';
  }

  function updateCourseProgress() {
    const completed = flatLessons.reduce(function (count, lesson) {
      const progress = progressByLesson.get(String(lesson.id));
      return count + (progress && progress.completed ? 1 : 0);
    }, 0);
    const percent = flatLessons.length
      ? Math.floor((completed / flatLessons.length) * 100)
      : 0;
    setCourseProgress(percent, flatLessons.length > 0 && completed === flatLessons.length);
  }

  function updateLessonNavigation() {
    const index = flatLessons.findIndex(function (lesson) {
      return String(lesson.id) === String(currentLessonId);
    });
    const previous = index > 0 ? flatLessons[index - 1] : null;
    const next = index >= 0 && index < flatLessons.length - 1
      ? flatLessons[index + 1]
      : null;
    prevBtn.disabled = !previous;
    nextBtn.disabled = !next;
    prevLessonName.textContent = previous ? previous.title : "This is the first lesson";
    nextLessonName.textContent = next ? next.title : "This is the last lesson";
    const current = currentLessonId ? progressByLesson.get(String(currentLessonId)) : null;
    nextBtn.classList.toggle("ready", Boolean(current && current.completed));
  }

  function setMediaControlsEnabled(enabled) {
    playBtn.disabled = !enabled;
    bigPlay.disabled = !enabled;
    progressArea.setAttribute("aria-disabled", String(!enabled));
    progressArea.tabIndex = enabled ? 0 : -1;
    progressArea.style.pointerEvents = enabled ? "" : "none";
    player.classList.toggle("media-unavailable", !enabled);
  }

  async function loadLesson(lesson) {
    if (!lesson) return;
    const loadSequence = ++lessonLoadSequence;
    if (currentLessonId && progressLoaded && video.duration) {
      await saveDatabaseProgress(false, currentLessonId);
    }
    if (loadSequence !== lessonLoadSequence) return;

    progressLoaded = false;
    video.pause();
    currentLesson = lesson;
    currentLessonId = lesson.id;
    localStorage.setItem(CURRENT_LESSON_KEY, String(lesson.id));
    lessonCompleted = false;

    lessonElements.forEach(function (item, id) {
      const isCurrent = id === String(lesson.id);
      item.classList.toggle("current", isCurrent);
      if (isCurrent) item.setAttribute("aria-current", "true");
      else item.removeAttribute("aria-current");
    });
    revealLessonInList(lessonElements.get(String(lesson.id)));

    lessonMetaEl.textContent = "Module " + lesson.module.module_order + " • Lesson " + lesson.lesson_order;
    lessonTitleEl.textContent = lesson.title;
    lessonOverviewEl.textContent =
      lesson.description || lesson.overview || "Lesson overview is not available.";
    document.title = lesson.title + " — " + courseTitleText;
    resumePill.classList.remove("visible");
    resumePillText.textContent = "Resume from 0:00";
    currentTimeEl.textContent = "0:00";
    totalDurationEl.textContent = "0:00";
    progressFilled.style.width = "0%";
    progressBuffered.style.width = "0%";
    progressThumb.style.left = "0%";
    progressArea.removeAttribute("aria-valuenow");
    progressArea.removeAttribute("aria-valuetext");
    player.classList.remove("buffering");
    video.removeAttribute("src");
    video.load();

    const available = Boolean(lesson.has_media || lesson.file_path);
    setMediaControlsEnabled(available);
    if (!available) {
      lessonStatusEl.textContent = "Media not available";
      const existing = progressByLesson.get(String(lesson.id));
      lessonCompleted = Boolean(existing && existing.completed);
      progressLoaded = true;
      updateLessonNavigation();
      return;
    }

    lessonStatusEl.textContent = "";
    try {
      const stream = await getJson("/api/stream/token/" + encodeURIComponent(lesson.id));
      if (String(currentLessonId) !== String(lesson.id)) return;
      video.src = stream.url;
    } catch (error) {
      lessonStatusEl.textContent = error.message || "Unable to authorize media playback.";
      setMediaControlsEnabled(false);
      return;
    }
    video.load();
    // load() resets the playback rate in browsers, so re-apply the chosen speed.
    video.defaultPlaybackRate = currentSpeed;
    video.playbackRate = currentSpeed;
    updateLessonNavigation();
    await loadDatabaseProgress(lesson.id);
  }

  async function loadDatabaseProgress(lessonId) {
    if (!AUTH_TOKEN || IS_ADMIN || !lessonId) return;
    try {
      const data = await getJson("/api/progress/" + encodeURIComponent(lessonId), {
        headers: authHeaders()
      });
      if (String(currentLessonId) !== String(lessonId)) return;
      progressByLesson.set(String(lessonId), data);
      lessonCompleted = Boolean(data.completed);
      progressLoaded = true;
      updateLessonCompletionUI(lessonId, lessonCompleted);
      updateCourseProgress();
      updateLessonNavigation();

      const savedTime = Number(data.watched_seconds || 0);
      if (data.completed || savedTime <= 0) return;
      resumePillText.textContent = "Resume from " + formatTime(savedTime);
      resumePill.classList.add("visible");
      const restorePosition = function () {
        if (String(currentLessonId) !== String(lessonId)) return;
        if (Number.isFinite(video.duration) && video.duration > 0 && savedTime < video.duration - 1) {
          video.currentTime = savedTime;
          updateProgress();
        }
      };
      if (video.readyState >= 1) restorePosition();
      else video.addEventListener("loadedmetadata", restorePosition, { once: true });
    } catch (error) {
      if (String(currentLessonId) === String(lessonId)) progressLoaded = true;
      console.error("Could not load PostgreSQL progress:", error);
    }
  }

  function syncPlayUI() {
    const isPaused = video.paused;
    iconPlay.style.display = isPaused ? "" : "none";
    iconPause.style.display = isPaused ? "none" : "";
    player.classList.toggle("paused", isPaused);
  }

  /* ============================================================
     Playback speed (remembered between lessons and visits)
     ============================================================ */

  function setSpeed(rate, persist) {
    currentSpeed = rate;
    video.defaultPlaybackRate = rate;
    video.playbackRate = rate;
    speedBtn.textContent = rate + "x";
    speedMenu.querySelectorAll(".speed-option").forEach(function (option) {
      const active = Number(option.dataset.rate) === rate;
      option.classList.toggle("active", active);
      option.setAttribute("aria-checked", String(active));
    });
    if (persist) savePref(PREF.speed, rate);
  }

  function closeSpeedMenu() {
    speedMenu.classList.remove("open");
    speedBtn.setAttribute("aria-expanded", "false");
  }

  function buildSpeedMenu() {
    SPEEDS.forEach(function (rate) {
      const opt = document.createElement("button");
      opt.type = "button";
      opt.className = "speed-option";
      opt.dataset.rate = String(rate);
      opt.textContent = rate + "x";
      opt.setAttribute("role", "menuitemradio");
      opt.addEventListener("click", function () {
        setSpeed(rate, true);
        closeSpeedMenu();
        speedBtn.focus();
      });
      speedMenu.appendChild(opt);
    });
    speedBtn.setAttribute("aria-haspopup", "menu");
    speedBtn.setAttribute("aria-expanded", "false");
  }

  speedBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    const open = speedMenu.classList.toggle("open");
    speedBtn.setAttribute("aria-expanded", String(open));
  });

  document.addEventListener("click", function (e) {
    if (!speedMenu.contains(e.target) && e.target !== speedBtn) closeSpeedMenu();
  });

  /* ============================================================
     Play / Pause
     ============================================================ */

  function togglePlay() {
    if (!hasMedia()) return;
    if (video.paused) {
      video.play().catch(function () {
        // Browser may block autoplay.
      });
    } else {
      video.pause();
    }
  }

  playBtn.addEventListener("click", togglePlay);
  bigPlay.addEventListener("click", togglePlay);
  video.addEventListener("click", togglePlay);
  video.addEventListener("play", syncPlayUI);
  video.addEventListener("pause", syncPlayUI);

  /* ============================================================
     Buffering and error states
     ============================================================ */

  video.addEventListener("waiting", function () {
    if (hasMedia()) player.classList.add("buffering");
  });

  ["playing", "canplay", "pause", "emptied"].forEach(function (name) {
    video.addEventListener(name, function () { player.classList.remove("buffering"); });
  });

  video.addEventListener("error", function () {
    player.classList.remove("buffering");
    if (!video.getAttribute("src")) return; // we cleared the source on purpose
    const code = video.error && video.error.code;
    lessonStatusEl.textContent = code === 4
      ? "This media format is not supported by your browser."
      : "This lesson could not be played. Check your connection and try again.";
  });

  /* ============================================================
     Progress bar
     ============================================================ */

  const seekTooltip = document.createElement("div");
  seekTooltip.className = "seek-tooltip";
  seekTooltip.setAttribute("aria-hidden", "true");
  seekTooltip.textContent = "0:00";
  progressTrack.appendChild(seekTooltip);

  function updateProgress() {
    if (!video.duration) return;

    const pct = (video.currentTime / video.duration) * 100;
    progressFilled.style.width = pct + "%";
    progressThumb.style.left = pct + "%";
    currentTimeEl.textContent = formatTime(video.currentTime);

    progressArea.setAttribute("aria-valuemin", "0");
    progressArea.setAttribute("aria-valuemax", String(Math.floor(video.duration)));
    progressArea.setAttribute("aria-valuenow", String(Math.floor(video.currentTime)));
    progressArea.setAttribute(
      "aria-valuetext",
      formatTime(video.currentTime) + " of " + formatTime(video.duration)
    );
  }

  function updateBuffered() {
    if (!video.duration || !video.buffered.length) return;
    const end = video.buffered.end(video.buffered.length - 1);
    progressBuffered.style.width = (end / video.duration) * 100 + "%";
  }

  video.addEventListener("timeupdate", updateProgress);
  video.addEventListener("progress", updateBuffered);

  video.addEventListener("loadedmetadata", function () {
    totalDurationEl.textContent = formatTime(video.duration);
    if (hasMedia() && lessonStatusEl.textContent) lessonStatusEl.textContent = "";
  });

  /* ============================================================
     Seeking
     ============================================================ */

  function seekFromEvent(e) {
    const rect = progressArea.getBoundingClientRect();
    const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    if (video.duration) {
      video.currentTime = ratio * video.duration;
      updateProgress();
    }
  }

  function updateSeekTooltip(e) {
    if (!video.duration) return;
    const rect = progressTrack.getBoundingClientRect();
    const tooltipWidth = seekTooltip.offsetWidth || 42;
    const edge = Math.min(tooltipWidth / 2, rect.width / 2);
    const x = clamp(e.clientX - rect.left, edge, rect.width - edge);
    seekTooltip.style.left = x + "px";
    seekTooltip.textContent = formatTime((x / rect.width) * video.duration);
  }

  function seekBy(seconds) {
    if (!hasMedia() || !video.duration) return;
    video.currentTime = clamp(video.currentTime + seconds, 0, video.duration);
    updateProgress();
  }

  progressArea.addEventListener("pointerdown", function (e) {
    wasDragging = true;
    progressArea.setPointerCapture(e.pointerId);
    seekFromEvent(e);
  });

  progressArea.addEventListener("pointermove", function (e) {
    updateSeekTooltip(e);
    if (wasDragging) seekFromEvent(e);
  });

  function endDrag() { wasDragging = false; }
  progressArea.addEventListener("pointerup", endDrag);
  progressArea.addEventListener("pointercancel", endDrag);
  progressArea.addEventListener("lostpointercapture", endDrag);

  /* ============================================================
     Volume (remembered between visits)
     ============================================================ */

  function syncVolumeUI() {
    const muted = video.muted || video.volume === 0;
    iconVolOn.style.display = muted ? "none" : "";
    iconVolOff.style.display = muted ? "" : "none";
    volumeSlider.value = muted ? 0 : video.volume;
  }

  volumeSlider.addEventListener("input", function () {
    video.volume = parseFloat(volumeSlider.value);
    video.muted = video.volume === 0;
    if (video.volume > 0) savePref(PREF.volume, video.volume);
    savePref(PREF.muted, video.muted);
    syncVolumeUI();
  });

  function toggleMute() {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = 0.8;
    savePref(PREF.muted, video.muted);
    syncVolumeUI();
  }

  muteBtn.addEventListener("click", toggleMute);
  video.addEventListener("volumechange", syncVolumeUI);

  /* ============================================================
     Picture in Picture
     ============================================================ */

  if (!document.pictureInPictureEnabled) {
    pipBtn.style.display = "none";
  } else {
    pipBtn.addEventListener("click", async function () {
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else {
          await video.requestPictureInPicture();
        }
      } catch (err) {
        // Ignore PiP errors.
      }
    });
  }

  /* ============================================================
     Fullscreen
     ============================================================ */

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (player.requestFullscreen) {
        await player.requestFullscreen();
      }
    } catch (err) {
      // Ignore fullscreen errors.
    }
  }

  fsBtn.addEventListener("click", toggleFullscreen);

  document.addEventListener("fullscreenchange", function () {
    const isFs = !!document.fullscreenElement;
    iconFsEnter.style.display = isFs ? "none" : "";
    iconFsExit.style.display = isFs ? "" : "none";
  });

  /* ============================================================
     Controls visibility (touch screens and keyboard users)
     ============================================================ */

  function pinControls() {
    player.classList.add("controls-pinned");
    clearTimeout(activityTimer);
    activityTimer = setTimeout(function () {
      if (!video.paused && !speedMenu.classList.contains("open")) {
        player.classList.remove("controls-pinned");
      }
    }, CONTROLS_IDLE_MS);
  }

  ["pointerdown", "pointermove", "touchstart"].forEach(function (name) {
    player.addEventListener(name, pinControls, { passive: true });
  });
  player.addEventListener("focusin", pinControls);

  /* ============================================================
     Course progress UI
     ============================================================ */

  function setCourseProgress(percent, isComplete) {
    const pct = clamp(percent, 0, 100);
    const complete = Boolean(isComplete) && pct >= 100;
    courseProgressPct.textContent = pct + "%";
    courseProgressFill.style.width = pct + "%";
    courseProgressFill.classList.toggle("complete", complete);
    if (courseCompleteNote) courseCompleteNote.hidden = !complete;
  }

  /* ============================================================
     Mark lesson completed
     ============================================================ */

  function markLessonCompleted(announce, lessonId) {
    if (announce === undefined) announce = true;
    if (lessonId === undefined) lessonId = currentLessonId;
    if (!lessonId) return;
    if (String(lessonId) === String(currentLessonId)) lessonCompleted = true;
    const id = String(lessonId);
    const progress = progressByLesson.get(id) || {};
    progress.completed = true;
    progressByLesson.set(id, progress);
    updateLessonCompletionUI(lessonId, true);
    updateCourseProgress();
    updateLessonNavigation();

    if (announce) {
      const allCompleted = flatLessons.length > 0 && flatLessons.every(isLessonCompleted);
      showToast(allCompleted ? "Course completed!" : "Lesson completed");
    }
  }

  /* ============================================================
     Save progress to PostgreSQL
     ============================================================ */

  async function saveDatabaseProgress(completed, lessonId) {
    if (completed === undefined) completed = false;
    if (lessonId === undefined) lessonId = currentLessonId;

    if (saveInFlight && completed) {
      await new Promise(function (resolve) { setTimeout(resolve, 50); });
      return saveDatabaseProgress(completed, lessonId);
    }
    if (!AUTH_TOKEN || IS_ADMIN || !lessonId || !progressLoaded || !video.duration || saveInFlight) {
      return false;
    }

    const savedLessonId = lessonId;
    const watchedSeconds = Math.floor(completed ? video.duration : video.currentTime);

    saveInFlight = true;

    try {
      const response = await fetch("/api/progress", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + AUTH_TOKEN
        },
        body: JSON.stringify({
          lesson_id: savedLessonId,
          watched_seconds: watchedSeconds,
          completed: completed
        })
      });

      if (handleAuthenticationFailure(response)) return false;
      if (!response.ok) throw new Error("HTTP " + response.status);

      saveWarned = false;
      const previous = progressByLesson.get(String(savedLessonId)) || {};
      progressByLesson.set(String(savedLessonId), Object.assign({}, previous, {
        watched_seconds: watchedSeconds,
        completed: completed || Boolean(previous.completed)
      }));
      updateCourseProgress();
      return true;
    } catch (error) {
      console.error("Progress save error:", error);
      // Tell the student once per failure streak, not every 5 seconds.
      if (!saveWarned) {
        saveWarned = true;
        showToast("Progress could not be saved. Check your connection.", "warn", 4500);
      }
      return false;
    } finally {
      saveInFlight = false;
    }
  }

  /* ============================================================
     Automatic progress saving
     ============================================================ */

  setInterval(function () {
    if (progressLoaded && !video.paused && !video.ended) {
      saveDatabaseProgress(false);
    }
  }, SAVE_INTERVAL);

  video.addEventListener("pause", function () {
    if (!video.ended) saveDatabaseProgress(false);
  });

  video.addEventListener("ended", async function () {
    const endedLessonId = currentLessonId;
    const saved = await saveDatabaseProgress(true, endedLessonId);
    if (saved) markLessonCompleted(true, endedLessonId);
  });

  // Last-chance save when the page is closed or hidden (keepalive lets the
  // request finish after the page is gone).
  function flushProgress() {
    if (!AUTH_TOKEN || IS_ADMIN || !currentLessonId || !progressLoaded || !video.duration) return;
    fetch("/api/progress", {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + AUTH_TOKEN
      },
      body: JSON.stringify({
        lesson_id: currentLessonId,
        watched_seconds: Math.floor(video.ended ? video.duration : video.currentTime),
        completed: video.ended || lessonCompleted
      })
    }).catch(function (error) {
      console.error("Progress save during page exit failed:", error);
    });
  }

  window.addEventListener("pagehide", flushProgress);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flushProgress();
  });

  /* Hide resume message when playback starts */
  video.addEventListener("play", function () {
    resumePill.classList.remove("visible");
  });

  /* ============================================================
     Keyboard shortcuts
       Space / K  play or pause      F  fullscreen
       ← / →      seek 5 seconds     M  mute
       J / L      seek 10 seconds    0–9  jump to 0%–90%
       Esc        close speed menu
     ============================================================ */

  document.addEventListener("keydown", function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === "Escape") {
      closeSpeedMenu();
      return;
    }

    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable) {
      return;
    }
    // Let Space/Enter activate a focused button or link instead of also toggling play.
    if ((tag === "button" || tag === "a") && (e.key === " " || e.key === "Enter")) {
      return;
    }

    switch (e.key) {
      case " ":
      case "k":
      case "K":
        e.preventDefault();
        togglePlay();
        pinControls();
        break;

      case "ArrowLeft":
        e.preventDefault();
        seekBy(-SEEK_STEP);
        pinControls();
        break;

      case "ArrowRight":
        e.preventDefault();
        seekBy(SEEK_STEP);
        pinControls();
        break;

      case "j":
      case "J":
        seekBy(-SEEK_STEP_LONG);
        pinControls();
        break;

      case "l":
      case "L":
        seekBy(SEEK_STEP_LONG);
        pinControls();
        break;

      case "f":
      case "F":
        toggleFullscreen();
        break;

      case "m":
      case "M":
        toggleMute();
        break;

      default:
        if (/^[0-9]$/.test(e.key) && hasMedia() && video.duration) {
          video.currentTime = (Number(e.key) / 10) * video.duration;
          updateProgress();
          pinControls();
        }
    }
  });

  /* ============================================================
     Tabs
     ============================================================ */

  document.querySelectorAll(".tab-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".tab-btn").forEach(function (b) {
        const active = b === btn;
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", String(active));
      });
      document.querySelectorAll(".tab-panel").forEach(function (p) {
        p.classList.toggle("active", p.id === "panel-" + btn.dataset.tab);
      });
    });
  });

  /* ============================================================
     Previous / Next lesson
     ============================================================ */

  function currentLessonIndex() {
    return flatLessons.findIndex(function (lesson) {
      return String(lesson.id) === String(currentLessonId);
    });
  }

  nextBtn.addEventListener("click", function () {
    const index = currentLessonIndex();
    if (index >= 0 && index < flatLessons.length - 1) loadLesson(flatLessons[index + 1]);
  });

  prevBtn.addEventListener("click", function () {
    const index = currentLessonIndex();
    if (index > 0) loadLesson(flatLessons[index - 1]);
  });

  /* ============================================================
     Initialize player
     ============================================================ */

  buildSpeedMenu();

  // Restore the viewer's saved speed and volume.
  const storedSpeed = Number(readPref(PREF.speed));
  setSpeed(SPEEDS.indexOf(storedSpeed) !== -1 ? storedSpeed : 1, false);

  const storedVolume = parseFloat(readPref(PREF.volume));
  if (isFinite(storedVolume) && storedVolume > 0 && storedVolume <= 1) {
    video.volume = storedVolume;
  }
  video.muted = readPref(PREF.muted) === "true";

  progressArea.tabIndex = 0;
  setMediaControlsEnabled(false);
  syncPlayUI();
  syncVolumeUI();

  if (!AUTH_TOKEN) {
    window.location.replace("login.html");
  } else {
    try {
      studentNameEl.textContent = SESSION_USER.name || (IS_ADMIN ? "Admin preview" : "Student");
    } catch (_) {
      studentNameEl.textContent = "Student";
    }
    loadCourseCurriculum();
  }

})();
