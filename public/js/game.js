'use strict';
/**
 * Game room – game.html
 *
 * Responsibilities:
 * - Connect to lobby socket and maintain lobby state
 * - Initialise EmulatorJS (mGBA core) for GBA emulation (with built-in
 *   mobile touch controls, settings menu, gamepad support)
 * - Bridge GBA link cable data via the Lua-inspired /lualink socket namespace
 *   (Player 0 = master, always connected; Players 1-3 = slaves/clients)
 * - Compatible ROM selection for non-host players (e.g. Leaf Green when host
 *   uses Fire Red)
 * - Stream canvas frames to spectators when acting as host
 * - Stream opt-in audio to spectators (WebAudio capture + MediaRecorder)
 * - Persist save data to server (Google-account-linked)
 */

// ─── Constants ────────────────────────────────────────────────────────────
const FRAME_EMIT_INTERVAL = 50;    // ms between spectator frame broadcasts (~20 fps)
const SAVE_INTERVAL = 30000;       // ms between auto-saves (30000ms = 30s)
const STREAM_STALL_TIMEOUT = 3000; // ms without a new frame before spectator reconnects

// ─── State ────────────────────────────────────────────────────────────────
let currentUser  = null;
let lobbyId      = null;
let lobbyState   = null;
let myRole       = null;  // 'player' | 'spectator'
let playerIndex  = -1;

let lobbySocket  = null;
let lcSocket     = null;  // /lualink namespace socket
let rfuSocket    = null;  // /rfu namespace socket for RFU wireless adapter discovery

let emulatorReady = false;
let romId        = null;       // lobby's primary ROM id
let playerRomId  = null;       // this player's chosen ROM (may differ for non-host)
let loadingStarted = false; // guard against duplicate loadRomAndStart calls

let frameTimer   = null;
let saveTimer    = null;

let lcEnabled    = false;
let lcPending    = null;  // Promise resolver for current LC transfer
let currentTransferId = 0; // tracks the server-side session.transferId
let _pendingLinkCable = false; // true when lua:status arrived before emulator was ready
let _allPlayersReady = false; // true when all connected players have signalled ready
// ── SIO Mode constants (must match server-side values) ───────────────────
// Both mGBA (lockstep.c) and VBA-M (gbaLink.cpp) support multiple SIO modes.
// The game can switch modes at any time via RCNT/SIOCNT.
const SIO_MODE_MULTI    = 0;  // 16-bit multiplay (up to 4 players)
const SIO_MODE_NORMAL8  = 1;  // 8-bit normal serial (2 players)
const SIO_MODE_NORMAL32 = 2;  // 32-bit normal serial (2 players)
let currentSioMode = SIO_MODE_MULTI; // current detected SIO mode
let initDone     = false; // guard against duplicate initUIEvents calls
let selectedPlayer = null;  // spectator: null = grid view, number = maximized player index
let autoSaveTimer = null;   // reference to auto-save interval timer
let saveInProgress = false; // guard against concurrent saves
let sidebarTab = 'chat';   // active sidebar tab: 'chat' | 'watch'

// ─── Spectator streaming watchdog ─────────────────────────────────────────
let _lastFrameAt      = 0;   // epoch ms of last received frame (spectator side)
let _streamWatchdog   = null; // setInterval handle

// ─── Opt-in spectator audio streaming ─────────────────────────────────────
let _audioRecorder    = null; // MediaRecorder for outgoing audio (player side)
let _audioEnabled     = false; // spectator: user opted in to sound
let _audioCtx         = null; // shared AudioContext for playback (spectator side)

// ─── WebRTC P2P Link Cable ──────────────────────────────────────────────────
// WebRTC DataChannels provide a direct peer-to-peer path between players,
// eliminating the server relay round-trip that causes desync.  The server
// (/webrtc-signal namespace) is used only for WebRTC signaling (SDP, ICE).
//
// Star topology: master (P0) has one RTCPeerConnection + DataChannel per slave.
// DataChannel protocol:
//   Master → Slave:  { type:'transfer', masterWord, transferId }
//   Slave  → Master: { type:'word', word, playerIndex, transferId }
//   Master → All:    { type:'sync', words:[w0,w1,w2,w3], transferId }
//
// Fallback: if RTCPeerConnection is unavailable or ICE fails the existing
// Socket.IO relay (/lualink) continues to work transparently.

const RTC_ICE_TIMEOUT      = 10000; // ms to wait for ICE before falling back to Socket.IO relay
const RTC_TRANSFER_TIMEOUT =   500; // ms to wait for slave DataChannel words before Socket.IO fallback

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

let rtcSignalSocket   = null;       // /webrtc-signal Socket.IO socket (signaling only)
let _rtcPeers         = new Map();  // peerPlayerIndex → RTCPeerConnection
let _rtcChannels      = new Map();  // peerPlayerIndex → RTCDataChannel (master-side, outbound)
let _rtcSlaveChannels = new Map();  // masterPlayerIndex → RTCDataChannel (slave-side, inbound)
let _rtcFallback      = false;      // true = WebRTC unavailable/failed; use Socket.IO relay
let _rtcIceTimers     = new Map();  // peerPlayerIndex → fallback timer handle
let _rtcPendingWords  = new Map();  // peerPlayerIndex/'master' → received word (current transfer)
let _rtcPendingResolve= null;       // Promise resolver for the in-flight WebRTC transfer
let _rtcPendingId     = -1;         // transferId of the in-flight WebRTC transfer
let _rtcPendingCount  = 0;          // number of open slave channels we expect to respond

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
  lcSocket    = io('/lualink', { withCredentials: true });
  rtcSignalSocket = io('/webrtc-signal', { withCredentials: true });

  // ── RFU Wireless Adapter discovery socket ─────────────────────────────────
  // Connects to the /rfu namespace for lobby-level game discovery.
  // Used by mgbaBridge.js when the GBA calls GetBroadcastData (0x18) to
  // find other wireless players.  Actual data exchange goes over PeerJS.
  rfuSocket = io('/rfu', { withCredentials: true });

  rfuSocket.on('connect', () => {
    // Wire the RFU socket into the bridge whenever it connects / reconnects,
    // passing lobbyId directly to avoid relying on window._rfuLobbyId.
    if (window.MgbaBridge) {
      window.MgbaBridge.setRfuSocket(rfuSocket, lobbyId);
    }
    // Retain window._rfuLobbyId as a fallback for any external scripts
    window._rfuLobbyId = lobbyId;
  });

  rfuSocket.on('rfu:host-available', ({ userName }) => {
    showToast(`🔍 Wireless game available from ${userName || 'a player'}`, 'info');
  });

  rfuSocket.on('rfu:host-left', ({ userName }) => {
    console.log(`[RFU] ${userName} stopped hosting`);
  });

  // ── WebRTC signaling handlers ─────────────────────────────────────────────
  // These run on the /webrtc-signal namespace and only exchange SDP/ICE data.
  // Actual link cable bytes never pass through the server once P2P is up.

  // Slave receives an offer from master
  rtcSignalSocket.on('webrtc:offer', async ({ from, to, sdp }) => {
    if (to !== playerIndex || playerIndex === 0) return;

    let pc = _rtcPeers.get(from);
    if (!pc) {
      pc = new RTCPeerConnection(RTC_CONFIG);
      _rtcPeers.set(from, pc);

      pc.onicecandidate = (evt) => {
        if (evt.candidate && rtcSignalSocket?.connected) {
          rtcSignalSocket.emit('webrtc:ice-candidate', {
            to: from,
            candidate: evt.candidate.toJSON(),
          });
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'failed' ||
            pc.iceConnectionState === 'disconnected') {
          console.warn(`[WebRTC] Slave ICE failed to P${from} – using Socket.IO relay`);
          _rtcFallback = true;
        }
      };

      // Slave receives the DataChannel created by master
      pc.ondatachannel = (evt) => {
        const dc = evt.channel;
        _rtcSlaveChannels.set(from, dc);
        dc.onopen  = () => console.log(`[WebRTC] Slave DataChannel open from P${from}`);
        dc.onmessage = (msgEvt) => {
          try { _handleRtcMessage(JSON.parse(msgEvt.data), from); }
          catch (e) { /* ignore malformed messages */ }
        };
        dc.onerror = () => {
          console.warn(`[WebRTC] Slave DataChannel error from P${from} – using Socket.IO relay`);
          _rtcFallback = true;
        };
      };
    }

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      rtcSignalSocket.emit('webrtc:answer', { to: from, sdp: pc.localDescription });
    } catch (err) {
      console.warn('[WebRTC] Failed to handle offer:', err.message);
      _rtcFallback = true;
    }
  });

  // Master receives an answer from a slave
  rtcSignalSocket.on('webrtc:answer', async ({ from, to, sdp }) => {
    if (to !== playerIndex || playerIndex !== 0) return;
    const pc = _rtcPeers.get(from);
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    } catch (err) {
      console.warn(`[WebRTC] Failed to handle answer from P${from}:`, err.message);
      _rtcFallback = true;
    }
  });

  // Relay ICE candidates to the correct peer connection
  rtcSignalSocket.on('webrtc:ice-candidate', async ({ from, to, candidate }) => {
    if (to !== playerIndex) return;
    const pc = _rtcPeers.get(from);
    if (!pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) { /* may be benign during renegotiation */ }
  });

  // Peer disconnected – close their connection and fall back for any open transfer
  rtcSignalSocket.on('webrtc:peer-left', ({ from }) => {
    const pc = _rtcPeers.get(from);
    if (pc) { try { pc.close(); } catch (e) { /* ignore */ } }
    _rtcPeers.delete(from);
    _rtcChannels.delete(from);
    _rtcSlaveChannels.delete(from);
    console.log(`[WebRTC] P${from} left – connection closed`);
  });

  lobbySocket.on('connect', () => {
    // Always emit lobby:join on (re)connect so the new socket is added to the
    // room.  The server handles reconnecting users by updating their socketId
    // rather than duplicating them.
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

  // Server explicitly notifies all clients when the host changes so the UI
  // can update the "Host" badge without waiting for the next full state push.
  lobbySocket.on('lobby:host-changed', ({ hostId, hostName }) => {
    if (lobbyState) {
      lobbyState.hostId = hostId;
      lobbyState.hostName = hostName;
    }
    // Update start-game button visibility based on new host
    const isHost = hostId === currentUser?._id;
    const startBtn = document.getElementById('start-game-btn');
    if (startBtn && lobbyState?.status === 'waiting' && myRole === 'player') {
      startBtn.style.display = isHost ? 'block' : 'none';
    }
    const hostBadge = isHost ? '👑 You are now the host!' : `👑 ${escapeHtml(hostName)} is now the host`;
    showToast(hostBadge, 'info');
  });

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

  // Receive frames from other players (for spectators and other players)
  lobbySocket.on('game:frame', ({ playerIndex: pIdx, frame }) => {
    // Update the spectator stream watchdog timestamp
    _lastFrameAt = Date.now();

    if (myRole === 'spectator') {
      updateSpectatorFrame(pIdx, frame);
    }
    // Also update the sidebar watch panel so players can see other feeds
    updateSidebarSpectatorFrame(pIdx, frame);
  });

  // Receive opt-in audio chunks from players (spectator sound)
  lobbySocket.on('game:audio', ({ playerIndex: pIdx, chunk }) => {
    if (_audioEnabled) {
      playAudioChunk(chunk);
    }
  });

  // ── Link cable socket reconnect handler ──────────────────────────────────
  // When lcSocket reconnects after a brief disconnect (e.g. mobile network
  // hiccup), re-emit lua:join so the server re-adds us to the session.
  // Without this the link cable appears "connected" on the client side (lcEnabled=true)
  // but the server has no record of us, causing all subsequent transfers to fail.
  lcSocket.on('connect', () => {
    if (lcEnabled && emulatorReady) {
      lcSocket.emit('lua:join', { lobbyId }, (res) => {
        if (res?.error) {
          console.warn('[LC] Re-join after reconnect failed:', res.error);
        } else {
          currentTransferId = 0; // reset to avoid stale-transfer rejections
          if (res?.sioMode !== undefined) currentSioMode = res.sioMode;
          updateLcIndicator(true, res?.connectedCount);
          // Re-signal ready after reconnect
          lcSocket.emit('lua:ready', {}, () => {});
          console.log(`[LC] Re-joined link cable session after socket reconnect (P${res?.playerIndex})`);
        }
      });
    }
  });

  // Lua-style link cable events
  lcSocket.on('lua:sync', ({ transferId, words, mode, normalData, timestamp }) => {
    // Keep our transfer ID in sync with the server so subsequent sends are not
    // rejected as stale.  The server increments its transferId after each sync.
    currentTransferId = transferId + 1;

    // Track mode changes from the server
    if (mode !== undefined) currentSioMode = mode;

    if (lcPending) {
      // Master: resolve the pending requestTransfer promise
      // For Normal mode, pass the normalData if available
      lcPending(words);
      lcPending = null;
    } else if (playerIndex !== 0 && typeof window._luaInjectSync === 'function') {
      // Slave: inject the synced data directly into the emulator
      window._luaInjectSync(words);
    }
  });

  // Server tells slaves that the master has sent – respond with our SIOMLT_SEND
  lcSocket.on('lua:masterReady', ({ transferId, masterWord, mode }) => {
    if (!lcEnabled || playerIndex === 0) return; // only slaves respond
    // Sync transferId if needed
    if (transferId !== undefined) currentTransferId = transferId;
    // Track mode from server
    if (mode !== undefined) currentSioMode = mode;
    // Read the slave's current SIOMLT_SEND value and respond
    const slaveWord = readSlaveWord();
    lcSocket.emit('lua:send', { word: slaveWord, transferId: currentTransferId }, (ack) => {
      if (ack?.error === 'stale transfer' && ack.currentTransferId !== undefined) {
        currentTransferId = ack.currentTransferId;
      }
    });
  });

  // Server notifies all players that every participant is ready
  lcSocket.on('lua:readyState', ({ allReady, readyCount, connectedCount }) => {
    _allPlayersReady = allReady;
    if (allReady) {
      showToast(`🔗 All ${connectedCount} players ready – link cable fully active!`, 'success');
    }
  });

  // Server notifies of SIO mode change
  lcSocket.on('lua:modeChanged', ({ mode, prevMode }) => {
    currentSioMode = mode;
    const modeNames = { 0: 'Multiplay', 1: 'Normal 8-bit', 2: 'Normal 32-bit' };
    console.log(`[LC] SIO mode changed: ${modeNames[prevMode] || prevMode} → ${modeNames[mode] || mode}`);
  });

  lcSocket.on('lua:status', ({ active, playerCount, connectedCount, isMaster, sioMode }) => {
    updateLcIndicator(active, connectedCount);
    if (sioMode !== undefined) currentSioMode = sioMode;
    // Auto-connect link cable when the session is active and we are a player
    // with a ready emulator.  This covers both P0 (host) and P1-P3 (non-host)
    // so that both sides connect regardless of join order.
    if (active && myRole === 'player' && emulatorReady && !lcEnabled) {
      enableLinkCable();
    }
    // If the emulator is not ready yet, remember that the link cable should
    // be enabled as soon as it is.  The EJS_onGameStart handler checks this.
    if (active && myRole === 'player' && !emulatorReady) {
      _pendingLinkCable = true;
    }
  });

  lobbySocket.on('disconnect', () => showToast('Disconnected from server', 'error'));
  lcSocket.on('connect_error', () => {});
}

// ─── Lobby state handler ───────────────────────────────────────────────────
function handleLobbyState(lobby) {
  lobbyState = lobby;

  document.getElementById('lobby-name-display').textContent = `📍 ${lobby.name}`;
  romId = lobby.romId;
  // playerRomId is set once when the game first loads (may differ for non-P0
  // players who picked a compatible ROM); keep it once set.
  if (!playerRomId) playerRomId = lobby.romId;

  // Determine role
  const me = lobby.players.find(p => p.userId === currentUser._id);
  const meSpec = lobby.spectators.find(s => s.userId === currentUser._id);

  if (me) {
    myRole = 'player';
    playerIndex = me.playerIndex;
    document.getElementById('emulator-wrap').classList.add('active');
    // Ensure spectator UI is hidden when switching to player
    document.getElementById('spectator-container').style.display = 'none';
    document.getElementById('gba-emulator').style.display = 'block';
  } else if (meSpec) {
    myRole = 'spectator';
  }

  // Update toolbar buttons based on role
  updateRoleButtons();

  renderPlayerList(lobby);

  // Keep sidebar spectator grid up-to-date with player list.
  // Build proactively so the Watch panel already has cells when a player
  // first opens it — without this the grid is empty and updateSidebarSpectatorFrame
  // silently no-ops on every incoming frame (black Watch panel).
  buildSidebarSpectatorGrid(lobby.players);

  // Show start button to players if game not started
  if (lobby.status === 'waiting' && myRole === 'player') {
    const isHost = lobby.hostId === currentUser._id;
    showOverlayMsg(isHost ? 'Ready to start? Press the button below.' : `Waiting for host to start…`);
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
    } else if (myRole === 'player' && emulatorReady) {
      // Enable link cable for ANY player once another player is present or
      // the session is already active.  This covers both the host (P0) and
      // joining players (P1-P3) so both sides auto-connect regardless of
      // join order.
      const otherPlayersPresent = (lobby.players?.length ?? 0) > 1;
      if (!lcEnabled && (otherPlayersPresent || lobby.linkCableActive)) {
        enableLinkCable();
      }
      // Keep indicator in sync with lobby state even if our local lcEnabled
      // flag is already true (e.g. after a reconnect).
      updateLcIndicator(lcEnabled || lobby.linkCableActive);
    } else if (myRole === 'spectator') {
      enterSpectatorMode(lobby);
    }
  }
}

// Show/hide toolbar buttons depending on current role
function updateRoleButtons() {
  const spectateBtn   = document.getElementById('spectate-btn');
  const saveBtn       = document.getElementById('save-btn');
  const loadBtn       = document.getElementById('load-btn');
  const lcBtn         = document.getElementById('lc-toggle-btn');
  const lcInd         = document.getElementById('lc-indicator');
  const audioBtn      = document.getElementById('audio-stream-btn');

  if (myRole === 'spectator') {
    spectateBtn.textContent = '🎮 Join as Player';
    spectateBtn.style.display = 'inline-flex';
    spectateBtn.onclick = switchToPlayer;
    saveBtn.style.display = 'none';
    loadBtn.style.display = 'none';
    lcBtn.style.display = 'none';
    lcInd.style.display = 'none';
    // Show opt-in audio button for spectators
    if (audioBtn) {
      audioBtn.style.display = 'inline-flex';
      audioBtn.title = 'Enable game sound (opt-in)';
      audioBtn.textContent = _audioEnabled ? '🔊 Audio On' : '🔇 Audio Off';
      audioBtn.onclick = toggleSpectatorAudio;
    }
  } else {
    spectateBtn.textContent = '👁️ Spectate';
    spectateBtn.style.display = 'inline-flex';
    spectateBtn.onclick = switchToSpectator;
    saveBtn.style.display = '';
    loadBtn.style.display = '';
    // Master (P0) link cable is always on – hide the manual toggle button
    if (playerIndex === 0) {
      lcBtn.style.display = 'none';
    } else {
      lcBtn.style.display = '';
    }
    lcInd.style.display = '';
    // Show audio capture button for players (so spectators can hear the game)
    if (audioBtn) {
      audioBtn.style.display = 'inline-flex';
      audioBtn.title = _audioRecorder ? 'Stop audio streaming to spectators' : 'Stream audio to spectators';
      audioBtn.textContent = _audioRecorder ? '🔊 Stop Audio' : '🔈 Stream Audio';
      audioBtn.onclick = togglePlayerAudio;
    }
  }
}

function toggleSpectatorAudio() {
  _audioEnabled = !_audioEnabled;
  if (!_audioEnabled) stopSpectatorAudio();
  const btn = document.getElementById('audio-stream-btn');
  if (btn) btn.textContent = _audioEnabled ? '🔊 Audio On' : '🔇 Audio Off';
  showToast(_audioEnabled ? '🔊 Audio enabled' : '🔇 Audio disabled', 'info');
}

async function togglePlayerAudio() {
  if (_audioRecorder) {
    stopAudioCapture();
    showToast('🔇 Audio streaming stopped', 'info');
  } else {
    await startAudioCapture();
  }
  updateRoleButtons(); // refresh button label
}

async function switchToSpectator() {
  try { if (emulatorReady) await persistSave(); } catch (e) { console.warn('Save before spectate failed:', e); }
  lobbySocket.emit('lobby:switch-role', { role: 'spectator' }, (res) => {
    if (res?.error) return showToast(res.error, 'error');
    showToast('Switched to spectator mode', 'info');
    // Stop frame broadcast timer, audio capture, and presence overlay
    stopFrameBroadcastTimer();
    stopAudioCapture();
    if (window.PokemonPresence) window.PokemonPresence.stopPresence();
    emulatorReady = false;
    loadingStarted = false;
  });
}

function switchToPlayer() {
  // Stop spectator-specific timers before switching roles
  stopSpectatorStreamWatchdog();
  stopSpectatorAudio();
  lobbySocket.emit('lobby:switch-role', { role: 'player' }, (res) => {
    if (res?.error) return showToast(res.error, 'error');
    showToast('Joining as player — loading your own emulator instance…', 'success');
    // The lobby:state event will trigger handleLobbyState → loadRomAndStart.
    // For non-host players, promptCompatibleRomSelection runs before the ROM loads.
  });
}

// ─── Compatible ROM selection ──────────────────────────────────────────────
/**
 * For non-P0 (non-host) players, check whether compatible alternative ROMs
 * exist (e.g. Leaf Green when the host uses Fire Red).  If so, show the
 * #compat-rom-modal so the player can choose their version before loading.
 *
 * Returns the chosen romId (string).  Resolves immediately to the lobby ROM
 * if the player is P0, if no compatible alternatives exist, or if the modal
 * is dismissed without a selection.
 */
async function promptCompatibleRomSelection() {
  // P0 always uses the lobby's ROM
  if (playerIndex === 0) return romId;

  let compatRoms = [];
  try {
    compatRoms = await apiFetch(`/api/roms/${romId}/compatible`);
  } catch (e) {
    return romId; // silently fall back to lobby ROM
  }

  // Only show the selector when there is more than one option (i.e. real
  // alternatives exist beyond the host's own ROM)
  if (!compatRoms || compatRoms.length <= 1) return romId;

  return new Promise((resolve) => {
    const modal  = document.getElementById('compat-rom-modal');
    const select = document.getElementById('compat-rom-select');
    const btn    = document.getElementById('compat-rom-confirm-btn');

    if (!modal || !select || !btn) return resolve(romId);

    // Populate the dropdown
    select.innerHTML = compatRoms.map(r =>
      `<option value="${r._id}"${r._id === romId ? ' selected' : ''}>${escapeHtml(r.displayName)}</option>`
    ).join('');

    modal.style.display = 'flex';

    const confirm = () => {
      modal.style.display = 'none';
      btn.removeEventListener('click', confirm);
      resolve(select.value || romId);
    };
    btn.addEventListener('click', confirm);
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

// ─── Load ROM and start GBA emulator (EmulatorJS + mGBA core) ─────────────
async function loadRomAndStart() {
  if (loadingStarted || emulatorReady) return;
  loadingStarted = true;
  try {
    setOverlayProgress(10, 'Preparing GBA emulator…');

    document.getElementById('gba-emulator').style.display = 'block';
    document.getElementById('spectator-container').style.display = 'none';
    document.getElementById('start-game-btn').style.display = 'none';

    // Non-P0 players may choose a compatible ROM (e.g. Leaf Green when host
    // uses Fire Red).  This awaits a possible UI prompt before continuing.
    playerRomId = await promptCompatibleRomSelection();

    // Get ROM metadata for the download URL
    const romMeta = await apiFetch(`/api/roms/${playerRomId}`);
    const romFilename = romMeta.filename || 'game.gba';

    setOverlayProgress(30, 'Configuring EmulatorJS…');

    // Configure EmulatorJS to load the GBA ROM with mGBA core
    window.EJS_player      = '#gba-emulator';
    window.EJS_core        = 'mgba';
    window.EJS_gameUrl     = `/api/roms/${playerRomId}/download`;
    window.EJS_pathtodata  = '/emulator-gba/';
    window.EJS_gameName    = romMeta.displayName || 'GBA Game';
    window.EJS_color       = '#7048e8';
    window.EJS_startOnLoaded = true;
    window.EJS_DEBUG_XX    = true;  // Serve unminified EmulatorJS source files for debugging
    window.EJS_backgroundColor = '#000';
    window.EJS_noAutoFocus = false;

    // Configure EmulatorJS UI buttons – enable settings, gamepad, fullscreen,
    // mobile touch controls etc.  Disable buttons we handle ourselves.
    window.EJS_Buttons = {
      playPause:    true,
      restart:      true,
      mute:         false,   // We have our own volume control
      settings:     true,
      fullscreen:   true,
      saveState:    true,
      loadState:    true,
      screenRecord: false,
      gamepad:      true,    // Built-in gamepad support with mapping UI
      cheat:        true,
      volume:       false,
      saveSavFiles: true,
      loadSavFiles: true,
      quickSave:    true,
      quickLoad:    true,
      screenshot:   true,
      cacheManager: false,
      netplay:      false,   // Only link cable emulation is used – no EJS netplay
    };

    // Callback when game starts
    window.EJS_onGameStart = async () => {
      emulatorReady = true;
      hideOverlay();

      // Ensure the emulator container is visible and properly laid out
      const gbaEl = document.getElementById('gba-emulator');
      if (gbaEl) gbaEl.style.display = 'block';

      // Tell EmulatorJS (and its Emscripten module) to recalculate the
      // canvas dimensions now that the overlay is gone and the container
      // has its final size.
      window.dispatchEvent(new Event('resize'));

      // Load account-bound save data from the server and inject into the
      // emulator so progress is always tied to the user's account.
      await loadServerSave();

      startSaveTimer();
      startFrameBroadcastTimer();

      // Start the Pokemon player-presence overlay (shows other players on the
      // overworld for supported Pokemon Gen 3 games, inspired by the approach
      // used by TheHunterManX/GBA-PK-multiplayer).
      if (window.PokemonPresence && lobbyState) {
        window.PokemonPresence.initPresence(lobbyId, playerIndex, window.EJS_gameName);
      }

      // Persist save data when the user leaves or refreshes the page.
      // Use fetch with keepalive:true which is guaranteed to complete even
      // during page unload (unlike normal fetch which may be cancelled).
      window.addEventListener('beforeunload', () => {
        try {
          const ejs = window.EJS_emulator;
          if (!ejs || !ejs.gameManager || !playerRomId) return;
          const save = ejs.gameManager.getSaveFile();
          if (!save || save.length === 0) return;
          // Skip uninitialized SRAM (all 0xFF)
          if (isUninitializedSave(save)) return;
          const b64 = saveToBase64(save);
          const csrfToken = getCachedCsrfToken();
          fetch(`/api/saves/${playerRomId}`, {
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

      showToast('Game loaded! Have fun! 🎮', 'success');

      // ── Hook EmulatorJS save events to use server storage ───────────────
      // In-game SAV-file buttons persist battery saves to saves.db,
      // and save-state buttons persist full snapshots to savestates.db.
      // Both are backed up to the server and tied to the user's account.
      const ejsInstance = window.EJS_emulator;
      if (ejsInstance && typeof ejsInstance.on === 'function') {
        // "Save SAV Files" button → save .sav to server
        ejsInstance.on('saveSave', async () => {
          try {
            await persistSave();
            showToast('Game saved to server! 💾', 'success');
          } catch (e) {
            showToast(`Save failed: ${e.message}`, 'error');
          }
        });

        // "Load SAV Files" button → load .sav from server
        ejsInstance.on('loadSave', async () => {
          try {
            await loadServerSave();
            showToast('Save loaded from server! 📂', 'success');
          } catch (e) {
            showToast(`Load failed: ${e.message}`, 'error');
          }
        });

        // ── Save-state quick-save/load → persist to server ────────────────
        // EmulatorJS quickSave/quickLoad default to IndexedDB which is
        // browser-local and can be cleared.  We intercept to also persist
        // slot 1 save states to the server (savestates.db, separate from
        // saves.db used for in-game battery saves).
        ejsInstance.on('saveState', async () => {
          try { await persistSaveState(); } catch (e) {
            console.warn('Server save-state backup failed:', e);
          }
        });

        ejsInstance.on('loadState', async () => {
          try { await loadServerSaveState(); } catch (e) {
            console.warn('Server save-state load failed:', e);
          }
        });
      }

      // Auto-connect link cable when another player is present, the link
      // cable session is already active, OR a lua:status event arrived
      // while the emulator was still loading (_pendingLinkCable).
      const shouldAutoConnect = _pendingLinkCable ||
                                lobbyState?.linkCableActive ||
                                (lobbyState?.players?.length ?? 0) > 1;
      _pendingLinkCable = false;
      if (shouldAutoConnect) {
        setTimeout(() => {
          if (playerIndex === 0) {
            showToast('🔗 Link cable active (you are the master)', 'success');
          } else {
            showToast('💡 Connecting link cable…', 'info');
          }
          enableLinkCable();
        }, 2000);
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

    setOverlayProgress(80, 'Starting GBA emulator…');

    // EmulatorJS takes over from here – it will call EJS_onGameStart when ready

  } catch (err) {
    console.error('Failed to load GBA game:', err);
    showToast(`Failed to load: ${err.message}`, 'error');
    showOverlayMsg(`Error: ${err.message}`);
    setOverlayProgress(0, `Error: ${err.message}`);
    loadingStarted = false;
  }
}

function loadEmulatorJSScript() {
  return new Promise((resolve, reject) => {
    // Check if already loaded
    if (document.querySelector('script[src*="emulator-gba/loader.js"]')) {
      return resolve();
    }
    const script = document.createElement('script');
    script.src = '/emulator-gba/loader.js';
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
    const saveData = await apiFetch(`/api/saves/${playerRomId}`);
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

/**
 * Check if a save buffer is uninitialized (all 0xFF bytes).
 * GBA SRAM is 128 KB and defaults to 0xFF; persisting this wastes space
 * and produces the all-slash base64 string seen in the database.
 */
function isUninitializedSave(buf) {
  if (!buf || buf.length === 0) return true;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0xFF) return false;
  }
  return true;
}

/**
 * Convert a Uint8Array to a base64 string, processing in chunks to avoid
 * call-stack overflow on large GBA save files (up to 128 KB).
 */
function saveToBase64(save) {
  const CHUNK = 8192;
  let binary = '';
  for (let i = 0; i < save.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, save.subarray(i, Math.min(i + CHUNK, save.length)));
  }
  return btoa(binary);
}

async function persistSave() {
  if (!emulatorReady || !playerRomId) return;
  if (saveInProgress) return;

  // Get save data from EmulatorJS gameManager
  const ejs = window.EJS_emulator;
  if (!ejs || !ejs.gameManager) return;

  saveInProgress = true;
  try {
    const save = ejs.gameManager.getSaveFile();
    if (!save || save.length === 0) { saveInProgress = false; return; }

    // Skip saving uninitialized SRAM (all 0xFF) – this is not real save data
    if (isUninitializedSave(save)) { saveInProgress = false; return; }

    const b64 = saveToBase64(save);
    await apiFetch(`/api/saves/${playerRomId}`, {
      method: 'PUT',
      body: JSON.stringify({ data: b64 }),
    });
  } finally {
    saveInProgress = false;
  }
}

// ─── Save-state persistence (server-side, separate from in-game saves) ────
// Uses /api/savestates (savestates.db) – completely independent of saves.db.
let saveStateInProgress = false;

/**
 * Persist a save-state snapshot to the server (quick-save slot 1).
 * EmulatorJS's getState() returns a Uint8Array with the full emulator snapshot.
 */
async function persistSaveState() {
  if (!emulatorReady || !playerRomId) return;
  if (saveStateInProgress) return;

  const ejs = window.EJS_emulator;
  if (!ejs || !ejs.gameManager) return;

  saveStateInProgress = true;
  try {
    // EmulatorJS exposes getState() on the gameManager to capture a full
    // emulator snapshot (CPU registers, RAM, VRAM, etc.).
    const state = typeof ejs.gameManager.getState === 'function'
      ? ejs.gameManager.getState()
      : null;
    if (!state || state.length === 0) return;

    const b64 = saveToBase64(state);
    await apiFetch(`/api/savestates/${playerRomId}`, {
      method: 'PUT',
      body: JSON.stringify({ data: b64 }),
    });
    showToast('Save state backed up to server! 📸', 'success');
  } catch (e) {
    console.warn('Save state persist failed:', e);
    showToast(`Save state backup failed: ${e.message}`, 'error');
  } finally {
    saveStateInProgress = false;
  }
}

/**
 * Load a save-state snapshot from the server and inject into the emulator.
 */
async function loadServerSaveState() {
  if (!emulatorReady || !playerRomId) return;

  const ejs = window.EJS_emulator;
  if (!ejs || !ejs.gameManager) return;

  try {
    const res = await apiFetch(`/api/savestates/${playerRomId}`);
    if (res.data) {
      const buf = Uint8Array.from(atob(res.data), c => c.charCodeAt(0));
      if (typeof ejs.gameManager.loadState === 'function') {
        ejs.gameManager.loadState(buf);
        showToast('Save state restored from server! ⏪', 'success');
      } else {
        showToast('Emulator does not support loadState', 'error');
      }
    } else {
      showToast('No save state found on server', 'info');
    }
  } catch (err) {
    if (err && String(err).includes('404')) {
      showToast('No save state found on server', 'info');
    } else {
      showToast(`Failed to load save state: ${err.message}`, 'error');
    }
  }
}

// ─── Multiplayer diagnostics ──────────────────────────────────────────────
/**
 * Request diagnostic data from the /lualink server to verify the connection
 * and data flow.  Returns a snapshot of the session state, transfer stats,
 * and round-trip latency.
 */
async function requestLinkDiagnostics() {
  return new Promise((resolve) => {
    if (!lcSocket || !lcSocket.connected) {
      return resolve({ connected: false, error: 'Socket not connected' });
    }

    const clientTime = Date.now();
    let resolved = false;

    // First, measure round-trip latency with lua:ping
    lcSocket.emit('lua:ping', { clientTime }, (pingRes) => {
      const latency = Date.now() - clientTime;

      // Then fetch full diagnostics
      lcSocket.emit('lua:diagnostics', {}, (diagRes) => {
        if (resolved) return;
        resolved = true;
        resolve({
          ...diagRes,
          latencyMs: latency,
          serverTimeOffset: pingRes?.serverTime ? (pingRes.serverTime - clientTime - latency / 2) : null,
          clientTime,
        });
      });
    });

    // Safety timeout – only fires if the callbacks above never complete
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      resolve({ connected: false, error: 'Diagnostics timeout' });
    }, 5000);
  });
}

/**
 * Show diagnostics in the browser console and optionally update a UI panel.
 */
async function showLinkDiagnostics() {
  const diag = await requestLinkDiagnostics();
  console.log('[LinkCable Diagnostics]', diag);

  const panel = document.getElementById('lc-diagnostics-content');
  if (!panel) return diag;

  // Gather local I/O detection status
  const mod = getWasmModule();
  const modAvailable = !!mod?.HEAPU16;

  if (!diag.connected) {
    const localLines = [
      `❌ Not connected: ${diag.error || 'unknown'}`,
      `── Local Status ──`,
      `   WASM Module: ${modAvailable ? 'Available ✅' : 'NOT available ❌'}`,
      `   I/O detection: ${_lcDetectionStrategy || 'not yet attempted'}`,
      `   Link cable enabled: ${lcEnabled}`,
      `   Retry count: ${_lcRetryCount}/${LC_MAX_RETRIES}`,
    ];
    panel.textContent = localLines.join('\n');
    return diag;
  }

  const lines = [
    `✅ Connected to lobby: ${diag.lobbyId}`,
    `   Player index: P${diag.playerIndex} (${diag.isMaster ? 'Master' : 'Slave'})`,
    `   Connected players: [${diag.connectedPlayers?.join(', ')}] (${diag.connectedCount}/${diag.lobbyPlayerCount})`,
    `   Link cable active: ${diag.linkCableActive ? 'Yes' : 'No'}`,
    `   Transfer ID: ${diag.transferId}`,
    `   Round-trip latency: ${diag.latencyMs}ms`,
    `── Transfer Stats ──`,
    `   Total syncs: ${diag.stats?.totalTransfers ?? 0}`,
    `   Master sends: ${diag.stats?.masterSends ?? 0}`,
    `   Slave sends: ${diag.stats?.slaveSends ?? 0}`,
    `   Timeouts: ${diag.stats?.timeouts ?? 0}`,
    `   Last transfer: ${diag.stats?.lastTransferAt ? new Date(diag.stats.lastTransferAt).toLocaleTimeString() : 'never'}`,
    `── Local I/O Status ──`,
    `   WASM Module: ${modAvailable ? 'Available ✅' : 'NOT available ❌'}`,
    `   I/O detection strategy: ${_lcDetectionStrategy || 'none'}`,
    `   Register interceptor: ${typeof window._luaInjectSync === 'function' ? 'Installed ✅' : 'Not installed ❌'}`,
    `── Architecture ──`,
    `   ${diag.architecture}`,
  ];
  panel.textContent = lines.join('\n');
  return diag;
}

// ─── Frame broadcast for spectators ───────────────────────────────────────
// Use a hidden 2D canvas to reliably capture frames from the EmulatorJS canvas.
let _frameCaptureCanvas = null;
let _frameCaptureCtx    = null;

function broadcastFrame() {
  if (!emulatorReady || myRole !== 'player') return;
  // socket.to(lobby.id) delivers frames to others only – no extra gate needed.

  const now = Date.now();
  if (!broadcastFrame._last || now - broadcastFrame._last >= FRAME_EMIT_INTERVAL) {
    broadcastFrame._last = now;

    try {
      // Find the EmulatorJS canvas inside the container
      const container = document.getElementById('gba-emulator');
      const canvas = container?.querySelector('canvas');
      if (!canvas) return;

      // Copy the canvas to a 2D canvas so toBlob always has valid pixel data
      if (!_frameCaptureCanvas) {
        _frameCaptureCanvas = document.createElement('canvas');
        _frameCaptureCtx = _frameCaptureCanvas.getContext('2d');
      }
      // Keep capture canvas in sync with the source canvas dimensions
      if (_frameCaptureCanvas.width !== canvas.width || _frameCaptureCanvas.height !== canvas.height) {
        _frameCaptureCanvas.width  = canvas.width;
        _frameCaptureCanvas.height = canvas.height;
      }
      _frameCaptureCtx.drawImage(canvas, 0, 0);

      // Send binary PNG via toBlob – lossless quality, ideal for GBA pixel art
      // at 240×160 where PNG compresses flat colours very efficiently.
      _frameCaptureCanvas.toBlob((blob) => {
        if (!blob) return;
        blob.arrayBuffer().then((buf) => {
          lobbySocket.emit('game:frame', { frame: buf });
        });
      }, 'image/png');
    } catch (err) {
      console.warn('Frame capture failed:', err);
    }
  }
}

// Frame broadcast loop using requestAnimationFrame.  This is more
// reliable than setInterval for visual content because it is
// synchronised with the browser's render cycle, ensuring we always
// read a freshly-composited frame from the canvas.
let _frameBroadcastRAF = null;

function _frameBroadcastLoop() {
  broadcastFrame();
  _frameBroadcastRAF = requestAnimationFrame(_frameBroadcastLoop);
}

function startFrameBroadcastTimer() {
  if (_frameBroadcastRAF) return;
  _frameBroadcastRAF = requestAnimationFrame(_frameBroadcastLoop);
}

function stopFrameBroadcastTimer() {
  if (_frameBroadcastRAF) {
    cancelAnimationFrame(_frameBroadcastRAF);
    _frameBroadcastRAF = null;
  }
}

// ─── Opt-in audio streaming (player → spectators) ─────────────────────────
// Strategy: use the browser's native Tab Audio capture via
// navigator.mediaDevices.getDisplayMedia({ audio: true, video: true }).
// The player is prompted once to "share screen with audio"; the video track
// is discarded and only the audio track is relayed to spectators via Socket.IO
// as compressed WebM/Opus chunks (~100 ms each).
//
// Spectators toggle sound via the 🔈 button.  The button is hidden by default
// (opt-in) to avoid auto-playing audio when three spectators are watching.
//
// NOTE: getDisplayMedia REQUIRES a user gesture and browser permission.
// If it fails (e.g. user denies or browser blocks headless tab capture),
// we fall back silently to no audio.

async function startAudioCapture() {
  if (_audioRecorder) return; // already recording
  try {
    // Capture tab audio.  `video` is required by the getDisplayMedia spec –
    // most browsers refuse { video: false } even when only audio is needed.
    // We request the smallest possible video (1×1) to satisfy the requirement
    // and immediately stop all video tracks after the call returns, keeping
    // only the audio tracks for streaming.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: 1, height: 1 }, // minimal video – discarded immediately
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 44100,
      },
    });

    // Stop the video track immediately – we only need audio
    stream.getVideoTracks().forEach(t => t.stop());

    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      showToast('No audio track captured – grant audio permission', 'error');
      return;
    }

    const audioOnlyStream = new MediaStream(audioTracks);
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    _audioRecorder = new MediaRecorder(audioOnlyStream, { mimeType, audioBitsPerSecond: 48000 });
    _audioRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0 && lobbySocket.connected) {
        e.data.arrayBuffer().then((buf) => {
          lobbySocket.emit('game:audio', { chunk: buf });
        });
      }
    };
    _audioRecorder.onerror = (e) => {
      console.warn('[Audio] Recorder error:', e);
      stopAudioCapture();
    };
    _audioRecorder.start(100); // emit chunks every 100 ms
    showToast('🔊 Audio streaming started', 'success');
  } catch (e) {
    console.warn('[Audio] getDisplayMedia failed:', e.message);
    if (e.name !== 'NotAllowedError') {
      showToast('Audio capture unavailable: ' + e.message, 'error');
    }
  }
}

function stopAudioCapture() {
  if (_audioRecorder) {
    try { _audioRecorder.stop(); } catch (_) {}
    _audioRecorder = null;
  }
}

// ─── Spectator audio playback ──────────────────────────────────────────────
// Incoming audio/webm chunks are decoded on demand and scheduled end-to-end
// on an AudioContext timeline to produce a gapless, low-latency stream.
// _audioNextTime tracks the scheduled end of the last buffer so each new
// chunk is appended immediately after it without overlap or gaps.
let _audioNextTime   = 0;
const AUDIO_LATENCY  = 0.1; // seconds of initial buffer to absorb network jitter

function ensureAudioCtx() {
  if (_audioCtx) return _audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  _audioCtx = new Ctx();
  return _audioCtx;
}

function playAudioChunk(chunk) {
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();

  const arrayBuf = chunk instanceof ArrayBuffer ? chunk : null;
  if (!arrayBuf) return;

  ctx.decodeAudioData(arrayBuf.slice(0), (audioBuffer) => {
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    if (_audioNextTime < now + AUDIO_LATENCY) {
      _audioNextTime = now + AUDIO_LATENCY;
    }
    source.start(_audioNextTime);
    _audioNextTime += audioBuffer.duration;
  }, (err) => {
    // Chunk decode failed – skip it silently
    console.debug('[Audio] Chunk decode error (skip):', err?.message);
  });
}

function stopSpectatorAudio() {
  if (_audioCtx) {
    _audioCtx.close().catch(() => {});
    _audioCtx = null;
  }
  _audioNextTime = 0;
}

// ─── Spectator mode ───────────────────────────────────────────────────────
// selectedPlayer: null = grid view (all miniatures), number = maximized player
function enterSpectatorMode(lobby) {
  hideOverlay();
  document.getElementById('gba-emulator').style.display = 'none';
  const container = document.getElementById('spectator-container');
  container.style.display = 'flex';

  buildSpectatorGrid(lobby.players);
  applySpectatorView();

  // Start the stream stall watchdog: if no frame is received for
  // STREAM_STALL_TIMEOUT ms the spectator socket reconnects so the player's
  // frame broadcast can deliver again.
  _lastFrameAt = Date.now();
  startSpectatorStreamWatchdog();
}

// ── Spectator stream stall watchdog ─────────────────────────────────────────
function startSpectatorStreamWatchdog() {
  if (_streamWatchdog) clearInterval(_streamWatchdog);
  _streamWatchdog = setInterval(() => {
    if (myRole !== 'spectator') {
      clearInterval(_streamWatchdog);
      _streamWatchdog = null;
      return;
    }
    if (_lastFrameAt > 0 && Date.now() - _lastFrameAt > STREAM_STALL_TIMEOUT) {
      // No new frame in the last 3 seconds – reconnect the lobby socket so
      // the player's frame broadcast loop can reach us again.
      _lastFrameAt = Date.now(); // reset to avoid rapid-fire reconnects
      showToast('⚠️ Stream stalled – reconnecting…', 'info');
      // Disconnect and let Socket.IO auto-reconnect (calls lobby:join again)
      lobbySocket.disconnect();
      setTimeout(() => lobbySocket.connect(), 500);
    }
  }, 1000);
}

function stopSpectatorStreamWatchdog() {
  if (_streamWatchdog) { clearInterval(_streamWatchdog); _streamWatchdog = null; }
  _lastFrameAt = 0;
}

function buildSpectatorGrid(players) {
  const grid = document.getElementById('spectator-grid');
  if (!grid || !players.length) return;

  // Only rebuild if player count changed
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
  if (selectedPlayer === pIdx) {
    // Already maximized – go back to grid
    selectedPlayer = null;
  } else {
    selectedPlayer = pIdx;
  }
  applySpectatorView();
}

function applySpectatorView() {
  const grid = document.getElementById('spectator-grid');
  const mainWrap = document.getElementById('spectator-main');
  const mainImg = document.getElementById('spectator-view');
  const backBtn = document.getElementById('spectator-back-btn');
  if (!grid) return;

  if (selectedPlayer !== null) {
    // Maximized: hide grid, show main view
    grid.style.display = 'none';
    mainWrap.style.display = 'flex';
    backBtn.style.display = 'block';
    // Copy latest frame from the cell
    const cellImg = document.getElementById(`spec-img-${selectedPlayer}`);
    if (cellImg && cellImg.src && (cellImg.src.startsWith('data:') || cellImg.src.startsWith('blob:'))) {
      mainImg.src = cellImg.src;
      mainImg.style.display = 'block';
    }
  } else {
    // Grid view: show all miniatures
    grid.style.display = 'grid';
    mainWrap.style.display = 'none';
    backBtn.style.display = 'none';
  }
}

function updateSpectatorFrame(pIdx, frame) {
  // frame may be an ArrayBuffer (binary) or a base64 string (legacy)
  let blobUrl;
  let isBlobUrl = false;
  if (frame instanceof ArrayBuffer || (frame && frame.byteLength !== undefined)) {
    blobUrl = URL.createObjectURL(new Blob([frame], { type: 'image/png' }));
    isBlobUrl = true;
  } else {
    blobUrl = `data:image/png;base64,${frame}`;
  }

  // Always update the grid cell image (keeps thumbnails live)
  const cellImg = document.getElementById(`spec-img-${pIdx}`);
  if (cellImg) {
    // Revoke previous blob URL to avoid memory leaks
    if (cellImg._blobUrl) URL.revokeObjectURL(cellImg._blobUrl);
    cellImg._blobUrl = isBlobUrl ? blobUrl : null;
    cellImg.src = blobUrl;
    cellImg.style.display = 'block';
    // Hide the "waiting" text once first frame arrives
    const waitEl = cellImg.parentElement.querySelector('.spectator-cell-waiting');
    if (waitEl) waitEl.style.display = 'none';
  }

  // If this player is maximized, also update the main view
  if (selectedPlayer === pIdx) {
    const mainImg = document.getElementById('spectator-view');
    if (mainImg._blobUrl) URL.revokeObjectURL(mainImg._blobUrl);
    mainImg._blobUrl = isBlobUrl ? blobUrl : null;
    mainImg.src = blobUrl;
    mainImg.style.display = 'block';
  }
}

// ─── Sidebar spectator grid (Watch tab for players) ────────────────────────
function buildSidebarSpectatorGrid(players) {
  const grid = document.getElementById('sidebar-spectator-grid');
  if (!grid || !players) return;

  // Hide the current user's own game – it is already visible on the main canvas
  const others = currentUser && currentUser._id
    ? players.filter(p => p.userId !== currentUser._id)
    : players;

  // Only rebuild if player count changed
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
    // Build sidebar grid if lobby state available
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

// ─── Link Cable / Multiplayer ──────────────────────────────────────────────
/**
 * Toggle link cable connection (used by slave players P1-P3).
 *
 * The Lua-inspired approach mirrors the GBA SIO Multiplay hardware model:
 *   - Player 0 (master) has the link cable active at all times and drives
 *     every transfer cycle.
 *   - Players 1-3 (slaves) connect when they want to participate in a
 *     trade or battle and respond to the master's transfers.
 *
 * The link cable data is relayed via the /lualink Socket.IO namespace.
 */
function toggleLinkCable() {
  if (!emulatorReady) return showToast('Load a game first', 'error');
  // P0 is always connected – the toggle has no effect for the master
  if (playerIndex === 0) return showToast('Master link cable is always active', 'info');

  if (!lcEnabled) {
    enableLinkCable();
  } else {
    disableLinkCable();
  }
}

function enableLinkCable() {
  lcSocket.emit('lua:join', { lobbyId }, (res) => {
    if (res.error) return showToast(res.error, 'error');
    lcEnabled = true;
    // Sync the transfer ID with the server to avoid stale-transfer
    // rejections if the session was already in progress.
    if (res.transferId !== undefined) {
      currentTransferId = res.transferId;
    }
    // Sync SIO mode from server
    if (res.sioMode !== undefined) {
      currentSioMode = res.sioMode;
    }
    updateLcIndicator(true, res.connectedCount);
    const btn = document.getElementById('lc-toggle-btn');
    if (btn) btn.textContent = '🔗 Disconnect';

    if (res.connectedCount >= 2) {
      showToast(`🔗 Link cable connected! ${res.connectedCount} players linked.`, 'success');
    }

    // ── Connection ready handshake (common to mGBA lockstep & VBA-M) ─────
    // Signal that this player's emulator is loaded and ready for transfers.
    // The server will not allow data exchange until all players confirm ready.
    lcSocket.emit('lua:ready', {}, (readyAck) => {
      if (readyAck?.allReady) {
        _allPlayersReady = true;
      }
    });

    // Start polling for link cable transfers
    startLinkCablePolling(res.playerIndex);

    // ── Wire the RFU bridge (single unified path for wireless games) ─────
    // The MgbaBridge polls SIO registers every frame.  When it detects
    // NORMAL_32BIT mode with the 0x9966 RFU magic it takes over from the
    // multiplay path.  We wire the RFU Socket.io socket and PeerLinkCable
    // here so the bridge has everything it needs for discovery and P2P.
    if (window.MgbaBridge) {
      if (rfuSocket) {
        window.MgbaBridge.setRfuSocket(rfuSocket, lobbyId);
        window._rfuLobbyId = lobbyId; // retained as fallback
      }
      if (window.PeerLinkCable) {
        window.MgbaBridge.connectPeer(window.PeerLinkCable);
      }
    }

    // ── Attempt WebRTC P2P connection ────────────────────────────────────
    // Run alongside Socket.IO relay; actual data goes over WebRTC once the
    // DataChannels are open.  Socket.IO stays as fallback automatically.
    initWebRtcLink(res.playerIndex, lobbyState);
  });
}

function disableLinkCable() {
  lcSocket.emit('lua:leave', {}, () => {});
  lcEnabled = false;
  lcPending = null;
  _pendingLinkCable = false;
  _allPlayersReady = false;
  currentTransferId = 0;
  currentSioMode = SIO_MODE_MULTI;
  if (_lcRetryTimer) { clearInterval(_lcRetryTimer); _lcRetryTimer = null; }
  if (_lcPollingInterval) { clearInterval(_lcPollingInterval); _lcPollingInterval = null; }
  closeWebRtcLink();
  // Disconnect RFU bridge sockets on disable
  if (window.MgbaBridge) {
    window.MgbaBridge.setRfuSocket(null);
    window.MgbaBridge.disconnectPeer();
  }
  updateLcIndicator(false);
  const btn = document.getElementById('lc-toggle-btn');
  if (btn) btn.textContent = '🔗 Connect';
  showToast('Link cable disconnected', 'info');
}

// ─── Wireless game discovery (RFU) ───────────────────────────────────────────
/**
 * Query the /rfu Socket.io namespace for available wireless games in the
 * current lobby.  This implements the UI-facing "Discovery" function for
 * Wireless Adapter (RFU) multiplayer: it lists all players who are currently
 * hosting a wireless session (i.e. have called SetBroadcastData + StartBroadcast).
 *
 * Each entry contains:
 *   { hostId, userName, gameInfo: number[], peerId: string }
 * where `peerId` is the PeerJS room ID for direct P2P connection.
 *
 * Returns an empty array when the socket is not connected or the query
 * times out after 3 seconds.
 *
 * @returns {Promise<Array<{hostId:string, userName:string, gameInfo:number[], peerId:string}>>}
 */
function discoverWirelessGames() {
  return new Promise((resolve) => {
    if (!rfuSocket?.connected || !lobbyId) {
      resolve([]);
      return;
    }
    const timeoutId = setTimeout(() => resolve([]), 3000);
    rfuSocket.emit('rfu:search', { lobbyId }, (res) => {
      clearTimeout(timeoutId);
      const games = Array.isArray(res?.games) ? res.games : [];
      resolve(games);
    });
  });
}

// Expose for the browser console / external UI components
window.discoverWirelessGames = discoverWirelessGames;

// ─── WebRTC P2P helpers ──────────────────────────────────────────────────────

/**
 * Initialise WebRTC connections after the link cable Socket.IO session joins.
 * Master (P0) creates one RTCPeerConnection + DataChannel per slave.
 * Slaves wait for offers relayed by the signaling server.
 *
 * @param {number} myIdx   - this player's index (0 = master)
 * @param {object} lobby   - lobbyState (used to enumerate slave indices)
 */
function initWebRtcLink(myIdx, lobby) {
  if (!window.RTCPeerConnection) {
    _rtcFallback = true;
    console.warn('[WebRTC] RTCPeerConnection not available – using Socket.IO relay');
    return;
  }
  if (!rtcSignalSocket?.connected) {
    _rtcFallback = true;
    console.warn('[WebRTC] Signaling socket not connected – using Socket.IO relay');
    return;
  }
  _rtcFallback = false;

  rtcSignalSocket.emit('webrtc:join', { lobbyId }, (res) => {
    if (res?.error) {
      console.warn('[WebRTC] Failed to join signaling room:', res.error);
      _rtcFallback = true;
      return;
    }
    if (myIdx === 0 && lobby?.players) {
      // Master: create one peer connection to each slave
      const slaveIndices = lobby.players
        .filter(p => p.playerIndex !== 0)
        .map(p => p.playerIndex);
      for (const si of slaveIndices) {
        _createPeerConnectionToSlave(si);
      }
    }
    // Slaves: wait for offers emitted by master (handled in connectSockets signaling handlers)
  });
}

/**
 * Master-only: create an RTCPeerConnection + DataChannel to a slave.
 *
 * @param {number} slaveIdx - the slave's playerIndex (1–3)
 */
function _createPeerConnectionToSlave(slaveIdx) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  _rtcPeers.set(slaveIdx, pc);

  // Reliable, ordered DataChannel – mirrors the GBA hardware transfer model
  const dc = pc.createDataChannel('link-cable', { ordered: true });
  _rtcChannels.set(slaveIdx, dc);

  dc.onopen = () => {
    console.log(`[WebRTC] DataChannel open to P${slaveIdx} – P2P link cable active`);
    const timer = _rtcIceTimers.get(slaveIdx);
    if (timer) { clearTimeout(timer); _rtcIceTimers.delete(slaveIdx); }
    showToast(`🔗 WebRTC direct connection to P${slaveIdx} established`, 'success');
  };

  dc.onmessage = (evt) => {
    try { _handleRtcMessage(JSON.parse(evt.data), slaveIdx); }
    catch (e) { /* ignore malformed */ }
  };

  dc.onerror = () => {
    console.warn(`[WebRTC] DataChannel error to P${slaveIdx} – using Socket.IO relay`);
    _rtcFallback = true;
  };

  pc.onicecandidate = (evt) => {
    if (evt.candidate && rtcSignalSocket?.connected) {
      rtcSignalSocket.emit('webrtc:ice-candidate', {
        to: slaveIdx,
        candidate: evt.candidate.toJSON(),
      });
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed' ||
        pc.iceConnectionState === 'disconnected') {
      console.warn(`[WebRTC] ICE failed for P${slaveIdx} – using Socket.IO relay`);
      _rtcFallback = true;
    }
  };

  // Create offer and send to slave via signaling server
  pc.createOffer()
    .then(offer => pc.setLocalDescription(offer))
    .then(() => {
      if (rtcSignalSocket?.connected) {
        rtcSignalSocket.emit('webrtc:offer', {
          to: slaveIdx,
          sdp: pc.localDescription,
        });
      }
    })
    .catch(err => {
      console.warn(`[WebRTC] createOffer failed for P${slaveIdx}:`, err.message);
      _rtcFallback = true;
    });

  // Arm fallback timer in case ICE never completes
  const timer = setTimeout(() => {
    if (!dc || dc.readyState !== 'open') {
      console.warn(`[WebRTC] ICE timeout for P${slaveIdx} – using Socket.IO relay`);
      _rtcFallback = true;
    }
  }, RTC_ICE_TIMEOUT);
  _rtcIceTimers.set(slaveIdx, timer);
}

/**
 * Process an incoming DataChannel message on either master or slave.
 *
 * @param {object} msg      - parsed message object { type, ... }
 * @param {number} fromIdx  - playerIndex of the sender
 */
function _handleRtcMessage(msg, fromIdx) {
  if (!msg || !msg.type) return;

  if (msg.type === 'transfer') {
    // Slave: master requests our word – read SIOMLT_SEND and respond immediately
    if (playerIndex !== 0) {
      const word = readSlaveWord();
      const channel = _rtcSlaveChannels.get(fromIdx);
      if (channel && channel.readyState === 'open') {
        channel.send(JSON.stringify({
          type: 'word',
          word,
          playerIndex,
          transferId: msg.transferId,
        }));
      }
    }
  } else if (msg.type === 'word') {
    // Master: a slave has responded with its word
    if (playerIndex === 0 && _rtcPendingResolve && msg.transferId === _rtcPendingId) {
      _rtcPendingWords.set(fromIdx, msg.word & 0xFFFF);
      if (_rtcPendingWords.size >= _rtcPendingCount + 1) { // +1 for master's own word
        _dispatchRtcTransfer();
      }
    }
  } else if (msg.type === 'sync') {
    // Slave: master has collected all words – inject them into the emulator
    if (playerIndex !== 0 && typeof window._luaInjectSync === 'function') {
      window._luaInjectSync(msg.words);
    }
  }
}

/**
 * Master-only: broadcast the collected sync packet to all slaves and resolve
 * the pending transfer promise so the emulator can continue.
 */
function _dispatchRtcTransfer() {
  if (!_rtcPendingResolve) return;

  const words = [
    (_rtcPendingWords.get('master') ?? 0xFFFF) & 0xFFFF,
    (_rtcPendingWords.get(1) ?? 0xFFFF) & 0xFFFF,
    (_rtcPendingWords.get(2) ?? 0xFFFF) & 0xFFFF,
    (_rtcPendingWords.get(3) ?? 0xFFFF) & 0xFFFF,
  ];

  const resolve = _rtcPendingResolve;
  _rtcPendingResolve = null;
  _rtcPendingWords.clear();

  // Send the completed packet to all slaves so they can inject it
  const syncMsg = JSON.stringify({ type: 'sync', words, transferId: _rtcPendingId });
  for (const [, dc] of _rtcChannels) {
    if (dc.readyState === 'open') dc.send(syncMsg);
  }

  resolve(words);
}

/** Close all WebRTC peer connections and reset P2P state. */
function closeWebRtcLink() {
  for (const timer of _rtcIceTimers.values()) clearTimeout(timer);
  _rtcIceTimers.clear();
  for (const pc of _rtcPeers.values()) {
    try { pc.close(); } catch (e) { /* ignore */ }
  }
  _rtcPeers.clear();
  _rtcChannels.clear();
  _rtcSlaveChannels.clear();
  _rtcFallback = false;
  _rtcPendingWords.clear();
  if (_rtcPendingResolve) { _rtcPendingResolve([0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF]); }
  _rtcPendingResolve = null;
  _rtcPendingId = -1;
  _rtcPendingCount = 0;
}

/**
 * Master-only: send our word via WebRTC DataChannel (P2P, low latency).
 * Falls back to Socket.IO relay (requestTransfer) if WebRTC is unavailable.
 *
 * @param {number} sendWord - master's SIOMLT_SEND value
 * @returns {Promise<number[]>} 4-element array [P0,P1,P2,P3]
 */
function requestTransferWebRtc(sendWord) {
  // ── Prefer PeerJS P2P link cable (peerLinkCable.js) when connected ────
  // PeerJS provides a direct WebRTC DataChannel path with no server relay.
  // Both the lock-step exchange and Pokémon handshake stabilisation are
  // handled inside PeerLinkCableImpl.exchangeWord().
  if (window.PeerLinkCable?.connected) {
    return window.PeerLinkCable.exchangeWord(sendWord, currentTransferId);
  }

  // Collect currently open DataChannels to slaves
  const openChannels = [..._rtcChannels.entries()]
    .filter(([, dc]) => dc && dc.readyState === 'open');

  if (_rtcFallback || openChannels.length === 0) {
    // No open WebRTC channels – use Socket.IO relay
    return requestTransfer(sendWord);
  }

  return new Promise((resolve) => {
    _rtcPendingResolve = resolve;
    _rtcPendingId = currentTransferId;
    _rtcPendingCount = openChannels.length; // number of slaves to wait for
    _rtcPendingWords.clear();
    _rtcPendingWords.set('master', sendWord & 0xFFFF);

    // Notify all slaves to send their words
    const msg = JSON.stringify({
      type: 'transfer',
      masterWord: sendWord & 0xFFFF,
      transferId: currentTransferId,
    });
    for (const [, dc] of openChannels) dc.send(msg);

    // Safety timeout – if slaves don't respond in time, use Socket.IO relay
    setTimeout(() => {
      if (_rtcPendingResolve) {
        console.warn('[WebRTC] Transfer timeout – using Socket.IO relay for this transfer');
        _rtcPendingResolve = null;
        _rtcPendingWords.clear();
        requestTransfer(sendWord).then(resolve);
      }
    }, RTC_TRANSFER_TIMEOUT);
  });
}

// ─── WASM Module access ──────────────────────────────────────────────────
// EmulatorJS may expose the Emscripten WASM Module at different paths
// depending on version and initialisation order.  This helper tries
// multiple known locations and caches the result.
//
// The mGBA Emscripten build (core-mgba 4.x) only exports HEAPU8 on
// the Module object; HEAPU16 is a local variable inside the runtime
// closure and is NOT accessible via Module.HEAPU16.  When only HEAPU8
// is present we derive a Uint16Array view from the same underlying
// ArrayBuffer.  On memory growth Emscripten replaces Module.HEAPU8
// with a new typed array backed by a new buffer, so we detect stale
// views by comparing buffers and recreate HEAPU16 when needed.
let _cachedWasmModule = null;

function _ensureHeap16(mod) {
  if (!mod?.HEAPU8) return false;
  if (!mod.HEAPU16 || mod.HEAPU16.buffer !== mod.HEAPU8.buffer) {
    mod.HEAPU16 = new Uint16Array(mod.HEAPU8.buffer);
  }
  return true;
}

function getWasmModule() {
  if (_cachedWasmModule) {
    // Ensure HEAPU16 is present and fresh (handles both native exports
    // and the HEAPU8-derived fallback with memory growth detection)
    if (_ensureHeap16(_cachedWasmModule) || _cachedWasmModule.HEAPU16) {
      return _cachedWasmModule;
    }
    // Cached module is no longer usable – fall through to re-discover
    _cachedWasmModule = null;
  }

  const ejs = window.EJS_emulator;
  if (!ejs) return null;

  // Primary path: EmulatorJS 4.x standard
  const paths = [
    ejs.gameManager?.Module,
    ejs.Module,
    ejs.game?.Module,
  ];
  for (const mod of paths) {
    if (!mod) continue;
    if (mod.HEAPU16) {
      _cachedWasmModule = mod;
      return mod;
    }
    // Fallback: derive HEAPU16 from HEAPU8's underlying ArrayBuffer
    if (_ensureHeap16(mod)) {
      _cachedWasmModule = mod;
      return mod;
    }
  }
  return null;
}

/**
 * Link Cable Polling
 *
 * Every frame we check if the GBA game has initiated a serial transfer.
 * We intercept by monitoring the SIOCNT register via the Emscripten HEAPU16
 * exposed by EmulatorJS's internal mGBA core Module.
 *
 * GBA I/O register layout (relative to IO base in Emscripten heap):
 *   0x128 SIOCNT  – bit 7 = START, bits 0-1 = baud, bit 12-13 = player#
 *   0x12A SIODATA8/SIOMLT_SEND – data to send
 *   0x120 SIOMULTI0, 0x122 SIOMULTI1, 0x124 SIOMULTI2, 0x126 SIOMULTI3
 *
 * Finding IO base:
 *   Strategy 1 – use retro_get_memory_data to narrow the search range.
 *   Strategy 2 – pattern-match the heap for SIOMULTI register defaults
 *     (4×0xFFFF / 4×0x0000) with neighbouring GBA I/O validation.
 *   Strategy 3 – anchor on SOUNDBIAS = 0x0200 at IO+0x088.
 *   Strategy 4 – anchor on DISPCNT at IO+0x000 (valid display mode).
 *   Strategy 5 (async) – write a unique marker value to a harmless GBA
 *     I/O register via the mGBA cheat system (which uses the real memory
 *     bus) and scan the heap for it.  This is the most reliable method
 *     because it uses mGBA's own address decoding.
 *   If all fail, a periodic retry is scheduled so the link cable can
 *   activate once the game's SIO subsystem initialises.
 */
let _lcRetryTimer = null;
let _lcRetryCount = 0;
// Tracks which detection strategy was used (for diagnostics)
let _lcDetectionStrategy = null;
const LC_MAX_RETRIES = 15;
const LC_RETRY_INTERVAL = 2000; // ms

function startLinkCablePolling(myPlayerIdx) {
  _lcRetryCount = 0;
  _lcDetectionStrategy = null;

  // ── Wire PeerLinkCable callbacks (once per session) ───────────────────
  // Register callbacks so that PeerJS exchanges feed into the emulator
  // register injector (_luaInjectSync) and the LC indicator is updated.
  if (window.PeerLinkCable) {
    window.PeerLinkCable.on({
      onSync: (words) => {
        if (typeof window._luaInjectSync === 'function') {
          window._luaInjectSync(words);
        }
      },
      onConnected: () => {
        updateLcIndicator(true);
        showToast('🎴 PeerJS link cable connected! Ready to trade.', 'success');
      },
      onDisconnected: () => {
        updateLcIndicator(lcEnabled);
        showToast('PeerJS link cable disconnected', 'info');
      },
    });
  }

  attemptLinkCableSetup(myPlayerIdx);
}

async function attemptLinkCableSetup(myPlayerIdx) {
  // ── Phase 1: synchronous pattern-based detection ──────────────────────
  const ioBase = findGbaIoBase();

  if (ioBase !== null && validateIoBase(ioBase)) {
    console.log(`[LC] GBA I/O base found at 0x${ioBase.toString(16)} (strategy: ${_lcDetectionStrategy})`);
    if (_lcRetryTimer) { clearInterval(_lcRetryTimer); _lcRetryTimer = null; }
    installRegisterInterceptor(ioBase, myPlayerIdx);
    return;
  }

  if (ioBase !== null) {
    console.warn(`[LC] I/O base candidate 0x${ioBase.toString(16)} failed validation – continuing search`);
  }

  // ── Phase 2: async cheat-marker-based detection ───────────────────────
  // Uses mGBA's cheat system to write a marker value via the real GBA
  // memory bus, then scans the heap for it.  This is the most reliable
  // strategy because it uses the emulator's own address decoding.
  const cheatBase = await findIoBaseViaCheat();
  if (cheatBase !== null && validateIoBase(cheatBase)) {
    _lcDetectionStrategy = 'cheat-marker';
    console.log(`[LC] GBA I/O base found via cheat marker at 0x${cheatBase.toString(16)}`);
    if (_lcRetryTimer) { clearInterval(_lcRetryTimer); _lcRetryTimer = null; }
    installRegisterInterceptor(cheatBase, myPlayerIdx);
    return;
  }

  // ── Phase 3: retry loop ───────────────────────────────────────────────
  _lcRetryCount++;
  const mod = getWasmModule();
  console.log(`[LC] I/O base not found – retry ${_lcRetryCount}/${LC_MAX_RETRIES} (Module ${mod ? 'available' : 'NOT available'})`);

  if (_lcRetryCount <= LC_MAX_RETRIES) {
    if (!_lcRetryTimer) {
      _lcRetryTimer = setInterval(() => {
        if (!lcEnabled) {
          clearInterval(_lcRetryTimer);
          _lcRetryTimer = null;
          return;
        }
        attemptLinkCableSetup(myPlayerIdx);
      }, LC_RETRY_INTERVAL);
    }
  } else {
    if (_lcRetryTimer) { clearInterval(_lcRetryTimer); _lcRetryTimer = null; }
    console.warn('[LC] Could not find GBA I/O base after retries – using fallback protocol');
    installSaveStateProtocol(myPlayerIdx);
  }
}

/**
 * Validate that a detected I/O base actually points to the GBA I/O region.
 * Returns true if the base appears to be correct based on register values.
 */
function validateIoBase(ioBase) {
  const mod = getWasmModule();
  if (!mod?.HEAPU16) return false;

  const heap16 = mod.HEAPU16;

  // KEYINPUT (IO+0x130) is a 10-bit register – upper 6 bits must be 0
  const keyIdx = (ioBase + 0x130) >>> 1;
  if (keyIdx >= heap16.length) return false;
  if ((heap16[keyIdx] & 0xFC00) !== 0) return false;

  // DISPCNT (IO+0x000) – display mode in bits 0-2 (value 0-5); bit 3 is
  // reserved; top byte should have valid flags.  The whole word should be
  // less than 0xFFFF (uninitialised memory).
  const dispcntIdx = (ioBase + 0x000) >>> 1;
  if (dispcntIdx >= heap16.length) return false;
  const dispcnt = heap16[dispcntIdx];
  if (dispcnt === 0xFFFF) return false; // likely uninitialised
  if ((dispcnt & 7) > 5) return false;  // display mode 6-7 are invalid

  return true;
}

/**
 * Search the Emscripten heap for the GBA I/O region using pattern matching.
 * Uses multiple strategies and validation heuristics.
 *
 * Returns the heap byte offset of GBA IO (0x04000000 space), or null.
 */
function findGbaIoBase() {
  const mod = getWasmModule();
  if (!mod?.HEAPU16) {
    console.warn('[LC] WASM Module not available – cannot search for I/O base');
    return null;
  }

  // Strategy 1: Use libretro memory API to narrow the search
  let searchStart = 0;
  let searchEnd = null;
  try {
    if (typeof mod.cwrap === 'function') {
      const getMemData = mod.cwrap('retro_get_memory_data', 'number', ['number']);
      const getMemSize = mod.cwrap('retro_get_memory_size', 'number', ['number']);
      // RETRO_MEMORY_SYSTEM_RAM = 2
      const sysRamPtr = getMemData(2);
      const sysRamSize = getMemSize(2);
      if (sysRamPtr > 0 && sysRamSize > 0) {
        // GBA system RAM is 256 KB at 0x02000000. I/O is at 0x04000000.
        // In mGBA, I/O memory is typically allocated near system RAM.
        // Search from 1 MB before sysRamPtr to 8 MB after.
        searchStart = Math.max(0, (sysRamPtr - 1024 * 1024)) >>> 1;
        searchEnd = Math.min(mod.HEAPU16.length, (sysRamPtr + 8 * 1024 * 1024)) >>> 1;
        console.log(`[LC] libretro sysRamPtr=0x${sysRamPtr.toString(16)} size=0x${sysRamSize.toString(16)} → search 0x${(searchStart*2).toString(16)}-0x${(searchEnd*2).toString(16)}`);
      }
    }
  } catch (e) {
    console.warn('[LC] cwrap failed – searching full heap:', e.message);
  }

  const heap16 = mod.HEAPU16;
  const MAX_SEARCH = searchEnd || Math.min(heap16.length, (64 * 1024 * 1024) / 2);
  const START = searchStart || 0;

  const candidates = [];

  // ── Validate a candidate IO base and return a confidence score ──
  function scoreCandidate(candidateBase) {
    let score = 0;

    // SIOCNT at IO+0x128 – upper 2 bits should be 0 in normal/multiplay mode
    const siocntIdx = (candidateBase + 0x128) >>> 1;
    if (siocntIdx < heap16.length) {
      if ((heap16[siocntIdx] & 0xC000) === 0) score += 1;
    }

    // KEYINPUT at IO+0x130 – 10-bit register, upper 6 bits should be 0
    const keyIdx = (candidateBase + 0x130) >>> 1;
    if (keyIdx < heap16.length) {
      if ((heap16[keyIdx] & 0xFC00) === 0) score += 2;
    }

    // IME at IO+0x208 – should be 0 or 1
    const imeIdx = (candidateBase + 0x208) >>> 1;
    if (imeIdx < heap16.length) {
      if (heap16[imeIdx] <= 1) score += 2;
    }

    // POSTFLG at IO+0x300 – should be 0 or 1
    const postIdx = (candidateBase + 0x300) >>> 1;
    if (postIdx < heap16.length) {
      if (heap16[postIdx] <= 1) score += 1;
    }

    // SOUNDBIAS at IO+0x088 – BIOS sets this to 0x0200
    const biasIdx = (candidateBase + 0x088) >>> 1;
    if (biasIdx < heap16.length) {
      if (heap16[biasIdx] === 0x0200) score += 2;
    }

    // IE at IO+0x200 – upper 2 bits (15-14) should be 0 (only bits 0-13 valid)
    const ieIdx = (candidateBase + 0x200) >>> 1;
    if (ieIdx < heap16.length) {
      if ((heap16[ieIdx] & 0xC000) === 0) score += 1;
    }

    // DISPCNT at IO+0x000 – display mode bits 0-2 should be 0-5
    const dispcntIdx = (candidateBase + 0x000) >>> 1;
    if (dispcntIdx < heap16.length) {
      const dmode = heap16[dispcntIdx] & 7;
      if (dmode <= 5 && heap16[dispcntIdx] !== 0xFFFF) score += 2;
    }

    return score;
  }

  // ── Strategy 2a: Search for 4 consecutive 0xFFFF (SIOMULTI0-3) ──
  // After a completed transfer with no link cable, mGBA writes 0xFFFF.
  for (let i = START; i < MAX_SEARCH - 0x190; i++) {
    if (heap16[i]     !== 0xFFFF ||
        heap16[i + 1] !== 0xFFFF ||
        heap16[i + 2] !== 0xFFFF ||
        heap16[i + 3] !== 0xFFFF) continue;

    const candidateBase = (i * 2) - 0x120;
    if (candidateBase < 0) continue;

    const score = scoreCandidate(candidateBase);
    if (score >= 5) {
      _lcDetectionStrategy = 'SIOMULTI-0xFFFF';
      candidates.push({ base: candidateBase, score: score + 1, idx: i });
    }
  }

  // ── Strategy 2b: Search for 4 consecutive 0x0000 (SIOMULTI0-3) ──
  // Before any SIO transfer, mGBA may initialize registers to zero.
  // A higher score threshold is required because 4×0x0000 is common in
  // uninitialized memory, making false positives more likely than 4×0xFFFF.
  for (let i = START; i < MAX_SEARCH - 0x190; i++) {
    if (heap16[i]     !== 0x0000 ||
        heap16[i + 1] !== 0x0000 ||
        heap16[i + 2] !== 0x0000 ||
        heap16[i + 3] !== 0x0000) continue;

    const candidateBase = (i * 2) - 0x120;
    if (candidateBase < 0) continue;

    const score = scoreCandidate(candidateBase);
    if (score >= 6) {
      _lcDetectionStrategy = 'SIOMULTI-0x0000';
      candidates.push({ base: candidateBase, score, idx: i });
    }
  }

  // ── Strategy 3: Anchor on SOUNDBIAS = 0x0200 at IO+0x088 ──
  // The BIOS always initializes SOUNDBIAS to 0x0200, making this a
  // reliable anchor.
  for (let i = START; i < MAX_SEARCH - 0x190; i++) {
    if (heap16[i] !== 0x0200) continue;

    const candidateBase = (i * 2) - 0x088;
    if (candidateBase < 0) continue;

    const score = scoreCandidate(candidateBase);
    if (score >= 7) {
      _lcDetectionStrategy = 'SOUNDBIAS';
      candidates.push({ base: candidateBase, score, idx: i });
    }
  }

  // ── Strategy 4: Anchor on DISPCNT at IO+0x000 ──
  // DISPCNT is always set by the game; display mode 0-5 in bits 0-2.
  for (let i = START; i < MAX_SEARCH - 0x190; i++) {
    const val = heap16[i];
    // DISPCNT bits 0-2 = mode (0-5); rest are flags; value < 0x2000 typical
    if (val === 0 || val === 0xFFFF || (val & 7) > 5 || val >= 0x2000) continue;

    const candidateBase = (i * 2); // DISPCNT is at IO+0x000
    const score = scoreCandidate(candidateBase);
    if (score >= 7) {
      _lcDetectionStrategy = 'DISPCNT';
      candidates.push({ base: candidateBase, score, idx: i });
    }
  }

  if (candidates.length === 0) {
    console.log(`[LC] Pattern scan: 0 candidates in range 0x${(START*2).toString(16)}-0x${(MAX_SEARCH*2).toString(16)}`);
    return null;
  }

  // Pick the candidate with the highest score
  candidates.sort((a, b) => b.score - a.score);
  console.log(`[LC] Pattern scan: ${candidates.length} candidates, best score=${candidates[0].score} (strategy: ${_lcDetectionStrategy})`);
  return candidates[0].base;
}

/**
 * Strategy 5: Write a unique marker value to a harmless GBA I/O register
 * via the mGBA cheat system, then scan the WASM heap for it.
 *
 * This is the most reliable strategy because the cheat system writes
 * through mGBA's real memory bus, correctly routing to the GBA I/O
 * register backing store regardless of internal memory layout.
 *
 * We use MOSAIC (0x0400004C) as the target – it controls a visual effect
 * that is nearly invisible at low values, making the brief marker write
 * harmless to the user experience.
 */
async function findIoBaseViaCheat() {
  const gm = window.EJS_emulator?.gameManager;
  const mod = getWasmModule();
  if (!gm || !mod?.HEAPU16) return null;
  if (typeof gm.setCheat !== 'function' || typeof gm.resetCheat !== 'function') return null;

  // A distinctive 16-bit value unlikely to appear in normal memory.
  const MARKER = 0xFACE;
  // MOSAIC register at GBA address 0x0400004C, I/O offset 0x04C
  const MARKER_IO_OFFSET = 0x04C;

  // Cheat code formats to try (mGBA accepts multiple formats):
  // CodeBreaker 16-bit write: 8AAAAAAA VVVV
  // GameShark v1 16-bit write: 1AAAAAAA 0000VVVV
  const CHEAT_FORMATS = [
    `8400004C ${MARKER.toString(16).toUpperCase()}`,
    `1400004C 0000${MARKER.toString(16).toUpperCase()}`,
  ];

  for (const cheatCode of CHEAT_FORMATS) {
    try {
      gm.resetCheat();
      gm.setCheat(0, 1, cheatCode);

      // Wait two frames for the cheat to be applied
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      // Scan the heap for the marker
      const heap16 = mod.HEAPU16;
      const len = Math.min(heap16.length, (64 * 1024 * 1024) / 2);
      const found = [];
      for (let i = 0; i < len; i++) {
        if (heap16[i] === MARKER) {
          const candidateBase = (i * 2) - MARKER_IO_OFFSET;
          if (candidateBase >= 0) {
            found.push({ base: candidateBase, idx: i });
          }
        }
      }

      // Clean up: disable cheat, reset MOSAIC to 0, then clear all cheats
      gm.setCheat(0, 0, cheatCode);
      gm.resetCheat();
      // Write 0 back to MOSAIC to undo the marker
      const zeroCode = cheatCode.replace(MARKER.toString(16).toUpperCase(), '0000');
      gm.setCheat(0, 1, zeroCode);
      await new Promise(r => requestAnimationFrame(r));
      gm.setCheat(0, 0, zeroCode);
      gm.resetCheat();

      if (found.length > 0) {
        console.log(`[LC] Cheat marker found at ${found.length} location(s) using format "${cheatCode}"`);
        // Validate candidates
        for (const c of found) {
          if (validateIoBase(c.base)) {
            return c.base;
          }
        }
        // All candidates failed validation – do not return an unverified base
        console.warn(`[LC] Cheat marker found but all ${found.length} candidates failed validation`);
      }
    } catch (e) {
      console.warn(`[LC] Cheat-marker detection failed for format "${cheatCode}":`, e.message);
    }
  }

  // Clean up in case of partial failure
  try { gm.resetCheat(); } catch (_) {}
  return null;
}

/**
 * Poll GBA I/O registers each frame via requestAnimationFrame and a
 * supplementary high-frequency setInterval timer.
 *
 * Because mGBA's internal SIO processing completes transfers within a
 * single emulation step (the START bit is set and cleared before our JS
 * runs), we cannot rely solely on catching a START bit edge.  Instead we
 * use a multi-pronged approach:
 *
 *   1. **Inject connected state** – every frame we write multiplay mode,
 *      the correct player ID, and the "link ready" (SD) bit into SIOCNT
 *      so the game sees a connected link cable.  We preserve game-written
 *      bits (baud rate, IRQ enable) when injecting.
 *
 *   2. **Track SIOMLT_SEND changes** – when the game writes a new word
 *      to SIOMLT_SEND we relay it through the server and inject the
 *      response into SIOMULTI0-3.  We also watch for the START bit edge
 *      as an additional trigger.
 *
 *   3. **Cached SIOMULTI re-injection** – we maintain a cache of the
 *      latest sync data from all players and continuously re-inject it
 *      into SIOMULTI0-3 every frame.  This ensures that even when mGBA's
 *      internal SIO handler overwrites with disconnected values (0xFFFF),
 *      the game can read valid multiplayer data on the next register poll.
 *
 *   4. **SIO IRQ triggering** – after injecting sync data we set the
 *      Serial Communication bit (bit 7) in the IF register (IO+0x202)
 *      and ensure the IE register (IO+0x200) has SIO enabled.  This
 *      causes games that use IRQ-driven SIO to re-read SIOMULTI0-3 and
 *      process our injected values.
 *
 *   5. **High-frequency polling** – a setInterval timer at 8 ms augments
 *      requestAnimationFrame, giving us ~125 Hz register maintenance.
 */
let _lcPollingRAF = null;
let _lcPollingInterval = null;

/**
 * Detect the current SIO mode from RCNT and SIOCNT register values.
 * Both mGBA and VBA-M use this same logic to determine the active mode.
 *
 * RCNT bit 15 = 1 → GPIO/JOY BUS mode (not SIO – link cable inactive)
 * RCNT bit 15 = 0 → SIO mode, further determined by SIOCNT bits 12-13:
 *   00 = Normal 8-bit, 01 = Normal 32-bit, 10 = Multiplay, 11 = UART
 */
function detectSioMode(rcnt, siocnt) {
  // When RCNT bit 15 is set the hardware is in GPIO/JOY BUS mode (not SIO).
  // Link cable is irrelevant in this state; default to Multiplay so the
  // interceptor continues to present a connected-cable state to the game
  // without interfering.  When the game switches back to SIO mode (bit 15
  // cleared) we will detect the actual mode from SIOCNT.
  if (rcnt & 0x8000) return SIO_MODE_MULTI;
  const modeBits = (siocnt >> 12) & 0x03;
  if (modeBits === 0) return SIO_MODE_NORMAL8;
  if (modeBits === 1) return SIO_MODE_NORMAL32;
  return SIO_MODE_MULTI; // 2=Multi, 3=UART→treat as Multi
}

function installRegisterInterceptor(ioBase, myPlayerIdx) {
  // ── PeerJS debug logger ─────────────────────────────────────────────────
  // If peerLinkCable.js is loaded and debug logging is enabled, install the
  // SIO register logger now.  This works even without an active peer
  // connection, making it useful as a standalone diagnostic tool.
  if (window.PeerLinkCable?._debugEnabled) {
    window.PeerLinkCable.installDebugLogger(ioBase, getWasmModule());
  }

  // ── Initialise the mGBA bridge (mgbaBridge.js) ──────────────────────────
  const _wasmMod = getWasmModule();
  if (window.MgbaBridge && _wasmMod) {
    window.MgbaBridge.init(_wasmMod, ioBase);
    if (window.PeerLinkCable) {
      window.MgbaBridge.connectPeer(window.PeerLinkCable);
    }
  }

  let lastSiocnt = 0;
  let lastSendWord = -1;  // track SIOMLT_SEND changes
  let lastRcnt = 0;
  let transferInProgress = false;
  let cachedMulti = [0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF];
  let detectedSioMode = SIO_MODE_MULTI;

  // SIOCNT base bits for multiplay connected state
  const siTerminal = myPlayerIdx === 0 ? 0 : (1 << 2);
  const connectedSiocntBase = siTerminal
                        | (1 << 3)                       // SD = ready
                        | ((myPlayerIdx & 3) << 4)       // player ID
                        | (1 << 13);                     // multiplay mode

  // Normal mode SIOCNT base: clock direction
  const normalSiocntBase = myPlayerIdx === 0 ? (1 << 0) : 0;

  const GAME_SIOCNT_MASK = 0x4003;

  // Pre-compute register indices (byte offset → HEAPU16 index)
  const siocntIdx  = (ioBase + 0x128) >>> 1;
  const sendIdx    = (ioBase + 0x12A) >>> 1;
  const multi0Idx  = (ioBase + 0x120) >>> 1;
  const rcntIdx    = (ioBase + 0x134) >>> 1;
  const siodata32LIdx = (ioBase + 0x120) >>> 1; // SIODATA32 low word (same as SIOMULTI0)
  const siodata32HIdx = (ioBase + 0x122) >>> 1; // SIODATA32 high word
  const ifIdx      = (ioBase + 0x202) >>> 1;  // IF – Interrupt Request Flags
  const ieIdx      = (ioBase + 0x200) >>> 1;  // IE – Interrupt Enable

  // Maximum HEAPU16 index we need to access (POSTFLG at IO+0x300 is the
  // furthest register we touch).  Pre-compute once and check in hot path.
  const maxRequiredIdx = (ioBase + 0x302) >>> 1;

  function buildConnectedSiocnt(currentSiocnt) {
    if (detectedSioMode === SIO_MODE_NORMAL8 || detectedSioMode === SIO_MODE_NORMAL32) {
      // Normal mode: force clock direction from normalSiocntBase (bit 0),
      // clear START (bit 7) to indicate transfer complete, preserve all
      // other game-written bits (baud, IRQ enable, transfer length, etc.).
      // Mask 0xFF7E: bits 1-6, 8-15 preserved; bit 0 from normalSiocntBase;
      // bit 7 (START) cleared.
      return normalSiocntBase | (currentSiocnt & 0xFF7E);
    }
    // Multiplay mode: merge our connected-state bits with the game's baud rate
    // and IRQ enable.  Explicitly clear the error bit (bit 6) and START bit
    // (bit 7) so the game sees a clean, completed-transfer state.
    return (connectedSiocntBase | (currentSiocnt & GAME_SIOCNT_MASK)) & ~0x00C0;
  }

  function injectSioIrq(heap16) {
    // Set Serial Communication IRQ flag (bit 7) in IF register so the
    // game's IRQ handler fires and re-reads SIOMULTI0-3.
    if (ifIdx < heap16.length) {
      heap16[ifIdx] |= (1 << 7);
    }
    // Ensure IE has Serial Communication IRQ enabled (bit 7)
    if (ieIdx < heap16.length) {
      heap16[ieIdx] |= (1 << 7);
    }
  }

  /** Safely write the 4 SIOMULTI words into the WASM heap with bounds check. */
  function injectMultiWords(heap16, words) {
    if (multi0Idx + 3 >= heap16.length) return;
    heap16[multi0Idx]     = words[0] & 0xFFFF;
    heap16[multi0Idx + 1] = words[1] & 0xFFFF;
    heap16[multi0Idx + 2] = words[2] & 0xFFFF;
    heap16[multi0Idx + 3] = words[3] & 0xFFFF;
  }

  function pollRegisters() {
    if (!lcEnabled) {
      _lcPollingRAF = null;
      return;
    }
    _lcPollingRAF = requestAnimationFrame(pollRegisters);

    runPollCycle();
  }

  function runPollCycle() {
    const mod = getWasmModule();
    if (!mod?.HEAPU16) return;

    const heap16 = mod.HEAPU16;

    // Bounds check: ensure all register indices are within the heap.
    if (maxRequiredIdx >= heap16.length) return;

    const siocnt = heap16[siocntIdx];
    const sendWord = heap16[sendIdx];
    const rcnt = rcntIdx < heap16.length ? heap16[rcntIdx] : 0;

    // ── SIO mode detection (common to mGBA & VBA-M) ──
    const newMode = detectSioMode(rcnt, siocnt);
    if (newMode !== detectedSioMode) {
      detectedSioMode = newMode;
      currentSioMode = newMode;
      if (lcSocket?.connected) {
        lcSocket.emit('lua:setMode', { mode: newMode });
      }
    }

    // ── Detect mGBA's internal SIO completion ────────────────────────────
    // mGBA completes SIO internally (writing 0xFFFF) then clears START.
    // We detect the falling edge of START + error bit and re-inject our
    // cached data.  This "post-transfer re-injection" is the key insight
    // from mGBA (lockstep.c) and VBA-M (gbaLink.cpp).
    const startFell = (lastSiocnt & 0x0080) && !(siocnt & 0x0080);
    const errorBitSet = !!(siocnt & 0x0040); // bit 6 = error

    if (startFell && errorBitSet && !transferInProgress) {
      // mGBA just completed an internal SIO transfer with error (no cable).
      // Re-inject our cached multiplayer data and fire IRQ so the game
      // processes our data instead of the 0xFFFF disconnect values.
      injectMultiWords(heap16, cachedMulti);
      heap16[siocntIdx] = buildConnectedSiocnt(siocnt);
      injectSioIrq(heap16);
    }

    // ── Master (P0): detect transfer and drive the Lua cycle ─────────────
    // ── Slave (P1-P3): just maintain connected state; the lua:masterReady
    //    event (handled in connectSockets) triggers their response.
    if (myPlayerIdx === 0) {
      const startEdge = (siocnt & 0x0080) && !(lastSiocnt & 0x0080);
      const sendChanged = lastSendWord >= 0 && sendWord !== lastSendWord;

      if ((startEdge || sendChanged) && !transferInProgress) {
        transferInProgress = true;

        // Master initiates the transfer cycle; prefer WebRTC P2P over Socket.IO relay
        requestTransferWebRtc(sendWord).then((words) => {
          cachedMulti = words;

          // Re-read the module in case memory grew during the async operation
          const curMod = getWasmModule();
          if (!curMod?.HEAPU16) { transferInProgress = false; return; }
          const curHeap = curMod.HEAPU16;

          if (maxRequiredIdx >= curHeap.length) { transferInProgress = false; return; }

          // Write received SIOMULTI values back
          injectMultiWords(curHeap, words);

          // Clear START bit and inject connected state preserving game bits
          curHeap[siocntIdx] = buildConnectedSiocnt(curHeap[siocntIdx]);

          // Trigger SIO IRQ so the game processes the new data
          injectSioIrq(curHeap);

          transferInProgress = false;
        });
      } else if (!transferInProgress) {
        injectMultiWords(heap16, cachedMulti);

        if (!(siocnt & 0x0080)) {
          heap16[siocntIdx] = buildConnectedSiocnt(siocnt);
        }
      }
    } else {
      // ── Slave: continuously re-inject cached SIOMULTI data ──────────────
      // The lua:masterReady handler (in connectSockets) reads sendWord and
      // sends lua:send; once lua:sync arrives, cachedMulti is updated.
      // Here we just keep the connected state and re-inject cached data.
      injectMultiWords(heap16, cachedMulti);

      if (!(siocnt & 0x0080)) {
        heap16[siocntIdx] = buildConnectedSiocnt(siocnt);
      }
    }

    // Ensure RCNT stays in SIO mode (bit 15 = 0) while preserving other
    // game-configured bits (SI/SO terminal state, baud rate control, etc.).
    // Only clear bit 15 (GPIO mode select); don't overwrite the full register.
    if (rcntIdx < heap16.length && (rcnt & 0x8000)) {
      heap16[rcntIdx] = rcnt & 0x7FFF;
    }

    lastSiocnt = siocnt;
    lastSendWord = sendWord;
    lastRcnt = rcnt;
  }

  // Expose current SIOMLT_SEND value so lua:masterReady handler can read it
  // without needing its own ioBase reference.
  window._luaGetSlaveWord = () => {
    const mod = getWasmModule();
    if (!mod?.HEAPU16) return 0xFFFF;
    if (sendIdx >= mod.HEAPU16.length) return 0xFFFF;
    return mod.HEAPU16[sendIdx] & 0xFFFF;
  };

  // lua:sync updates cachedMulti and injects data immediately.
  // For slaves, this is the primary mechanism by which received multiplayer
  // data enters the emulator.  We write SIOMULTI0-3, clear error/START in
  // SIOCNT, and fire the SIO IRQ – exactly replicating what a real link
  // cable transfer completion looks like to the game.
  window._luaInjectSync = (words) => {
    cachedMulti = words;
    const mod = getWasmModule();
    if (!mod?.HEAPU16) return;
    const heap16 = mod.HEAPU16;
    if (maxRequiredIdx >= heap16.length) return;
    injectMultiWords(heap16, words);
    heap16[siocntIdx] = buildConnectedSiocnt(heap16[siocntIdx]);
    injectSioIrq(heap16);
  };

  // Initialise SIOMULTI0-3 to 0xFFFF (the "no data yet" default the game
  // expects before the first successful transfer).
  const initMod = getWasmModule();
  if (initMod?.HEAPU16) {
    const heap = initMod.HEAPU16;
    const multi0 = (ioBase + 0x120) >>> 1;
    if (multi0 + 3 < heap.length) {
      heap[multi0] = 0xFFFF; heap[multi0 + 1] = 0xFFFF;
      heap[multi0 + 2] = 0xFFFF; heap[multi0 + 3] = 0xFFFF;
    }
  }

  _lcPollingRAF = requestAnimationFrame(pollRegisters);

  // Supplementary high-frequency polling at ~125 Hz.  requestAnimationFrame
  // only fires at display refresh rate (~60 Hz) which may miss fast SIO
  // register changes.  This timer provides additional injection opportunities
  // while balancing CPU overhead.
  if (_lcPollingInterval) clearInterval(_lcPollingInterval);
  _lcPollingInterval = setInterval(() => {
    if (!lcEnabled) { clearInterval(_lcPollingInterval); _lcPollingInterval = null; return; }
    runPollCycle();
  }, 8);

  showToast('🔗 Link cable registers detected – active!', 'success');
}

/**
 * Fallback when the GBA I/O base cannot be located after the initial burst of
 * retries.  Rather than giving up, schedule a quiet long-interval background
 * scan that also tries the cheat-marker strategy.  When the I/O base is
 * eventually found the full register interceptor is installed automatically.
 */
function installSaveStateProtocol(myPlayerIdx) {
  if (_lcRetryTimer) return; // already have a retry loop running

  console.warn('[LC] GBA I/O base not found after initial retries – running background scan every 5 s');
  showToast('⏳ Link cable searching for I/O registers…', 'info');

  _lcRetryTimer = setInterval(async () => {
    if (!lcEnabled) {
      clearInterval(_lcRetryTimer);
      _lcRetryTimer = null;
      return;
    }

    // Try fast pattern-matching first
    let ioBase = findGbaIoBase();

    // If pattern matching fails, try the cheat-marker strategy
    if (ioBase === null) {
      ioBase = await findIoBaseViaCheat();
      if (ioBase !== null) _lcDetectionStrategy = 'cheat-marker (background)';
    }

    if (ioBase !== null && validateIoBase(ioBase)) {
      clearInterval(_lcRetryTimer);
      _lcRetryTimer = null;
      console.log(`[LC] GBA I/O base found during background scan: 0x${ioBase.toString(16)} (strategy: ${_lcDetectionStrategy})`);
      installRegisterInterceptor(ioBase, myPlayerIdx);
      showToast('🔗 Link cable ready!', 'success');
    }
  }, 5000);
}

/**
 * Read the slave's current SIOMLT_SEND value from the GBA I/O registers.
 * Called by the lua:masterReady handler so the slave can immediately respond
 * with its current data word.  Falls back to 0xFFFF if the emulator is not
 * ready or the register location is unknown.
 */
function readSlaveWord() {
  if (typeof window._luaGetSlaveWord === 'function') {
    return window._luaGetSlaveWord();
  }
  return 0xFFFF;
}

/**
 * Master-only: send our SIOMLT_SEND word via lua:send and await lua:sync.
 * The server will broadcast lua:masterReady to slaves, collect their
 * responses, and return the full 4-word packet in lua:sync.
 *
 * On a stale-transfer error the function automatically retries once with
 * the corrected transferId (mirrors mGBA lockstep and VBA-M link cable
 * behaviour where the coordinator always completes a cycle once started).
 */
function requestTransfer(sendWord, _retryCount) {
  const retryCount = _retryCount || 0;
  return new Promise((resolve) => {
    lcPending = resolve;
    const transferId = currentTransferId;
    lcSocket.emit('lua:send', { word: sendWord, transferId }, (ack) => {
      if (ack?.error === 'stale transfer') {
        // Server's transferId has advanced; sync ours.
        if (ack.currentTransferId !== undefined) {
          currentTransferId = ack.currentTransferId;
        }
        lcPending = null;
        // Retry once with the corrected transferId instead of returning
        // disconnect values.  This avoids the game seeing a spurious 0xFFFF
        // when the only issue is a transferId mismatch.
        if (retryCount < 1) {
          resolve(requestTransfer(sendWord, retryCount + 1));
        } else {
          resolve([0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF]);
        }
      } else if (ack?.error) {
        console.warn('[LC] Send error:', ack.error);
        lcPending = null;
        resolve([0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF]);
      }
    });
    // Safety timeout – 1500 ms for faster recovery
    setTimeout(() => {
      if (lcPending) {
        lcPending = null;
        resolve([0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF]);
      }
    }, 1500);
  });
}

function updateLcIndicator(active, connectedCount) {
  const el  = document.getElementById('lc-indicator');
  const btn = document.getElementById('lc-toggle-btn');
  el.className = `lc-status ${active ? 'active' : 'inactive'}`;
  const countText = connectedCount != null ? ` (${connectedCount} linked)` : '';
  // P0 is always the master – show a static label instead of toggle state
  if (playerIndex === 0) {
    el.querySelector('span').textContent = active ? `Link Cable (Master)${countText}` : 'Link Cable';
  } else {
    el.querySelector('span').textContent = active ? `Link Cable Active${countText}` : 'Link Cable';
    if (btn) btn.textContent = active ? '🔗 Disconnect' : '🔗 Connect';
  }
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
    try { if (emulatorReady) await persistSave(); } catch (e) { console.warn('Save before leave failed:', e); }
    if (window.PokemonPresence) window.PokemonPresence.stopPresence();
    lobbySocket.emit('lobby:leave', {}, () => {
      window.location.href = '/lobby';
    });
    // Safety: navigate even if ack never fires (e.g. socket disconnect)
    setTimeout(() => { window.location.href = '/lobby'; }, 2000);
  });

  // Manual save button – persists a full save-state snapshot to the server,
  // matching the same underlying function used by EmulatorJS's built-in
  // Save State button (both call getState() → /api/savestates).
  document.getElementById('save-btn').addEventListener('click', async () => {
    await persistSaveState();
  });

  // Load button – restores a save-state snapshot from the server and injects
  // it into the emulator, matching the same underlying function used by
  // EmulatorJS's built-in Load State button (both call loadState(buf) from
  // /api/savestates).
  const loadBtn = document.getElementById('load-btn');
  if (loadBtn) {
    loadBtn.addEventListener('click', async () => {
      if (!emulatorReady) return showToast('Start a game first', 'error');
      await loadServerSaveState();
    });
  }

  // Spectator back-to-grid button
  const backBtn = document.getElementById('spectator-back-btn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      selectedPlayer = null;
      applySpectatorView();
    });
  }

  // Note: spectate-btn handler is set dynamically by updateRoleButtons()
  // based on current role (player→spectator or spectator→player)

  // Link cable toggle
  document.getElementById('lc-toggle-btn').addEventListener('click', toggleLinkCable);

  // PeerJS "Connect for Trade" button – opens the P2P trade overlay
  const peerLcBtn = document.getElementById('peer-lc-btn');
  if (peerLcBtn) {
    peerLcBtn.addEventListener('click', () => {
      if (window.PeerLinkCable) {
        window.PeerLinkCable.showOverlay();
      } else {
        showToast('PeerJS module not loaded', 'error');
      }
    });
  }

  // Link cable diagnostics button
  const diagBtn = document.getElementById('lc-diagnostics-btn');
  if (diagBtn) {
    diagBtn.addEventListener('click', async () => {
      const panel = document.getElementById('lc-diagnostics-panel');
      if (panel) {
        // Toggle visibility
        const isHidden = panel.style.display === 'none' || !panel.style.display;
        panel.style.display = isHidden ? 'block' : 'none';
        if (isHidden) await showLinkDiagnostics();
      }
    });
  }

  // Sidebar tab toggle (Chat ↔ Watch)
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

  // ── Volume control ─────────────────────────────────────────────────────────
  const volumeSlider = document.getElementById('volume-slider');
  const muteBtn      = document.getElementById('mute-btn');
  let _volumeMuted = false;
  let _volumeLevel = 1.0;

  if (volumeSlider) {
    volumeSlider.addEventListener('input', () => {
      _volumeLevel = volumeSlider.value / 100;
      // Use EmulatorJS volume API
      const ejs = window.EJS_emulator;
      if (ejs && typeof ejs.setVolume === 'function') {
        ejs.setVolume(_volumeMuted ? 0 : _volumeLevel);
      }
      if (_volumeLevel > 0) _volumeMuted = false;
      updateMuteIcon(muteBtn, _volumeMuted, _volumeLevel);
    });
  }

  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      _volumeMuted = !_volumeMuted;
      const ejs = window.EJS_emulator;
      if (ejs && typeof ejs.setVolume === 'function') {
        ejs.setVolume(_volumeMuted ? 0 : _volumeLevel);
      }
      updateMuteIcon(muteBtn, _volumeMuted, _volumeLevel);
    });
  }

  // ── Drag-to-resize emulator area ──────────────────────────────────────────
  initEmulatorResize();
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function updateMuteIcon(btn, muted, level) {
  if (!btn) return;
  if (muted || level === 0) {
    btn.textContent = '🔇';
  } else if (level < 0.5) {
    btn.textContent = '🔉';
  } else {
    btn.textContent = '🔊';
  }
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

    // Lock the wrapper to explicit sizing so flex doesn't fight the drag
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
    // Clamp to parent bounds so the wrapper cannot overflow the game area
    const parent = wrap.parentElement;
    const maxW = parent ? parent.clientWidth : Infinity;
    const maxH = parent ? parent.clientHeight : Infinity;
    wrap.style.width  = Math.min(maxW, Math.max(240, startW + dx)) + 'px';
    wrap.style.height = Math.min(maxH, Math.max(160, startH + dy)) + 'px';
  }

  function onEnd() {
    wrap.classList.remove('resizing');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onEnd);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onEnd);
  }
}
