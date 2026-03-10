/* public/js/common.js - shared utilities */
'use strict';

// ─── Toast notifications ──────────────────────────────────────────────────
const toastContainer = (() => {
  let el = document.getElementById('toast-container');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast-container';
    el.className = 'toast-container';
    document.body.appendChild(el);
  }
  return el;
})();

function showToast(message, type = 'info', duration = 3500) {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = message;
  toastContainer.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.4s'; }, duration);
  setTimeout(() => t.remove(), duration + 500);
}

// ─── CSRF token ───────────────────────────────────────────────────────────
let _csrfToken = null;

async function getCsrfToken() {
  if (_csrfToken) return _csrfToken;
  try {
    const res = await fetch('/api/csrf-token', { credentials: 'include' });
    const data = await res.json();
    _csrfToken = data.csrfToken;
    return _csrfToken;
  } catch {
    return null;
  }
}

/** Return the cached CSRF token synchronously (for use in beforeunload). */
function getCachedCsrfToken() { return _csrfToken; }

// ─── API helpers ──────────────────────────────────────────────────────────
async function apiFetch(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const needsCsrf = !['GET', 'HEAD', 'OPTIONS'].includes(method);

  const headers = { 'Content-Type': 'application/json', ...options.headers };

  if (needsCsrf) {
    const token = await getCsrfToken();
    if (token) headers['x-csrf-token'] = token;
  }

  const defaults = {
    credentials: 'include',
    headers,
  };
  const res = await fetch(url, { ...defaults, ...options, headers });
  const data = await res.json().catch(() => ({}));

  // If a CSRF-protected request returns 403 with "invalid csrf token", the
  // cached token is stale (e.g. session was regenerated after login).  Clear
  // the cache, fetch a fresh token, and retry the request once.
  if (res.status === 403 && needsCsrf && data.error === 'invalid csrf token') {
    _csrfToken = null;
    const freshToken = await getCsrfToken();
    if (freshToken) {
      headers['x-csrf-token'] = freshToken;
      const retry = await fetch(url, { ...defaults, ...options, headers });
      const retryData = await retry.json().catch(() => ({}));
      if (!retry.ok) throw new Error(retryData.error || `HTTP ${retry.status}`);
      return retryData;
    }
  }

  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ─── Auth helpers ─────────────────────────────────────────────────────────
let _currentUser = null;

async function getCurrentUser() {
  if (_currentUser) return _currentUser;
  try {
    _currentUser = await apiFetch('/auth/me');
    return _currentUser;
  } catch {
    return null;
  }
}

async function requireLogin() {
  const user = await getCurrentUser();
  if (!user) {
    window.location.href = '/';
    return null;
  }
  return user;
}

function logout() {
  // Clear cached auth/CSRF state so a fresh login can proceed
  _currentUser = null;
  _csrfToken = null;
  apiFetch('/auth/logout', { method: 'POST' })
    .catch(() => {})
    .finally(() => { window.location.href = '/'; });
  // Safety: navigate even if the request hangs
  setTimeout(() => { window.location.href = '/'; }, 2000);
}

// ─── Navbar rendering ─────────────────────────────────────────────────────
function renderNavbar(user) {
  const navEl = document.getElementById('navbar');
  if (!navEl) return;
  navEl.innerHTML = `
    <a href="/lobby" class="navbar-brand">🎮 Game Portal</a>
    <nav class="navbar-nav">
      <a href="/lobby" class="btn btn-ghost btn-sm">Lobbies</a>
      ${user?.isAdmin ? '<a href="/admin" class="btn btn-ghost btn-sm">Admin</a>' : ''}
      <div class="navbar-user">
        ${user?.avatarUrl ? `<img src="${user.avatarUrl}" class="navbar-avatar" alt="">` : ''}
        <span>${user?.displayName || 'Guest'}</span>
      </div>
      <button class="btn btn-ghost btn-sm" id="sign-out-btn">Sign Out</button>
    </nav>`;
  document.getElementById('sign-out-btn').addEventListener('click', logout);
}

// ─── Format helpers ───────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function timeAgo(date) {
  const secs = (Date.now() - new Date(date).getTime()) / 1000;
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}
