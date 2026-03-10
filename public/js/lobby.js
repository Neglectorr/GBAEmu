'use strict';
/**
 * Lobby browser – lobby.html
 * Handles listing, creating, and joining game lobbies.
 */

let socket = null;
let currentUser = null;
let romList = []; // cached ROM list with consoleType info

async function init() {
  currentUser = await requireLogin();
  if (!currentUser) return;
  renderNavbar(currentUser);

  // Connect to lobby socket namespace
  socket = io('/lobby', { withCredentials: true });

  socket.on('connect', () => {
    socket.emit('lobbies:list', {}, ({ lobbies }) => renderLobbies(lobbies || []));
  });

  socket.on('lobbies:updated', (lobbies) => renderLobbies(lobbies));

  socket.on('connect_error', (err) => {
    showToast(`Connection error: ${err.message}`, 'error');
  });

  // Load ROMs for create modal
  loadRoms();

  // ── Create lobby modal ──────────────────────────────────────────────────
  const createBtn = document.getElementById('create-lobby-btn');
  const modal     = document.getElementById('create-modal');
  const closeBtn  = document.getElementById('close-modal');
  const cancelBtn = document.getElementById('cancel-modal');
  const form      = document.getElementById('create-lobby-form');

  createBtn.addEventListener('click', () => {
    modal.classList.add('show');
    document.getElementById('lobby-name').focus();
  });
  closeBtn.addEventListener('click', () => modal.classList.remove('show'));
  cancelBtn.addEventListener('click', () => modal.classList.remove('show'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('show'); });

  // Update console type badge when ROM selection changes
  const romSelect = document.getElementById('rom-select');
  romSelect.addEventListener('change', () => {
    const rom = romList.find(r => r._id === romSelect.value);
    const display = document.getElementById('console-type-display');
    const badge = document.getElementById('console-type-badge');
    if (rom) {
      const ct = rom.consoleType || 'gba';
      display.style.display = 'block';
      badge.innerHTML = `<span class="console-badge ${ct}">${ct.toUpperCase()}</span>`;
    } else {
      display.style.display = 'none';
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name   = document.getElementById('lobby-name').value.trim();
    const romId  = document.getElementById('rom-select').value;
    if (!name || !romId) return showToast('Please fill all fields', 'error');

    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;

    // Determine console type for redirect
    const rom = romList.find(r => r._id === romId);
    const consoleType = rom?.consoleType || 'gba';
    const emulatorType = document.getElementById('emulator-type')?.value || 'auto';

    socket.emit('lobby:create', { name, romId, emulatorType }, (res) => {
      btn.disabled = false;
      if (res.error) return showToast(res.error, 'error');
      modal.classList.remove('show');
      showToast(`Lobby "${name}" created!`, 'success');
      // Redirect to the correct game page based on console type
      const gamePage = consoleType === 'nds' ? '/game-nds.html' : '/game.html';
      window.location.href = `${gamePage}?lobby=${res.lobby.id}`;
    });
  });
}

async function loadRoms() {
  const sel = document.getElementById('rom-select');
  try {
    const roms = await apiFetch('/api/roms');
    romList = roms;
    sel.innerHTML = roms.length
      ? roms.map(r => {
          const ct = r.consoleType || 'gba';
          return `<option value="${r._id}">[${ct.toUpperCase()}] ${r.displayName}</option>`;
        }).join('')
      : '<option value="">No ROMs available — ask admin to upload</option>';
    // Trigger change to show initial console type
    sel.dispatchEvent(new Event('change'));
  } catch (err) {
    sel.innerHTML = '<option value="">Failed to load ROMs</option>';
  }
}

function renderLobbies(lobbies) {
  const grid   = document.getElementById('lobby-grid');
  const empty  = document.getElementById('empty-state');

  if (!lobbies.length) {
    grid.innerHTML = '';
    grid.appendChild(empty);
    return;
  }

  grid.innerHTML = lobbies.map(lobby => {
    const ct = lobby.consoleType || 'gba';
    const gamePage = ct === 'nds' ? '/game-nds.html' : '/game.html';
    return `
    <a href="${gamePage}?lobby=${encodeURIComponent(lobby.id)}" class="card lobby-card" data-id="${lobby.id}">
      <div class="lobby-header">
        <span class="lobby-name">${escapeHtml(lobby.name)}</span>
        <div style="display:flex;gap:6px;align-items:center;">
          <span class="console-badge ${ct}">${ct.toUpperCase()}</span>
          <span class="lobby-status ${lobby.status}">${lobby.status}</span>
        </div>
      </div>
      <div class="lobby-rom">🎮 ${escapeHtml(lobby.romName)}</div>
      <div class="lobby-meta">
        <div class="lobby-players">
          👥 ${lobby.playerCount}/${lobby.maxPlayers} players
          ${lobby.spectatorCount > 0 ? `<span style="color:var(--text-muted)">· ${lobby.spectatorCount} watching</span>` : ''}
        </div>
        <span>Host: ${escapeHtml(lobby.hostName)}</span>
      </div>
    </a>
  `;
  }).join('');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

init();
