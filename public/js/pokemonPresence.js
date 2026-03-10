'use strict';
/**
 * Pokemon GBA Player Presence System – client-side
 *
 * Inspired by TheHunterManX/GBA-PK-multiplayer, whose Lua scripts run inside
 * a desktop mGBA instance, read player position from GBA EWRAM/IWRAM, and
 * share it over TCP sockets so each client can render other players on the
 * overworld.
 *
 * We reproduce the same idea in a web/WASM context:
 *   1. Detect which Pokemon Gen 3 game is loaded by matching the ROM name.
 *   2. Read the player's tile position and current map from the mGBA WASM heap
 *      (Emscripten HEAPU8 / HEAPU16) using the game-specific memory addresses
 *      from the TheHunterManX Lua address tables.
 *   3. Send position updates via Socket.IO to the /presence namespace at ~10 fps.
 *   4. Receive other players' positions and draw a lightweight canvas overlay
 *      on top of the game screen, showing coloured circles with player numbers
 *      so everyone can see where their teammates are.
 *
 * Supported games (addresses from TheHunterManX and Pokemon-GBA decomps):
 *   FireRed  (BPRE) – full x/y/direction/map  (EWRAM)
 *   LeafGreen(BPGE) – full x/y/direction/map  (EWRAM)
 *   Ruby     (AXVE) – map location only        (EWRAM map data; player in IWRAM)
 *   Sapphire (AXPE) – map location only        (EWRAM map data; player in IWRAM)
 *   Emerald  (BPEE) – map location only        (EWRAM map data; player in IWRAM)
 */

// ── Game memory-address database ────────────────────────────────────────────
// Sourced from TheHunterManX/GBA-PK-multiplayer Lua templates and the
// community Pokemon GBA decompilation projects (pokeemerald / pokefirered).
//
// All addresses are absolute GBA bus addresses (0x02xxxxxx = EWRAM,
// 0x03xxxxxx = IWRAM).  We only read from EWRAM here because IWRAM access
// requires a platform-specific libretro memory descriptor that is not yet
// exposed through our existing mGBA WASM helpers.
//
// Within the gPlayerData struct the relevant offsets are:
//   +0x00  x         (u16)  – tile column on the current map
//   +0x02  y         (u16)  – tile row on the current map
//   +0x0C  animation (u8)   – current walk-cycle frame
//   +0x10  direction (u8)   – 1=left 2=right 3=up 4=down
//
// Note: For RS entries, playerDataAddr is null because gPlayerData lives in
// IWRAM (0x03xxxxxx) which we cannot currently read.  The xOffset/yOffset/
// animOffset/dirOffset fields are present for structural consistency but are
// not used when playerDataAddr is null.  Map data (mapBankAddr) is in EWRAM
// for all supported games and is always read.
const GAME_DB = {
  // ── FireRed ──────────────────────────────────────────────────────────────
  BPRE: {
    gameCode: 'BPRE',
    name: 'Pokemon FireRed',
    type: 'FRLG',
    // Player object data (EWRAM) – this is &gObjectEvents[0].currentCoords
    playerDataAddr: 0x2036e48,
    // Map identifiers (EWRAM); mapId is the byte immediately after mapBank
    mapBankAddr: 0x203f3a8,
    // Struct field offsets inside playerDataAddr
    xOffset: 0x00, yOffset: 0x02, animOffset: 0x0C, dirOffset: 0x10,
  },
  // ── LeafGreen ────────────────────────────────────────────────────────────
  BPGE: {
    gameCode: 'BPGE',
    name: 'Pokemon LeafGreen',
    type: 'FRLG',
    playerDataAddr: 0x2036e48,
    mapBankAddr: 0x203f3a8,
    xOffset: 0x00, yOffset: 0x02, animOffset: 0x0C, dirOffset: 0x10,
  },
  // ── Ruby ─────────────────────────────────────────────────────────────────
  AXVE: {
    gameCode: 'AXVE',
    name: 'Pokemon Ruby',
    type: 'RS',
    // gPlayerData is in IWRAM (0x30048b0) so x/y are unavailable via EWRAM;
    // map data is in EWRAM and gives us the current location.
    playerDataAddr: null,
    mapBankAddr: 0x20392fc,
    xOffset: 0x00, yOffset: 0x02, animOffset: 0x0C, dirOffset: 0x10,
  },
  // ── Sapphire ─────────────────────────────────────────────────────────────
  AXPE: {
    gameCode: 'AXPE',
    name: 'Pokemon Sapphire',
    type: 'RS',
    playerDataAddr: null,
    mapBankAddr: 0x20392fc,
    xOffset: 0x00, yOffset: 0x02, animOffset: 0x0C, dirOffset: 0x10,
  },
  // ── Emerald ──────────────────────────────────────────────────────────────
  BPEE: {
    gameCode: 'BPEE',
    name: 'Pokemon Emerald',
    type: 'EMERALD',
    // gPlayerData = &gObjectEvents[0].currentCoords (EWRAM)
    // Sourced from TheHunterManX Lua script: gPlayerData = 0x2037360
    playerDataAddr: 0x2037360,
    // Map bank/ID (EWRAM) – from TheHunterManX Lua script: gMapBank = 0x203bc80
    mapBankAddr: 0x203bc80,
    xOffset: 0x00, yOffset: 0x02, animOffset: 0x0C, dirOffset: 0x10,
  },
  // ── Quetzal (Emerald ROM hack) ───────────────────────────────────────────
  // Uses the same BPEE game code as Emerald but may have different map
  // layouts.  Shares the same EWRAM addresses because the hack is based
  // on the Emerald binary.
  BPEE_Q: {
    gameCode: 'BPEE_Q',
    name: 'Pokemon Quetzal',
    type: 'QUETZAL',
    playerDataAddr: 0x2037360,
    mapBankAddr: 0x203bc80,
    xOffset: 0x00, yOffset: 0x02, animOffset: 0x0C, dirOffset: 0x10,
  },
};

// ── Presence groups ───────────────────────────────────────────────────────────
// Positional data is only meaningful when both players share the same map
// layout.  Games are grouped by their region/version pair:
//
//   FRLG    – FireRed + LeafGreen: exact same Kanto map layout.
//   RS      – Ruby + Sapphire: identical Hoenn map layout.
//   EMERALD – Emerald: expanded Hoenn with Battle Frontier and extra areas.
//   QUETZAL – Pokemon Quetzal (Emerald ROM hack): custom modified maps.
//
// A player's position overlay is shown only for peers whose game belongs to
// the SAME presence group.  Cross-group comparisons (e.g. FireRed vs Ruby)
// are suppressed because the map bank/ID numbers refer to completely
// different locations in each game.
const PRESENCE_GROUP_BY_TYPE = {
  FRLG:    'FRLG',    // FireRed ↔ LeafGreen
  RS:      'RS',      // Ruby ↔ Sapphire
  EMERALD: 'EMERALD', // Emerald (standalone)
  QUETZAL: 'QUETZAL', // Quetzal (standalone)
};

/**
 * Return the presence-group identifier for a given game code, or null if
 * the game is not in GAME_DB or has no defined group.
 *
 * @param {string} gameCode – four-character ROM code (e.g. 'BPRE')
 * @returns {string|null}
 */
function getPresenceGroup(gameCode) {
  const entry = GAME_DB[gameCode];
  if (!entry) return null;
  return PRESENCE_GROUP_BY_TYPE[entry.type] || null;
}

// Map ROM display names → game codes when we cannot read the ROM header directly.
// Order matters: more specific patterns (e.g. Quetzal) must precede more
// general ones (e.g. Emerald) to avoid false matches.
const ROM_NAME_MAP = [
  { pattern: /fire\s*red/i,   code: 'BPRE' },
  { pattern: /leaf\s*green/i, code: 'BPGE' },
  { pattern: /\bruby\b/i,     code: 'AXVE' },
  { pattern: /sapphire/i,     code: 'AXPE' },
  { pattern: /quetzal/i,      code: 'BPEE_Q' },
  { pattern: /emerald/i,      code: 'BPEE' },
];

// GBA screen dimensions and tile size (pixels per 16×16 overworld tile)
const GBA_W       = 240;
const GBA_H       = 160;
const TILE_PX     = 16;   // one overworld movement step = 16 screen pixels

// Player indicator style
const PLAYER_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12'];
const INDICATOR_R   = 7;  // circle radius in overlay pixels

// ── Module state ────────────────────────────────────────────────────────────
let _presenceSocket = null;
let _overlayCanvas  = null;
let _overlayCtx     = null;
let _updateTimer    = null;
let _renderTimer    = null;

// Our own player's current state (set each poll cycle)
let _myState   = null;
// Map from playerIndex → state for every other player in the lobby
let _peers     = {};

// Detected game entry from GAME_DB, or null if unsupported
let _gameEntry = null;

// Presence group for the local player's game (e.g. 'FRLG', 'RS', 'EMERALD').
// Peer updates whose game code resolves to a different group are discarded.
let _myPresenceGroup = null;

// Cached EWRAM base pointer into the Emscripten heap (byte offset)
let _ewramBase = null;

/**
 * Try to find the mGBA WASM Module from EmulatorJS, trying multiple
 * known paths.  Mirrors the getWasmModule() helper in game.js.
 */
function _getWasmModule() {
  const ejs = window.EJS_emulator;
  if (!ejs) return null;
  const candidates = [
    ejs.gameManager?.Module,
    ejs.Module,
    ejs.game?.Module,
  ];
  for (const mod of candidates) {
    if (mod?.HEAPU8) return mod;
  }
  return null;
}

/**
 * Detect the active Pokemon game from the ROM display name set via
 * window.EJS_gameName.  Returns the matching GAME_DB entry, or null.
 */
function detectGame(romName) {
  if (!romName) return null;
  for (const { pattern, code } of ROM_NAME_MAP) {
    if (pattern.test(romName)) return GAME_DB[code] || null;
  }
  return null;
}

/**
 * Resolve the Emscripten heap byte-offset of GBA EWRAM (0x02000000).
 * Uses the libretro retro_get_memory_data(RETRO_MEMORY_SYSTEM_RAM = 2) API
 * exposed through the mGBA WASM Emscripten module.
 * Tries both the direct Emscripten export (_retro_get_memory_data) and
 * the cwrap wrapper so the lookup works regardless of module build flags.
 * Returns true if the base was found, false otherwise.
 */
function resolveEwramBase() {
  if (_ewramBase !== null) return true;
  try {
    const mod = _getWasmModule();
    if (!mod?.HEAPU8) return false;

    let ewramPtr = 0;

    // Prefer the direct Emscripten export (no cwrap overhead).
    if (typeof mod._retro_get_memory_data === 'function') {
      ewramPtr = mod._retro_get_memory_data(2); // RETRO_MEMORY_SYSTEM_RAM = 2
    }

    // Fall back to cwrap if the direct export is not available.
    if (!ewramPtr && typeof mod.cwrap === 'function') {
      const getMemData = mod.cwrap('retro_get_memory_data', 'number', ['number']);
      ewramPtr = getMemData(2);
    }

    if (ewramPtr > 0) {
      _ewramBase = ewramPtr;
      return true;
    }
  } catch (_) {
    // cwrap or the function may not be exported; fail silently
  }
  return false;
}

/**
 * Read a single byte from a GBA EWRAM address.
 * @param {number} addr – absolute GBA bus address (must be 0x02xxxxxx)
 * @returns {number} byte value, or 0 on any error
 */
function readEwramByte(addr) {
  if (_ewramBase === null) return 0;
  const mod = _getWasmModule();
  if (!mod?.HEAPU8) return 0;
  const offset = addr - 0x02000000;
  if (offset < 0 || offset >= 0x40000) return 0;
  const idx = _ewramBase + offset;
  if (idx < 0 || idx >= mod.HEAPU8.length) return 0;
  return mod.HEAPU8[idx];
}

/**
 * Read a 16-bit little-endian word from a GBA EWRAM address.
 * @param {number} addr – absolute GBA bus address (must be 0x02xxxxxx, 2-byte aligned)
 * @returns {number} unsigned 16-bit value, or 0 on any error
 */
function readEwramShort(addr) {
  if (_ewramBase === null) return 0;
  const mod = _getWasmModule();
  if (!mod) return 0;
  // Derive HEAPU16 from HEAPU8 when not natively exported (mGBA core).
  // Cache on the module to avoid creating a new view on every call, and
  // detect memory growth by comparing the underlying buffer.
  if (!mod.HEAPU16 || (mod.HEAPU8 && mod.HEAPU16.buffer !== mod.HEAPU8.buffer)) {
    if (!mod.HEAPU8) return 0;
    mod.HEAPU16 = new Uint16Array(mod.HEAPU8.buffer);
  }
  const offset = addr - 0x02000000;
  if (offset < 0 || offset >= 0x40000 - 1) return 0;
  const idx = (_ewramBase + offset) >>> 1; // HEAPU16 is indexed in 16-bit units
  if (idx < 0 || idx >= mod.HEAPU16.length) return 0;
  return mod.HEAPU16[idx];
}

/**
 * Read the current player's position and map from GBA EWRAM.
 * Returns a state object, or null if data is unavailable.
 */
function readPlayerState(gameEntry) {
  if (!resolveEwramBase()) return null;

  const mapBank = readEwramByte(gameEntry.mapBankAddr);
  const mapId   = readEwramByte(gameEntry.mapBankAddr + 1);

  let x = 0, y = 0, direction = 0, animation = 0;
  if (gameEntry.playerDataAddr !== null) {
    const base = gameEntry.playerDataAddr;
    x         = readEwramShort(base + gameEntry.xOffset);
    y         = readEwramShort(base + gameEntry.yOffset);
    animation = readEwramByte (base + gameEntry.animOffset);
    direction = readEwramByte (base + gameEntry.dirOffset);
  }

  return { mapBank, mapId, x, y, direction, animation };
}

// ── Canvas overlay ────────────────────────────────────────────────────────────

/**
 * Create (or reuse) a transparent canvas overlay positioned over the game canvas.
 */
function ensureOverlayCanvas() {
  if (_overlayCanvas) return true;

  const gameCanvas = document.querySelector('#gba-emulator canvas');
  if (!gameCanvas) return false;

  const canvas = document.createElement('canvas');
  canvas.id = 'presence-overlay';
  canvas.style.cssText = [
    'position:absolute',
    'top:0',
    'left:0',
    'width:100%',
    'height:100%',
    'pointer-events:none',
    'z-index:10',
    'image-rendering:pixelated',
  ].join(';');

  // Insert overlay as a sibling of the game canvas so it sits on top
  const parent = gameCanvas.parentElement || document.getElementById('gba-emulator');
  parent.style.position = 'relative';
  parent.appendChild(canvas);

  _overlayCanvas = canvas;
  _overlayCtx    = canvas.getContext('2d');
  return true;
}

/**
 * Render presence indicators for all known peers onto the overlay canvas.
 * Indicators are coloured circles drawn at the tile-relative position of each
 * peer on the GBA screen (240×160 logical pixels, scaled to the canvas size).
 */
function renderOverlay() {
  if (!_overlayCanvas || !_overlayCtx) return;

  const gameCanvas = document.querySelector('#gba-emulator canvas');
  if (!gameCanvas) return;

  // Sync overlay dimensions to the game canvas (handles window resize / fullscreen)
  const dpr = window.devicePixelRatio || 1;
  const w   = gameCanvas.offsetWidth  || GBA_W;
  const h   = gameCanvas.offsetHeight || GBA_H;

  if (_overlayCanvas.width  !== Math.round(w * dpr) ||
      _overlayCanvas.height !== Math.round(h * dpr)) {
    _overlayCanvas.width  = Math.round(w * dpr);
    _overlayCanvas.height = Math.round(h * dpr);
  }

  const ctx    = _overlayCtx;
  const scaleX = w / GBA_W;
  const scaleY = h / GBA_H;

  ctx.clearRect(0, 0, _overlayCanvas.width, _overlayCanvas.height);
  ctx.save();
  ctx.scale(dpr, dpr);

  const myState = _myState;

  for (const [, peer] of Object.entries(_peers)) {
    const age = Date.now() - peer.timestamp;
    if (age > 5000) continue; // hide stale entries (>5 s old)

    const onSameMap = myState &&
      peer.mapBank === myState.mapBank &&
      peer.mapId   === myState.mapId;

    const color  = PLAYER_COLORS[peer.playerIndex % PLAYER_COLORS.length];
    const label  = `P${peer.playerIndex + 1}`;

    if (onSameMap && myState && myState.x !== 0 && peer.x !== 0) {
      // Calculate screen-space position relative to the current player.
      // In Pokemon Gen 3, the player is approximately centered at (120, 80).
      // Each overworld tile is TILE_PX (16) logical pixels wide/tall.
      const screenX = GBA_W / 2 + (peer.x - myState.x) * TILE_PX;
      const screenY = GBA_H / 2 + (peer.y - myState.y) * TILE_PX;

      // Only draw if the indicator falls within the GBA screen
      const px = screenX * scaleX;
      const py = screenY * scaleY;
      const r  = INDICATOR_R * Math.min(scaleX, scaleY);

      if (screenX >= -TILE_PX && screenX <= GBA_W + TILE_PX &&
          screenY >= -TILE_PX && screenY <= GBA_H + TILE_PX) {
        _drawIndicator(ctx, px, py, r, color, label);
      }
    } else {
      // Different map or no position data: show a small indicator in the
      // top-right corner so the player knows their teammate is somewhere else
      const cornerX = w - 14 - peer.playerIndex * 30;
      const cornerY = 14;
      ctx.globalAlpha = onSameMap ? 1.0 : 0.5;
      _drawIndicator(ctx, cornerX, cornerY, 8, color, label);
      ctx.globalAlpha = 1.0;
    }
  }

  ctx.restore();
}

function _drawIndicator(ctx, x, y, r, color, label) {
  // Shadow
  ctx.shadowColor   = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur    = 3;

  // Filled circle
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  // White border
  ctx.strokeStyle = '#fff';
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  // Label inside circle
  ctx.shadowBlur = 0;
  ctx.font       = `bold ${Math.max(7, r * 0.9)}px sans-serif`;
  ctx.fillStyle  = '#fff';
  ctx.textAlign  = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x, y);
}

// ── Polling ─────────────────────────────────────────────────────────────────

function _pollAndSend() {
  if (!_gameEntry || !_presenceSocket) return;

  const state = readPlayerState(_gameEntry);
  if (!state) return;

  _myState = state;

  _presenceSocket.emit('presence:update', {
    mapBank:   state.mapBank,
    mapId:     state.mapId,
    x:         state.x,
    y:         state.y,
    direction: state.direction,
    animation: state.animation,
    gameCode:  _gameEntry.gameCode || '',
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the presence system for the current game session.
 *
 * @param {string} lobbyId      – the current lobby's ID
 * @param {number} playerIndex  – this player's index (0–3)
 * @param {string} romName      – the ROM display name (used for game detection)
 */
function initPresence(lobbyId, playerIndex, romName) {
  _gameEntry = detectGame(romName);

  if (!_gameEntry) {
    console.log('[Presence] No supported Pokemon game detected – presence overlay disabled');
    return;
  }

  _myPresenceGroup = getPresenceGroup(_gameEntry.gameCode);
  if (!_myPresenceGroup) {
    console.log(`[Presence] No presence group for ${_gameEntry.gameCode} – overlay disabled`);
    return;
  }

  console.log(`[Presence] Detected: ${_gameEntry.name} (${_gameEntry.gameCode}) – group ${_myPresenceGroup}`);

  // Connect to the /presence namespace
  _presenceSocket = io('/presence', { withCredentials: true });

  _presenceSocket.on('connect', () => {
    _presenceSocket.emit('presence:join', { lobbyId }, (res) => {
      if (res?.error) {
        console.warn('[Presence] Join failed:', res.error);
        return;
      }
      console.log('[Presence] Joined lobby presence room');

      // Start polling GBA memory and sending updates (~10 fps)
      if (_updateTimer) clearInterval(_updateTimer);
      _updateTimer = setInterval(_pollAndSend, 100);

      // Start overlay rendering (~30 fps)
      if (_renderTimer) clearInterval(_renderTimer);
      _renderTimer = setInterval(() => {
        ensureOverlayCanvas();
        renderOverlay();
      }, 33);
    });
  });

  // Receive another player's state
  _presenceSocket.on('presence:state', (state) => {
    // Only display positions for players on the same map layout.
    // Positional coordinates are meaningless when comparing games from
    // different version pairs (e.g. FireRed tile (10,5) ≠ Ruby tile (10,5)).
    const peerGroup = getPresenceGroup(state.gameCode);
    if (!peerGroup || peerGroup !== _myPresenceGroup) return;
    _peers[state.playerIndex] = { ...state, timestamp: Date.now() };
  });

  // Player left / disconnected
  _presenceSocket.on('presence:left', ({ playerIndex }) => {
    delete _peers[playerIndex];
  });
}

/**
 * Stop the presence system and clean up resources.
 */
function stopPresence() {
  if (_updateTimer) { clearInterval(_updateTimer); _updateTimer = null; }
  if (_renderTimer) { clearInterval(_renderTimer); _renderTimer = null; }

  if (_presenceSocket) {
    _presenceSocket.emit('presence:leave', {}, () => {});
    _presenceSocket.disconnect();
    _presenceSocket = null;
  }

  if (_overlayCanvas) {
    _overlayCanvas.remove();
    _overlayCanvas = null;
    _overlayCtx    = null;
  }

  _myState         = null;
  _peers           = {};
  _gameEntry       = null;
  _myPresenceGroup = null;
  _ewramBase       = null;
}

// Export for use in game.js (browser globals)
window.PokemonPresence = { initPresence, stopPresence, detectGame, getPresenceGroup, GAME_DB, PRESENCE_GROUP_BY_TYPE };
