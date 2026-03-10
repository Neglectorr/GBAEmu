'use strict';
/**
 * NDS Game room – game-nds.html
 *
 * Responsibilities:
 * - Connect to lobby socket and maintain lobby state
 * - Initialise EmulatorJS (DeSmuME core) for NDS emulation
 * - Handle spectator frame display
 * - Bridge NDS wireless link data via the /ndslink socket namespace
 * - Persist save data to server
 *
 * Architecture mirrors game.js (GBA) for consistency.
 */

// ─── Constants ────────────────────────────────────────────────────────────
const FRAME_EMIT_INTERVAL = 50;    // ms between spectator frame broadcasts (~20 fps)
const SAVE_INTERVAL       = 30000; // ms between auto-saves (30s)

// ─── State ────────────────────────────────────────────────────────────────
let currentUser  = null;
let lobbyId      = null;
let lobbyState   = null;
let myRole       = null;  // 'player' | 'spectator'
let playerIndex  = -1;

let lobbySocket  = null;
let ndsSocket    = null;

let emulatorReady = false;
let romId        = null;

let frameTimer   = null;
let saveTimer    = null;

let ndsLinkEnabled = false;
let initDone     = false;
let loadingStarted = false;
let selectedPlayer = null;
let autoSaveTimer = null;
let saveInProgress = false;
let sidebarTab = 'chat';

// ─── Entry point ──────────────────────────────────────────────────────────
(async () => {
  const params = new URLSearchParams(window.location.search);
  lobbyId = params.get('lobby');
  if (!lobbyId) return (window.location.href = '/lobby');

  currentUser = await requireLogin();
  if (!currentUser) return;

  connectSockets();
})();

// ─── Socket setup ─────────────────────────────────────────────────────────
function connectSockets() {
  lobbySocket = io('/lobby', { withCredentials: true });
  ndsSocket   = io('/ndslink', { withCredentials: true });

  lobbySocket.on('connect', () => {
    lobbySocket.emit('lobby:join', { lobbyId }, (res) => {
      if (res.error) {
        showToast(res.error, 'error');
        return setTimeout(() => (window.location.href = '/lobby'), 1500);
      }
      handleLobbyState(res.lobby);
      if (!initDone) {
        initUIEvents();
        initDone = true;
      }
    });
  });

  lobbySocket.on('lobby:state', (lobby) => handleLobbyState(lobby));

  lobbySocket.on('game:start', ({ lobby }) => {
    handleLobbyState(lobby);
    if (myRole === 'player' && !loadingStarted && !emulatorReady) {
      showToast('Game started! Loading ROM…', 'info');
      loadRomAndStart();
    } else if (myRole === 'spectator') {
      enterSpectatorMode(lobby);
    }
  });

  lobbySocket.on('lobby:chat', (msg) => appendChat(msg));

  lobbySocket.on('game:frame', ({ playerIndex: pIdx, frame }) => {
    if (myRole === 'spectator') {
      updateSpectatorFrame(pIdx, frame);
    }
    updateSidebarSpectatorFrame(pIdx, frame);
  });

  ndsSocket.on('nds:sync', ({ transferId, packets, timestamp }) => {
    // NDS wireless sync received – handled by emulator bridge if active
    if (typeof window._ndsOnSync === 'function') {
      window._ndsOnSync(packets);
    }
  });

  ndsSocket.on('nds:status', ({ active }) => {
    updateLinkIndicator(active);
  });

  lobbySocket.on('disconnect', () => showToast('Disconnected from server', 'error'));
  ndsSocket.on('connect_error', () => {});
}

// ─── Lobby state handler ───────────────────────────────────────────────────
function handleLobbyState(lobby) {
  lobbyState = lobby;

  document.getElementById('lobby-name-display').textContent = `📍 ${lobby.name}`;
  romId = lobby.romId;

  const me = lobby.players.find(p => p.userId === currentUser._id);
  const meSpec = lobby.spectators.find(s => s.userId === currentUser._id);

  if (me) {
    myRole = 'player';
    playerIndex = me.playerIndex;
    document.getElementById('emulator-wrap').classList.add('active');
    document.getElementById('spectator-container').style.display = 'none';
    document.getElementById('nds-emulator').style.display = 'block';
  } else if (meSpec) {
    myRole = 'spectator';
  }

  updateRoleButtons();
  renderPlayerList(lobby);

  // Keep sidebar spectator grid up-to-date with player list.
  // Build proactively so the Watch panel already has cells when a player
  // first opens it — without this the grid is empty and updateSidebarSpectatorFrame
  // silently no-ops on every incoming frame (black Watch panel).
  buildSidebarSpectatorGrid(lobby.players);

  if (lobby.status === 'waiting' && myRole === 'player') {
    const isHost = lobby.hostId === currentUser._id;
    showOverlayMsg(isHost ? 'Ready to start? Press the button below.' : 'Waiting for host to start…');
    document.getElementById('start-game-btn').style.display = isHost ? 'block' : 'none';
    if (isHost) {
      document.getElementById('start-game-btn').onclick = () => {
        lobbySocket.emit('lobby:start', {}, (res) => {
          if (res.error) showToast(res.error, 'error');
        });
      };
    }
  } else if (lobby.status === 'waiting' && myRole === 'spectator') {
    showOverlayMsg('Waiting for host to start the game…');
  } else if (lobby.status === 'playing') {
    if (myRole === 'player' && !emulatorReady && !loadingStarted) {
      loadRomAndStart();
    } else if (myRole === 'spectator') {
      enterSpectatorMode(lobby);
    }
  }
}

function updateRoleButtons() {
  const spectateBtn = document.getElementById('spectate-btn');
  const saveBtn     = document.getElementById('save-btn');
  const lcBtn       = document.getElementById('lc-toggle-btn');
  const lcInd       = document.getElementById('lc-indicator');

  if (myRole === 'spectator') {
    spectateBtn.textContent = '🎮 Play';
    spectateBtn.style.display = 'inline-flex';
    spectateBtn.onclick = switchToPlayer;
    saveBtn.style.display = 'none';
    lcBtn.style.display = 'none';
    lcInd.style.display = 'none';
  } else {
    spectateBtn.textContent = '👁️ Spectate';
    spectateBtn.style.display = 'inline-flex';
    spectateBtn.onclick = switchToSpectator;
    saveBtn.style.display = '';
    lcBtn.style.display = '';
    lcInd.style.display = '';
  }
}

async function switchToSpectator() {
  lobbySocket.emit('lobby:switch-role', { role: 'spectator' }, (res) => {
    if (res?.error) return showToast(res.error, 'error');
    showToast('Switched to spectator mode', 'info');
    stopFrameBroadcast();
    emulatorReady = false;
  });
}

function switchToPlayer() {
  lobbySocket.emit('lobby:switch-role', { role: 'player' }, (res) => {
    if (res?.error) return showToast(res.error, 'error');
    showToast('Switched to player mode — loading game…', 'success');
  });
}

// ─── Render player list ────────────────────────────────────────────────────
function renderPlayerList(lobby) {
  const playerColors = ['p0', 'p1', 'p2', 'p3'];
  const list = document.getElementById('player-list');
  const specList = document.getElementById('spectator-list');

  list.innerHTML = lobby.players.map(p => `
    <div class="player-item ${p.userId === currentUser._id ? 'active' : ''} ${p.userId === lobby.hostId ? 'host' : ''}">
      <img src="${p.avatar || 'data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 40 40\'><circle cx=\'20\' cy=\'20\' r=\'20\' fill=\'%237048e8\'/><text x=\'20\' y=\'26\' text-anchor=\'middle\' font-size=\'18\' fill=\'%23fff\'>${escapeHtml(p.userName[0])}</text></svg>'}" class="player-avatar" alt="">
      <div class="player-info">
        <div class="player-name">${escapeHtml(p.userName)}</div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:3px;">
          <span class="player-badge ${playerColors[p.playerIndex] || ''}">P${p.playerIndex + 1}</span>
          ${p.userId === lobby.hostId ? '<span class="player-badge host">Host</span>' : ''}
          ${p.ready ? '<span class="player-badge ready">Ready</span>' : ''}
        </div>
      </div>
    </div>
  `).join('') || '<div style="color:var(--text-muted);font-size:.85rem;">No players</div>';

  specList.innerHTML = lobby.spectators.map(s => `
    <div class="player-item">
      <img src="${s.avatar || ''}" class="player-avatar" alt="" onerror="this.style.display='none'">
      <div class="player-info">
        <div class="player-name" style="font-size:.88rem;">${escapeHtml(s.userName)}</div>
        <span style="font-size:.75rem;color:var(--text-muted);">Spectating</span>
      </div>
    </div>
  `).join('') || '';
}

// ─── Load ROM and start NDS emulator ──────────────────────────────────────
async function loadRomAndStart() {
  if (loadingStarted || emulatorReady) return;
  loadingStarted = true;
  try {
    setOverlayProgress(10, 'Preparing NDS emulator…');

    document.getElementById('nds-emulator').style.display = 'block';
    document.getElementById('spectator-container').style.display = 'none';
    document.getElementById('start-game-btn').style.display = 'none';

    // Get ROM metadata for the download URL
    const romMeta = await apiFetch(`/api/roms/${romId}`);
    const romFilename = romMeta.filename || 'game.nds';

    setOverlayProgress(30, 'Configuring EmulatorJS…');

    // Configure EmulatorJS to load the NDS ROM
    window.EJS_player      = '#nds-emulator';
    window.EJS_core        = 'desmume';
    window.EJS_gameUrl     = `/api/roms/${romId}/download`;
    window.EJS_pathtodata  = '/emulator-nds/';
    window.EJS_gameName    = romMeta.displayName || 'NDS Game';
    window.EJS_color       = '#7048e8';
    window.EJS_startOnLoaded = true;
    window.EJS_DEBUG_XX    = true;  // Use source files (no minified build needed)
    window.EJS_backgroundColor = '#000';
    window.EJS_noAutoFocus = false;

    // EmulatorJS built-in netplay
    window.EJS_EXPERIMENTAL_NETPLAY = true;
    window.EJS_netplayServer = window.location.origin;
    window.EJS_gameID      = hashStringToInt(romId);

    // Disable EmulatorJS built-in browser storage so that .sav files are
    // exclusively persisted to the server and bound to the user's account.
    window.EJS_disableDatabases    = true;
    window.EJS_disableLocalStorage = true;

    // Hide certain EmulatorJS UI buttons we don't need (we have our own)
    window.EJS_Buttons = {
      playPause:    true,
      restart:      true,
      mute:         false,   // We have our own volume control
      settings:     true,
      fullscreen:   true,
      saveState:    true,
      loadState:    true,
      screenRecord: false,
      gamepad:      true,
      cheat:        true,
      volume:       false,
      saveSavFiles: true,
      loadSavFiles: true,
      quickSave:    true,
      quickLoad:    true,
      screenshot:   true,
      cacheManager: false,
      netplay:      true,
    };

    // Callback when game starts
    window.EJS_onGameStart = async () => {
      emulatorReady = true;
      hideOverlay();

      // Ensure the emulator container is visible and properly laid out
      const ndsEl = document.getElementById('nds-emulator');
      if (ndsEl) ndsEl.style.display = 'block';

      // Tell EmulatorJS (and its Emscripten module) to recalculate the
      // canvas dimensions now that the overlay is gone and the container
      // has its final size.
      window.dispatchEvent(new Event('resize'));

      // Load account-bound save data from the server and inject into the
      // emulator so progress is always tied to the user's account.
      await loadServerSave();

      startSaveTimer();
      startFrameBroadcast();

      // Persist save data when the user leaves or refreshes the page.
      // Use fetch with keepalive:true which is guaranteed to complete even
      // during page unload (unlike normal fetch which may be cancelled).
      window.addEventListener('beforeunload', () => {
        try {
          const ejs = window.EJS_emulator;
          if (!ejs || !ejs.gameManager || !romId) return;
          const save = ejs.gameManager.getSaveFile();
          if (!save || save.length === 0) return;
          const CHUNK = 8192;
          let binary = '';
          for (let i = 0; i < save.length; i += CHUNK) {
            binary += String.fromCharCode.apply(null, save.subarray(i, Math.min(i + CHUNK, save.length)));
          }
          const b64 = btoa(binary);
          const csrfToken = getCachedCsrfToken();
          fetch(`/api/saves/${romId}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
            },
            body: JSON.stringify({ data: b64 }),
            credentials: 'include',
            keepalive: true,
          }).catch(() => {});
        } catch (e) { /* best-effort on unload */ }
      });

      showToast('NDS game loaded! Have fun! 🎮', 'success');

      // ── Hook EmulatorJS Save/Load State buttons to use server storage ──────
      const ejsInstance = window.EJS_emulator;
      if (ejsInstance && typeof ejsInstance.on === 'function') {
        ejsInstance.on('saveState', async () => {
          try {
            await persistSave();
            showToast('Game saved to server! 💾', 'success');
          } catch (e) {
            showToast(`Save failed: ${e.message}`, 'error');
          }
        });

        ejsInstance.on('loadState', async () => {
          try {
            await loadServerSave();
            showToast('Save loaded from server! 📂', 'success');
          } catch (e) {
            showToast(`Load failed: ${e.message}`, 'error');
          }
        });

        ejsInstance.on('saveSave', async () => {
          try {
            await persistSave();
            showToast('Game saved to server! 💾', 'success');
          } catch (e) {
            showToast(`Save failed: ${e.message}`, 'error');
          }
        });

        ejsInstance.on('loadSave', async () => {
          try {
            await loadServerSave();
            showToast('Save loaded from server! 📂', 'success');
          } catch (e) {
            showToast(`Load failed: ${e.message}`, 'error');
          }
        });
      }

      if (lobbyState?.players?.length > 1) {
        setTimeout(() => showToast('💡 Click "📡 Connect" to enable NDS wireless link', 'info'), 2000);
      }
    };

    // Save state callback – persist to our server
    window.EJS_onSaveSave = (e) => {
      if (e && e.screenshot) {
        // EmulatorJS provides save data; we can intercept and persist
        scheduleSave();
      }
    };

    setOverlayProgress(50, 'Loading EmulatorJS…');

    // Load the EmulatorJS loader script dynamically
    await loadEmulatorJSScript();

    setOverlayProgress(80, 'Starting NDS emulator…');

    // EmulatorJS takes over from here – it will call EJS_onGameStart when ready

  } catch (err) {
    console.error('Failed to load NDS game:', err);
    showToast(`Failed to load: ${err.message}`, 'error');
    showOverlayMsg(`Error: ${err.message}`);
    setOverlayProgress(0, `Error: ${err.message}`);
    loadingStarted = false;
  }
}

function loadEmulatorJSScript() {
  return new Promise((resolve, reject) => {
    // Check if already loaded
    if (document.querySelector('script[src*="emulator-nds/loader.js"]')) {
      return resolve();
    }
    const script = document.createElement('script');
    script.src = '/emulator-nds/loader.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Failed to load EmulatorJS'));
    document.head.appendChild(script);
  });
}

/**
 * Load save data from the server (account-bound) and inject into EmulatorJS.
 * Called after EJS_onGameStart so the emulator is ready to accept save data.
 */
async function loadServerSave() {
  try {
    const saveData = await apiFetch(`/api/saves/${romId}`);
    if (saveData.data) {
      let buf;
      try {
        buf = Uint8Array.from(atob(saveData.data), c => c.charCodeAt(0));
      } catch (decodeErr) {
        console.warn('Failed to decode save data:', decodeErr);
        return;
      }
      const ejs = window.EJS_emulator;
      if (ejs && ejs.gameManager) {
        const savePath = ejs.gameManager.getSaveFilePath();
        if (savePath) {
          ejs.gameManager.FS.writeFile(savePath, buf);
          ejs.gameManager.loadSaveFiles();
        }
      } else {
        console.warn('EmulatorJS not ready when loading save');
      }
    }
  } catch (err) {
    // 404 means no save yet – that is normal for new games
    if (err && String(err.message || err) !== 'No save found' && !String(err).includes('404')) {
      console.warn('Failed to load server save:', err);
    }
  }
}

// ─── Save management ──────────────────────────────────────────────────────
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistSave, 2000);
}

function startSaveTimer() {
  if (autoSaveTimer) clearInterval(autoSaveTimer);
  autoSaveTimer = setInterval(persistSave, SAVE_INTERVAL);
}

async function persistSave() {
  if (!emulatorReady || !romId) return;
  if (saveInProgress) return;

  // Try to get save data from EmulatorJS
  const ejs = window.EJS_emulator;
  if (!ejs || !ejs.gameManager) return;

  saveInProgress = true;
  try {
    const save = ejs.gameManager.getSaveFile();
    if (!save || save.length === 0) { saveInProgress = false; return; }

    const CHUNK = 8192;
    let binary = '';
    for (let i = 0; i < save.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, save.subarray(i, Math.min(i + CHUNK, save.length)));
    }
    const b64 = btoa(binary);
    await apiFetch(`/api/saves/${romId}`, {
      method: 'PUT',
      body: JSON.stringify({ data: b64 }),
    });
  } catch (e) {
    // Save persistence is best-effort
    console.warn('NDS save failed:', e);
  } finally {
    saveInProgress = false;
  }
}

// ─── Frame broadcast for spectators ───────────────────────────────────────
let _frameBroadcastRAF = null;
let _frameCaptureCanvas = null;
let _frameCaptureCtx    = null;
let _lastFrameTime      = 0;

function broadcastFrame() {
  if (!emulatorReady || myRole !== 'player') return;
  // socket.to(lobby.id) delivers frames to others only – no extra gate needed.

  const now = Date.now();
  if (now - _lastFrameTime < FRAME_EMIT_INTERVAL) return;
  _lastFrameTime = now;

  try {
    // Find the EmulatorJS canvas
    const container = document.getElementById('nds-emulator');
    const canvas = container?.querySelector('canvas');
    if (!canvas) return;

    if (!_frameCaptureCanvas) {
      _frameCaptureCanvas = document.createElement('canvas');
      _frameCaptureCtx = _frameCaptureCanvas.getContext('2d');
    }
    if (_frameCaptureCanvas.width !== canvas.width || _frameCaptureCanvas.height !== canvas.height) {
      _frameCaptureCanvas.width  = canvas.width;
      _frameCaptureCanvas.height = canvas.height;
    }
    _frameCaptureCtx.drawImage(canvas, 0, 0);

    _frameCaptureCanvas.toBlob((blob) => {
      if (!blob) return;
      blob.arrayBuffer().then((buf) => {
        lobbySocket.emit('game:frame', { frame: buf });
      });
    }, 'image/png');
  } catch (err) {
    console.warn('NDS frame capture failed:', err);
  }
}

function _frameBroadcastLoop() {
  broadcastFrame();
  _frameBroadcastRAF = requestAnimationFrame(_frameBroadcastLoop);
}

function startFrameBroadcast() {
  if (_frameBroadcastRAF) return;
  _frameBroadcastRAF = requestAnimationFrame(_frameBroadcastLoop);
}

function stopFrameBroadcast() {
  if (_frameBroadcastRAF) {
    cancelAnimationFrame(_frameBroadcastRAF);
    _frameBroadcastRAF = null;
  }
}

// ─── Spectator mode ───────────────────────────────────────────────────────
function enterSpectatorMode(lobby) {
  hideOverlay();
  document.getElementById('nds-emulator').style.display = 'none';
  const container = document.getElementById('spectator-container');
  container.style.display = 'flex';

  buildSpectatorGrid(lobby.players);
  applySpectatorView();
}

function buildSpectatorGrid(players) {
  const grid = document.getElementById('spectator-grid');
  if (!grid || !players.length) return;
  if (grid.childElementCount === players.length) return;

  grid.innerHTML = '';
  players.forEach((p) => {
    const cell = document.createElement('div');
    cell.className = 'spectator-cell';
    cell.dataset.playerIndex = p.playerIndex;
    cell.innerHTML = `
      <img id="spec-img-${p.playerIndex}" class="spectator-cell-img" alt="P${p.playerIndex + 1}" style="display:none;">
      <div class="spectator-cell-label">P${p.playerIndex + 1} – ${escapeHtml(p.userName)}</div>
      <div class="spectator-cell-waiting">Waiting for feed…</div>
    `;
    cell.addEventListener('click', () => toggleMaximizePlayer(p.playerIndex));
    grid.appendChild(cell);
  });
}

function toggleMaximizePlayer(pIdx) {
  selectedPlayer = selectedPlayer === pIdx ? null : pIdx;
  applySpectatorView();
}

function applySpectatorView() {
  const grid = document.getElementById('spectator-grid');
  const mainWrap = document.getElementById('spectator-main');
  const mainImg = document.getElementById('spectator-view');
  const backBtn = document.getElementById('spectator-back-btn');
  if (!grid) return;

  if (selectedPlayer !== null) {
    grid.style.display = 'none';
    mainWrap.style.display = 'flex';
    backBtn.style.display = 'block';
    const cellImg = document.getElementById(`spec-img-${selectedPlayer}`);
    if (cellImg && cellImg.src && (cellImg.src.startsWith('data:') || cellImg.src.startsWith('blob:'))) {
      mainImg.src = cellImg.src;
      mainImg.style.display = 'block';
    }
  } else {
    grid.style.display = 'grid';
    mainWrap.style.display = 'none';
    backBtn.style.display = 'none';
  }
}

function updateSpectatorFrame(pIdx, frame) {
  let blobUrl;
  let isBlobUrl = false;
  if (frame instanceof ArrayBuffer || (frame && frame.byteLength !== undefined)) {
    blobUrl = URL.createObjectURL(new Blob([frame], { type: 'image/png' }));
    isBlobUrl = true;
  } else {
    blobUrl = `data:image/png;base64,${frame}`;
  }

  const cellImg = document.getElementById(`spec-img-${pIdx}`);
  if (cellImg) {
    if (cellImg._blobUrl) URL.revokeObjectURL(cellImg._blobUrl);
    cellImg._blobUrl = isBlobUrl ? blobUrl : null;
    cellImg.src = blobUrl;
    cellImg.style.display = 'block';
    const waitEl = cellImg.parentElement.querySelector('.spectator-cell-waiting');
    if (waitEl) waitEl.style.display = 'none';
  }

  if (selectedPlayer === pIdx) {
    const mainImg = document.getElementById('spectator-view');
    if (mainImg._blobUrl) URL.revokeObjectURL(mainImg._blobUrl);
    mainImg._blobUrl = isBlobUrl ? blobUrl : null;
    mainImg.src = blobUrl;
    mainImg.style.display = 'block';
  }
}

// ─── Sidebar spectator grid ────────────────────────────────────────────────
function buildSidebarSpectatorGrid(players) {
  const grid = document.getElementById('sidebar-spectator-grid');
  if (!grid || !players) return;

  const others = currentUser && currentUser._id
    ? players.filter(p => p.userId !== currentUser._id)
    : players;

  if (grid.childElementCount === others.length) return;

  grid.innerHTML = '';
  others.forEach((p) => {
    const cell = document.createElement('div');
    cell.className = 'sidebar-spectator-cell';
    cell.dataset.playerIndex = p.playerIndex;
    cell.innerHTML = `
      <img id="sidebar-spec-img-${p.playerIndex}" class="sidebar-spectator-cell-img" alt="P${p.playerIndex + 1}" style="display:none;">
      <div class="sidebar-spectator-cell-label">P${p.playerIndex + 1} – ${escapeHtml(p.userName)}</div>
      <div class="sidebar-spectator-cell-waiting">Waiting…</div>
    `;
    grid.appendChild(cell);
  });
}

function updateSidebarSpectatorFrame(pIdx, frame) {
  const cellImg = document.getElementById(`sidebar-spec-img-${pIdx}`);
  if (!cellImg) return;

  let blobUrl;
  let isBlobUrl = false;
  if (frame instanceof ArrayBuffer || (frame && frame.byteLength !== undefined)) {
    blobUrl = URL.createObjectURL(new Blob([frame], { type: 'image/png' }));
    isBlobUrl = true;
  } else {
    blobUrl = `data:image/png;base64,${frame}`;
  }

  if (cellImg._blobUrl) URL.revokeObjectURL(cellImg._blobUrl);
  cellImg._blobUrl = isBlobUrl ? blobUrl : null;
  cellImg.src = blobUrl;
  cellImg.style.display = 'block';
  const waitEl = cellImg.parentElement.querySelector('.sidebar-spectator-cell-waiting');
  if (waitEl) waitEl.style.display = 'none';
}

function switchSidebarTab(tab) {
  sidebarTab = tab;
  const chatPanel = document.getElementById('sidebar-panel-chat');
  const watchPanel = document.getElementById('sidebar-panel-watch');
  const chatBtn = document.getElementById('sidebar-tab-chat');
  const watchBtn = document.getElementById('sidebar-tab-watch');
  if (!chatPanel || !watchPanel) return;

  if (tab === 'watch') {
    chatPanel.style.display = 'none';
    watchPanel.style.display = 'flex';
    chatBtn.classList.remove('active');
    watchBtn.classList.add('active');
    if (lobbyState && lobbyState.players) {
      buildSidebarSpectatorGrid(lobbyState.players);
    }
  } else {
    chatPanel.style.display = '';
    watchPanel.style.display = 'none';
    chatBtn.classList.add('active');
    watchBtn.classList.remove('active');
  }
}

// ─── NDS Wireless Link ────────────────────────────────────────────────────
function toggleNdsLink() {
  if (!emulatorReady) return showToast('Load a game first', 'error');

  const ejs = window.EJS_emulator;

  // If already in a netplay session, disconnect
  if (ejs && ejs.isNetplay) {
    if (typeof ejs.netplay?.leaveRoom === 'function') {
      ejs.netplay.leaveRoom();
    }
    updateLinkIndicator(false);
    showToast('Disconnected from netplay', 'info');
    return;
  }

  // Try EmulatorJS built-in netplay with auto-lobby
  if (ejs && typeof ejs.openNetplayMenu === 'function') {
    // Ensure the EmulatorJS netplay subsystem is initialised
    if (!ejs.netplay || typeof ejs.netplay.openRoom !== 'function') {
      ejs.openNetplayMenu();
      ejs.netplay.name = currentUser?.displayName || 'Player';
      const popups = ejs.netplayMenu?.querySelectorAll('.ejs_popup_container');
      if (popups) popups.forEach(p => p.remove());
    }
    if (!ejs.netplay.name) {
      ejs.netplay.name = currentUser?.displayName || 'Player';
    }

    const isHost = lobbyState?.hostId === currentUser?._id;
    const roomName = lobbyState?.name || 'Game Room';

    if (isHost) {
      ejs.netplay.openRoom(roomName, 4, '');
      updateLinkIndicator(true);
      showToast('Netplay room created – other players can connect!', 'success');
    } else {
      autoJoinNetplayRoom(ejs, roomName);
    }
    return;
  }

  // Fallback: use our SIO NDS link implementation
  if (!ndsLinkEnabled) {
    enableNdsLink();
  } else {
    disableNdsLink();
  }
}

/**
 * Non-host players: find the room matching the lobby name and join it.
 * Retries a few times in case the host hasn't created the room yet.
 */
async function autoJoinNetplayRoom(ejs, roomName, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const rooms = await ejs.netplay.getOpenRooms();
      const roomId = Object.keys(rooms).find(id => rooms[id].room_name === roomName);
      if (roomId) {
        ejs.netplay.joinRoom(roomId, roomName);
        updateLinkIndicator(true);
        showToast('Joined netplay room!', 'success');
        return;
      }
    } catch (err) {
      console.warn('Netplay room search failed:', err);
    }
    if (attempt < retries) {
      showToast(`Looking for room… (attempt ${attempt + 1})`, 'info');
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  showToast('No netplay room found – ask the host to connect first', 'error');
}

function enableNdsLink() {
  ndsSocket.emit('nds:join', { lobbyId }, (res) => {
    if (res.error) return showToast(res.error, 'error');
    ndsLinkEnabled = true;
    updateLinkIndicator(true);
    document.getElementById('lc-toggle-btn').textContent = '📡 Disconnect';
    showToast(`NDS link connected! Player ${res.playerIndex + 1} of ${res.playerCount}`, 'success');
  });
}

function disableNdsLink() {
  ndsSocket.emit('nds:leave', {}, () => {});
  ndsLinkEnabled = false;
  updateLinkIndicator(false);
  document.getElementById('lc-toggle-btn').textContent = '📡 Connect';
  showToast('NDS link disconnected', 'info');
}

function updateLinkIndicator(active) {
  const el  = document.getElementById('lc-indicator');
  const btn = document.getElementById('lc-toggle-btn');
  el.className = `lc-status ${active ? 'active' : 'inactive'}`;
  el.querySelector('span').textContent = active ? 'NDS Link Active' : 'NDS Link';
  btn.textContent = active ? '📡 Disconnect' : '📡 Connect';
}

// ─── Chat ──────────────────────────────────────────────────────────────────
function appendChat(msg) {
  const container = document.getElementById('chat-messages');
  const el = document.createElement('div');
  el.className = 'chat-msg';
  if (msg.system) {
    el.className += ' chat-msg-system';
    el.textContent = msg.message;
  } else {
    el.innerHTML = `<span class="chat-msg-name">${escapeHtml(msg.userName)}</span><span class="chat-msg-text">${escapeHtml(msg.message)}</span>`;
  }
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

// ─── UI Helpers ────────────────────────────────────────────────────────────
function showOverlayMsg(msg) {
  const overlay = document.getElementById('emulator-overlay');
  overlay.classList.remove('hidden');
  document.getElementById('overlay-msg').textContent = msg;
}

function hideOverlay() {
  document.getElementById('emulator-overlay').classList.add('hidden');
}

function setOverlayProgress(pct, msg) {
  document.getElementById('load-progress').style.width = `${pct}%`;
  if (msg) document.getElementById('overlay-msg').textContent = msg;
}

function initUIEvents() {
  // Leave button
  document.getElementById('leave-btn').addEventListener('click', async () => {
    lobbySocket.emit('lobby:leave', {}, () => {
      window.location.href = '/lobby';
    });
    setTimeout(() => { window.location.href = '/lobby'; }, 2000);
  });

  // Manual save button
  document.getElementById('save-btn').addEventListener('click', async () => {
    try {
      await persistSave();
      showToast('Game saved!', 'success');
    } catch (err) {
      showToast(`Save failed: ${err.message}`, 'error');
    }
  });

  // Spectator back-to-grid button
  const backBtn = document.getElementById('spectator-back-btn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      selectedPlayer = null;
      applySpectatorView();
    });
  }

  // NDS link toggle
  document.getElementById('lc-toggle-btn').addEventListener('click', toggleNdsLink);

  // Sidebar tab toggle
  document.getElementById('sidebar-tab-chat').addEventListener('click', () => switchSidebarTab('chat'));
  document.getElementById('sidebar-tab-watch').addEventListener('click', () => switchSidebarTab('watch'));

  // Chat send
  const chatInput = document.getElementById('chat-input');
  const sendBtn   = document.getElementById('chat-send');
  const doSend = () => {
    const msg = chatInput.value.trim();
    if (!msg) return;
    lobbySocket.emit('lobby:chat', { message: msg });
    chatInput.value = '';
  };
  sendBtn.addEventListener('click', doSend);
  chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });

  // Volume control
  const volumeSlider = document.getElementById('volume-slider');
  const muteBtn      = document.getElementById('mute-btn');
  let _muted = false;
  let _volume = 1.0;

  if (volumeSlider) {
    volumeSlider.addEventListener('input', () => {
      _volume = volumeSlider.value / 100;
      // EmulatorJS has its own volume control but we can try to adjust via its API
      const ejs = window.EJS_emulator;
      if (ejs && typeof ejs.setVolume === 'function') {
        ejs.setVolume(_muted ? 0 : _volume);
      }
      if (_volume > 0) _muted = false;
      muteBtn.textContent = _muted || _volume === 0 ? '🔇' : _volume < 0.5 ? '🔉' : '🔊';
    });
  }

  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      _muted = !_muted;
      const ejs = window.EJS_emulator;
      if (ejs && typeof ejs.setVolume === 'function') {
        ejs.setVolume(_muted ? 0 : _volume);
      }
      muteBtn.textContent = _muted || _volume === 0 ? '🔇' : _volume < 0.5 ? '🔉' : '🔊';
    });
  }

  // Resize handle
  initEmulatorResize();
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Convert a string (e.g. ROM id) to a stable positive integer, used as the
 * EmulatorJS gameID for netplay room matching.
 */
function hashStringToInt(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) || 1;
}

// ─── Drag-to-resize emulator wrapper ────────────────────────────────────────
function initEmulatorResize() {
  const handle = document.getElementById('emulator-resize-handle');
  const wrap   = document.getElementById('emulator-wrap');
  if (!handle || !wrap) return;

  let startX, startY, startW, startH;

  handle.addEventListener('mousedown', onStart);
  handle.addEventListener('touchstart', onStart, { passive: false });

  function onStart(e) {
    e.preventDefault();
    const point = e.touches ? e.touches[0] : e;
    const rect  = wrap.getBoundingClientRect();
    startX = point.clientX;
    startY = point.clientY;
    startW = rect.width;
    startH = rect.height;
    wrap.style.flex = 'none';
    wrap.style.width  = startW + 'px';
    wrap.style.height = startH + 'px';
    wrap.classList.add('resizing');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
  }

  function onMove(e) {
    e.preventDefault();
    const point = e.touches ? e.touches[0] : e;
    const dx = point.clientX - startX;
    const dy = point.clientY - startY;
    const parent = wrap.parentElement;
    const maxW = parent ? parent.clientWidth - 20 : Infinity;
    const maxH = parent ? parent.clientHeight - 20 : Infinity;
    wrap.style.width  = Math.max(256, Math.min(startW + dx, maxW)) + 'px';
    wrap.style.height = Math.max(192, Math.min(startH + dy, maxH)) + 'px';
  }

  function onEnd() {
    wrap.classList.remove('resizing');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onEnd);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onEnd);
  }
}
