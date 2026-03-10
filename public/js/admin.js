'use strict';
/**
 * Admin panel – admin.html
 */

let currentUser = null;
let selectedFile = null;

async function init() {
  currentUser = await requireLogin();
  if (!currentUser) return;
  if (!currentUser.isAdmin) {
    showToast('Admin access required', 'error');
    setTimeout(() => (window.location.href = '/lobby'), 1000);
    return;
  }
  renderNavbar(currentUser);
  await Promise.all([loadRoms(), loadUsers()]);
  setupUpload();
}

// ─── ROM Management ────────────────────────────────────────────────────────
async function loadRoms() {
  const list = document.getElementById('rom-list');
  try {
    const roms = await apiFetch('/api/roms');
    if (!roms.length) {
      list.innerHTML = `<div class="empty-state" style="padding:24px;"><span class="empty-state-icon" style="font-size:2rem">📀</span><p>No ROMs uploaded yet</p></div>`;
      return;
    }
    list.innerHTML = roms.map(r => {
      const ct = r.consoleType || 'gba';
      return `
      <div class="rom-item" id="rom-${r._id}">
        <span class="rom-icon">🎮</span>
        <div class="rom-info">
          <div class="rom-name">${escapeHtml(r.displayName)} <span class="console-badge ${ct}" style="margin-left:6px;">${ct.toUpperCase()}</span></div>
          <div class="rom-size">${r.filename} &middot; ${formatBytes(r.fileSize)}</div>
        </div>
        <div class="rom-actions">
          <button class="btn btn-danger btn-sm" onclick="deleteRom('${r._id}', '${escapeHtml(r.displayName)}')">🗑</button>
        </div>
      </div>
    `;
    }).join('');
  } catch (err) {
    list.innerHTML = `<p style="color:var(--neon-pink)">Failed to load ROMs: ${err.message}</p>`;
  }
}

async function deleteRom(romId, name) {
  if (!confirm(`Delete "${name}"?\n\nThis cannot be undone.`)) return;
  try {
    await apiFetch(`/api/admin/roms/${romId}`, { method: 'DELETE' });
    showToast(`"${name}" deleted`, 'success');
    document.getElementById(`rom-${romId}`)?.remove();
    await loadRoms();
  } catch (err) {
    showToast(`Delete failed: ${err.message}`, 'error');
  }
}

// ─── User Management ───────────────────────────────────────────────────────
async function loadUsers() {
  const list = document.getElementById('user-list');
  try {
    const users = await apiFetch('/api/admin/users');
    if (!users.length) {
      list.innerHTML = `<div class="empty-state" style="padding:24px;"><span style="font-size:2rem">👤</span><p>No users yet</p></div>`;
      return;
    }
    list.innerHTML = users.map(u => `
      <div class="user-item" id="user-${u._id}">
        ${u.avatarUrl ? `<img src="${u.avatarUrl}" class="player-avatar" alt="">` : '<span style="font-size:1.6rem">👤</span>'}
        <div class="user-info">
          <div class="user-name">
            ${escapeHtml(u.displayName)}
            ${u.isAdmin ? '<span class="badge badge-admin">Admin</span>' : ''}
          </div>
          <div class="user-email">${escapeHtml(u.email)}</div>
        </div>
        <div class="user-actions">
          ${u._id !== currentUser._id ? `
            <button class="btn btn-ghost btn-sm" onclick="toggleAdmin('${u._id}')">
              ${u.isAdmin ? '⬇ Remove Admin' : '⬆ Make Admin'}
            </button>
          ` : '<span style="color:var(--text-muted);font-size:.8rem">(you)</span>'}
        </div>
      </div>
    `).join('');
  } catch (err) {
    list.innerHTML = `<p style="color:var(--neon-pink)">Failed to load users: ${err.message}</p>`;
  }
}

async function toggleAdmin(userId) {
  try {
    const result = await apiFetch(`/api/admin/users/${userId}/admin`, { method: 'PATCH' });
    showToast(`Admin status updated`, 'success');
    await loadUsers();
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
}

// ─── File Upload ───────────────────────────────────────────────────────────
function setupUpload() {
  const area     = document.getElementById('upload-area');
  const input    = document.getElementById('rom-file-input');
  const form     = document.getElementById('upload-form');
  const nameInp  = document.getElementById('rom-display-name');
  const fileInp  = document.getElementById('rom-file-name');
  const confirmBtn = document.getElementById('upload-confirm-btn');
  const cancelBtn  = document.getElementById('upload-cancel-btn');
  const progressWrap = document.getElementById('upload-progress-wrap');
  const progressFill = document.getElementById('upload-progress');

  area.addEventListener('click', () => input.click());

  area.addEventListener('dragover', (e) => {
    e.preventDefault();
    area.classList.add('dragover');
  });
  area.addEventListener('dragleave', () => area.classList.remove('dragover'));
  area.addEventListener('drop', (e) => {
    e.preventDefault();
    area.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelected(file);
  });

  input.addEventListener('change', () => {
    if (input.files[0]) handleFileSelected(input.files[0]);
  });

  const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1 GB

  function handleFileSelected(file) {
    if (file.size > MAX_FILE_SIZE) {
      showToast(`File is too large (${formatBytes(file.size)}). Max 1 GB.`, 'error');
      return;
    }
    selectedFile = file;
    fileInp.value = file.name;
    nameInp.value = file.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ').trim();
    form.style.display = 'block';
  }

  cancelBtn.addEventListener('click', () => {
    form.style.display = 'none';
    selectedFile = null;
    input.value = '';
  });

  confirmBtn.addEventListener('click', async () => {
    if (!selectedFile) return;
    const displayName = nameInp.value.trim() || selectedFile.name;

    const fd = new FormData();
    fd.append('rom', selectedFile);
    fd.append('displayName', displayName);

    confirmBtn.disabled = true;
    progressWrap.style.display = 'block';
    progressFill.style.width = '0%';

    try {
      // Use XMLHttpRequest for upload progress
      await new Promise(async (resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/admin/upload');
        xhr.withCredentials = true;

        // Include CSRF token
        const csrfToken = await getCsrfToken();
        if (csrfToken) xhr.setRequestHeader('x-csrf-token', csrfToken);

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            progressFill.style.width = `${(e.loaded / e.total * 100).toFixed(0)}%`;
          }
        };

        xhr.onload = () => {
          try {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve(JSON.parse(xhr.responseText));
            } else {
              let msg = `HTTP ${xhr.status}`;
              try { msg = JSON.parse(xhr.responseText)?.error || msg; } catch {}
              reject(new Error(msg));
            }
          } catch (e) {
            reject(e);
          }
        };

        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send(fd);
      });

      showToast(`"${displayName}" uploaded successfully!`, 'success');
      form.style.display = 'none';
      selectedFile = null;
      input.value = '';
      await loadRoms();

    } catch (err) {
      showToast(`Upload failed: ${err.message}`, 'error');
    } finally {
      confirmBtn.disabled = false;
      progressWrap.style.display = 'none';
    }
  });

  document.getElementById('refresh-roms-btn').addEventListener('click', loadRoms);
  document.getElementById('refresh-users-btn').addEventListener('click', loadUsers);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

init();
