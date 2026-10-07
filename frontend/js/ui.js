/* Shared interface behavior that does not touch authentication rules.
   Logout still only removes the stored token and user, then opens login. */
(function () {
  'use strict';

  var pending = null;
  var lastFocus = null;

  function performLogout() {
    try {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
    } catch (_) { /* storage can be blocked */ }
    window.location.href = 'login.html';
  }

  function dialog() {
    return document.getElementById('logoutModal');
  }

  function closeLogout() {
    var root = dialog();
    if (!root || root.hidden) return;
    root.hidden = true;
    document.body.classList.remove('modal-open');
    pending = null;
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
    lastFocus = null;
  }

  function ensureModal() {
    var root = dialog();
    if (root) return root;
    root = document.createElement('div');
    root.id = 'logoutModal';
    root.className = 'logout-modal';
    root.hidden = true;
    root.innerHTML =
      '<div class="logout-modal__backdrop" data-logout-cancel></div>' +
      '<div class="logout-modal__dialog" role="dialog" aria-modal="true" aria-labelledby="logoutTitle" aria-describedby="logoutText" tabindex="-1">' +
        '<h2 id="logoutTitle">Log out?</h2>' +
        '<p id="logoutText">Are you sure you want to log out of your NYC LMS account?</p>' +
        '<div class="logout-modal__actions">' +
          '<button type="button" class="btn-3d btn-3d--secondary" data-logout-cancel>Cancel</button>' +
          '<button type="button" class="btn-3d btn-3d--danger" id="logoutConfirm" data-logout-confirm>Log out</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);
    root.addEventListener('click', function (event) {
      if (event.target.closest('[data-logout-cancel]')) closeLogout();
      if (event.target.closest('[data-logout-confirm]')) {
        var action = pending || performLogout;
        closeLogout();
        action();
      }
    });
    return root;
  }

  function confirmLogout(onConfirm) {
    pending = typeof onConfirm === 'function' ? onConfirm : performLogout;
    lastFocus = document.activeElement;
    var root = ensureModal();
    root.hidden = false;
    document.body.classList.add('modal-open');
    var panel = root.querySelector('.logout-modal__dialog');
    panel.focus();
  }

  document.addEventListener('keydown', function (event) {
    var root = dialog();
    if (!root || root.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeLogout();
      return;
    }
    if (event.key === 'Enter' && event.target && event.target.hasAttribute && !event.target.hasAttribute('data-logout-cancel')) {
      var confirm = document.getElementById('logoutConfirm');
      if (confirm && document.activeElement !== confirm) {
        event.preventDefault();
        confirm.click();
      }
    }
  });

  document.addEventListener('click', function (event) {
    var trigger = event.target.closest('[data-confirm-logout]');
    if (!trigger) return;
    event.preventDefault();
    confirmLogout(performLogout);
  });

  document.addEventListener('click', function (event) {
    var toggle = event.target.closest('[data-nav-toggle]');
    if (!toggle) return;
    var nav = document.getElementById(toggle.getAttribute('aria-controls'));
    if (!nav) return;
    var open = nav.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? 'Close' : 'Menu';
  });

  window.NYCUi = { confirmLogout: confirmLogout, performLogout: performLogout };
})();
