/* ============================================================
   NYC LMS — 3D Micro-Interaction Engine
   Particle canvas, specular spotlight, counter animations
   ============================================================ */

(function (win, doc) {
  'use strict';

  const prefersReducedMotion = win.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let reduceMotionPreference = prefersReducedMotion || win.localStorage.getItem('nyc-lms:reduce-motion') === 'true';
  let backgroundFrame = null;
  let backgroundCanvas = null;
  let backgroundResizeHandler = null;
  let spotlightObserver = null;
  let spotlightTrackHandler = null;
  doc.documentElement.classList.toggle('reduce-motion', reduceMotionPreference);

  /* ============================================================
     1. Animated Particle Mesh Background Canvas
     ============================================================ */
  function initBackgroundCanvas() {
    if (reduceMotionPreference || backgroundFrame !== null) return;

    let canvas = doc.getElementById('bgCanvas');
    if (!canvas) {
      canvas = doc.createElement('canvas');
      canvas.id = 'bgCanvas';
      doc.body.prepend(canvas);
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    backgroundCanvas = canvas;

    let width  = (canvas.width  = win.innerWidth);
    let height = (canvas.height = win.innerHeight);

    // Particles
    const PARTICLE_COUNT = 50;
    const particles = [];

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push({
        x:    Math.random() * width,
        y:    Math.random() * height,
        r:    Math.random() * 1.5 + 0.4,
        vx:   (Math.random() - 0.5) * 0.25,
        vy:   (Math.random() - 0.5) * 0.25,
        a:    Math.random() * 0.5 + 0.1,
      });
    }

    function drawFrame() {
      ctx.clearRect(0, 0, width, height);

      // Subtle grid
      ctx.strokeStyle = 'rgba(255,255,255,0.025)';
      ctx.lineWidth = 1;
      const gs = 72;
      for (let x = 0; x < width; x += gs) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
      }
      for (let y = 0; y < height; y += gs) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
      }

      // Particles
      particles.forEach(function (p) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0) p.x = width;
        if (p.x > width) p.x = 0;
        if (p.y < 0) p.y = height;
        if (p.y > height) p.y = 0;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 140, 70, ${p.a})`;
        ctx.fill();
      });

      // Particle connections
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 120) {
            ctx.strokeStyle = `rgba(255, 120, 60, ${0.06 * (1 - dist / 120)})`;
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.stroke();
          }
        }
      }
    }

    function loop() {
      if (reduceMotionPreference) { backgroundFrame = null; return; }
      drawFrame();
      backgroundFrame = requestAnimationFrame(loop);
    }
    loop();

    backgroundResizeHandler = function () {
      width  = canvas.width  = win.innerWidth;
      height = canvas.height = win.innerHeight;
      particles.forEach(function (p) {
        if (p.x > width) p.x = Math.random() * width;
        if (p.y > height) p.y = Math.random() * height;
      });
    };
    win.addEventListener('resize', backgroundResizeHandler, { passive: true });
  }

  /* ============================================================
     2. Specular Spotlight Hover Tracking
     ============================================================ */
  function initSpotlightTracking() {
    if (reduceMotionPreference) return;

    if (!spotlightTrackHandler) spotlightTrackHandler = function (e) {
      if (reduceMotionPreference) return;
      const el = e.currentTarget;
      const rect = el.getBoundingClientRect();
      el.style.setProperty('--mouse-x', (e.clientX - rect.left) + 'px');
      el.style.setProperty('--mouse-y', (e.clientY - rect.top)  + 'px');
    };

    function bindAll() {
      if (reduceMotionPreference) return;
      doc.querySelectorAll('.card-3d, .course-card, .stat-card, .panel, .auth-card').forEach(function (el) {
        if (el.dataset.spotBound) return;
        el.dataset.spotBound = '1';
        el.addEventListener('mousemove', spotlightTrackHandler, { passive: true });
      });
    }

    bindAll();
    if (!spotlightObserver) {
      spotlightObserver = new MutationObserver(bindAll);
      spotlightObserver.observe(doc.body, { childList: true, subtree: true });
    }
  }

  /* ============================================================
     3. Animated Number Counter
     ============================================================ */
  function animateCounters(root) {
    const scope = root || doc;
    scope.querySelectorAll('[data-counter]').forEach(function (el) {
      if (el.dataset.animated) return;
      const raw    = el.textContent.replace(/[^\d.]/g, '');
      const target = parseFloat(raw);
      if (isNaN(target)) return;

      el.dataset.animated = '1';
      const duration = 900;
      const start    = performance.now();

      function step(now) {
        const t  = Math.min((now - start) / duration, 1);
        const et = 1 - Math.pow(1 - t, 3); // easeOutCubic
        el.textContent = Math.floor(et * target);
        if (t < 1) requestAnimationFrame(step);
        else el.textContent = target;
      }
      requestAnimationFrame(step);
    });
  }

  /* ============================================================
     4. Password Toggle Helper
     ============================================================ */
  function initPasswordToggles() {
    doc.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-toggle-password], [data-password-toggle]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const id    = btn.dataset.togglePassword || btn.dataset.passwordToggle;
      const input = doc.getElementById(id);
      if (!input) return;
      const isText = input.type === 'text';
      input.type = isText ? 'password' : 'text';
      btn.textContent = isText ? 'Show' : 'Hide';
      btn.setAttribute('aria-pressed', String(!isText));
      btn.setAttribute('aria-label', isText ? 'Show password' : 'Hide password');
    });
  }

  /* ============================================================
     Init
     ============================================================ */
  function init() {
    initBackgroundCanvas();
    initSpotlightTracking();
    animateCounters();
    initPasswordToggles();
  }

  function setReducedMotion(enabled) {
    reduceMotionPreference = prefersReducedMotion || Boolean(enabled);
    doc.documentElement.classList.toggle('reduce-motion', reduceMotionPreference);
    if (reduceMotionPreference) {
      if (backgroundFrame !== null) win.cancelAnimationFrame(backgroundFrame);
      backgroundFrame = null;
      if (backgroundResizeHandler) win.removeEventListener('resize', backgroundResizeHandler);
      backgroundResizeHandler = null;
      if (backgroundCanvas) backgroundCanvas.remove();
      backgroundCanvas = null;
      if (spotlightObserver) spotlightObserver.disconnect();
      spotlightObserver = null;
      doc.querySelectorAll('[data-spot-bound="1"]').forEach(function (el) {
        el.removeEventListener('mousemove', spotlightTrackHandler);
        delete el.dataset.spotBound;
      });
    } else {
      initBackgroundCanvas();
      initSpotlightTracking();
    }
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  win.NYC3D = {
    initBackgroundCanvas,
    animateCounters,
    initSpotlightTracking,
    setReducedMotion,
    initCardTiltEngine: initSpotlightTracking, // compat alias
  };

})(window, document);
