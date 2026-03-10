'use strict';
/**
 * test/peerLinkCable.test.js
 *
 * Tests for public/js/peerLinkCable.js
 *
 * These tests run in Node.js (no browser) and therefore use a mock for
 * window / PeerJS.  They validate the module's structure, exported API,
 * Pokémon handshake detection logic, lock-step exchange behaviour, and the
 * SIO debug-logger scaffolding without requiring an actual WebRTC peer.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const peerLcSrc = fs.readFileSync(
  path.join(__dirname, '../public/js/peerLinkCable.js'),
  'utf8'
);

// ─── Verify the source file exists and exports PeerLinkCable ──────────────
describe('peerLinkCable.js – source file', () => {
  it('file exists', () => {
    assert.ok(
      fs.existsSync(path.join(__dirname, '../public/js/peerLinkCable.js')),
      'peerLinkCable.js must exist in public/js/'
    );
  });

  it('assigns window.PeerLinkCable', () => {
    assert.ok(
      peerLcSrc.includes('window.PeerLinkCable'),
      'peerLinkCable.js must assign the singleton to window.PeerLinkCable'
    );
  });

  it('defines PeerLinkCableImpl class', () => {
    assert.ok(
      peerLcSrc.includes('class PeerLinkCableImpl'),
      'peerLinkCable.js must define PeerLinkCableImpl'
    );
  });
});

// ─── GBA SIO register offsets ─────────────────────────────────────────────
describe('peerLinkCable.js – GBA SIO register offsets', () => {
  it('defines SIOCNT offset 0x128', () => {
    assert.ok(
      peerLcSrc.includes('SIOCNT') && peerLcSrc.includes('0x128'),
      'peerLinkCable.js must define SIOCNT at IO offset 0x128'
    );
  });

  it('defines SIODATA8 offset 0x12A', () => {
    assert.ok(
      peerLcSrc.includes('SIODATA8') && peerLcSrc.includes('0x12A'),
      'peerLinkCable.js must define SIODATA8 at IO offset 0x12A'
    );
  });

  it('defines SIOMULTI0 offset 0x120', () => {
    assert.ok(
      peerLcSrc.includes('SIOMULTI0') && peerLcSrc.includes('0x120'),
      'peerLinkCable.js must define SIOMULTI0 at IO offset 0x120'
    );
  });
});

// ─── Core public API ──────────────────────────────────────────────────────
describe('peerLinkCable.js – public API', () => {
  it('defines createRoom()', () => {
    assert.ok(
      peerLcSrc.includes('createRoom()'),
      'peerLinkCable.js must have a createRoom() method'
    );
  });

  it('defines joinRoom()', () => {
    assert.ok(
      peerLcSrc.includes('joinRoom('),
      'peerLinkCable.js must have a joinRoom() method'
    );
  });

  it('defines exchangeWord()', () => {
    assert.ok(
      peerLcSrc.includes('exchangeWord('),
      'peerLinkCable.js must have an exchangeWord() method for lock-step transfer'
    );
  });

  it('defines installDebugLogger()', () => {
    assert.ok(
      peerLcSrc.includes('installDebugLogger('),
      'peerLinkCable.js must have an installDebugLogger() method'
    );
  });

  it('defines setDebugLogging()', () => {
    assert.ok(
      peerLcSrc.includes('setDebugLogging('),
      'peerLinkCable.js must have a setDebugLogging() method'
    );
  });

  it('defines showOverlay()', () => {
    assert.ok(
      peerLcSrc.includes('showOverlay()'),
      'peerLinkCable.js must have a showOverlay() method'
    );
  });

  it('defines hideOverlay()', () => {
    assert.ok(
      peerLcSrc.includes('hideOverlay()'),
      'peerLinkCable.js must have a hideOverlay() method'
    );
  });

  it('defines destroy()', () => {
    assert.ok(
      peerLcSrc.includes('destroy()'),
      'peerLinkCable.js must have a destroy() method'
    );
  });

  it('defines on() for event callbacks', () => {
    assert.ok(
      peerLcSrc.includes('on(handlers)') || peerLcSrc.includes('on (handlers)'),
      'peerLinkCable.js must have an on(handlers) method for event registration'
    );
  });
});

// ─── Trade Room / PeerJS integration ─────────────────────────────────────
describe('peerLinkCable.js – Trade Room (PeerJS)', () => {
  it('uses window.Peer (PeerJS constructor)', () => {
    assert.ok(
      peerLcSrc.includes('window.Peer') || peerLcSrc.includes('new Peer('),
      'peerLinkCable.js must use the PeerJS Peer constructor'
    );
  });

  it('createRoom() resolves with a room ID via PeerJS open event', () => {
    assert.ok(
      peerLcSrc.includes("'open'") && peerLcSrc.includes('createRoom'),
      "createRoom() must listen to PeerJS 'open' event to obtain the room ID"
    );
  });

  it('joinRoom() connects to the given room ID', () => {
    assert.ok(
      peerLcSrc.includes('joinRoom('),
      'peerLinkCable.js must define joinRoom()'
    );
    // The peer.connect() call may appear inside nested callbacks, so search the full source.
    assert.ok(
      peerLcSrc.includes('peer.connect(') || peerLcSrc.includes('_peer.connect('),
      'joinRoom() must call peer.connect() with the room ID'
    );
  });

  it('host receives inbound connection via peer "connection" event', () => {
    assert.ok(
      peerLcSrc.includes("'connection'"),
      "createRoom() must listen for PeerJS 'connection' event to accept incoming peers"
    );
  });
});

// ─── Lock-step exchange ────────────────────────────────────────────────────
describe('peerLinkCable.js – lock-step word exchange', () => {
  it('exchangeWord() returns a Promise', () => {
    assert.ok(
      peerLcSrc.includes('exchangeWord('),
      'peerLinkCable.js must define exchangeWord()'
    );
    assert.ok(
      peerLcSrc.includes('new Promise('),
      'exchangeWord() must return a Promise'
    );
  });

  it('resolves with [0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF] when not connected', () => {
    assert.ok(
      peerLcSrc.includes('0xFFFF') && peerLcSrc.includes('_connected'),
      'exchangeWord() must resolve with [0xFFFF…] when the DataChannel is closed'
    );
  });

  it('has a transfer timeout with safety fallback', () => {
    assert.ok(
      peerLcSrc.includes('setTimeout') && peerLcSrc.includes('_pendingTimeout'),
      'exchangeWord() must have a safety timeout (_pendingTimeout) to avoid hanging'
    );
  });

  it('sends a word message over the DataChannel', () => {
    assert.ok(
      peerLcSrc.includes("type: 'word'"),
      "exchangeWord() must send { type: 'word', … } over the DataChannel"
    );
  });
});

// ─── Pokémon handshake detection ─────────────────────────────────────────
describe('peerLinkCable.js – Pokémon handshake detection', () => {
  it('defines HANDSHAKE_THRESHOLD constant', () => {
    assert.ok(
      peerLcSrc.includes('HANDSHAKE_THRESHOLD'),
      'peerLinkCable.js must define HANDSHAKE_THRESHOLD'
    );
  });

  it('defines HANDSHAKE_TIMEOUT constant', () => {
    assert.ok(
      peerLcSrc.includes('HANDSHAKE_TIMEOUT'),
      'peerLinkCable.js must define HANDSHAKE_TIMEOUT'
    );
  });

  it('defines a separate HANDSHAKE_XFER_TIMEOUT for extended exchange wait', () => {
    assert.ok(
      peerLcSrc.includes('HANDSHAKE_XFER_TIMEOUT'),
      'peerLinkCable.js must define HANDSHAKE_XFER_TIMEOUT for longer timeout during handshake'
    );
  });

  it('uses HANDSHAKE_XFER_TIMEOUT in exchangeWord when in handshake mode', () => {
    assert.ok(
      peerLcSrc.includes('HANDSHAKE_XFER_TIMEOUT') && peerLcSrc.includes('_handshakeMode'),
      'exchangeWord() must use longer timeout (HANDSHAKE_XFER_TIMEOUT) when in Pokémon handshake mode'
    );
    assert.ok(
      peerLcSrc.includes('_getExchangeTimeout'),
      '_getExchangeTimeout() helper must encapsulate timeout selection'
    );
  });

  it('_detectHandshake counts consecutive sentinel words', () => {
    assert.ok(
      peerLcSrc.includes('_detectHandshake') && peerLcSrc.includes('consecutiveZeroCount'),
      '_detectHandshake must track consecutive sentinel words'
    );
  });

  it('inHandshakeMode getter is defined', () => {
    assert.ok(
      peerLcSrc.includes('inHandshakeMode'),
      'PeerLinkCableImpl must expose an inHandshakeMode getter'
    );
  });
});

// ─── SIO Debug Logger ─────────────────────────────────────────────────────
describe('peerLinkCable.js – SIO debug logger', () => {
  it('installDebugLogger polls at ≥ 50 Hz (setInterval ≤ 20 ms)', () => {
    assert.ok(
      peerLcSrc.includes('installDebugLogger('),
      'peerLinkCable.js must define installDebugLogger()'
    );
    // Must use setInterval for periodic polling
    assert.ok(peerLcSrc.includes('setInterval'), 'installDebugLogger must use setInterval for polling');
    // Find the setInterval call inside installDebugLogger – search from its declaration
    const idx = peerLcSrc.indexOf('installDebugLogger(');
    assert.ok(idx !== -1);
    const body = peerLcSrc.substring(idx, peerLcSrc.indexOf('\n  // ── Singleton', idx) || idx + 5000);
    const match = body.match(/setInterval\([^,]+,\s*(\d+)\)/);
    if (match) {
      const ms = parseInt(match[1], 10);
      assert.ok(ms <= 20, `Polling interval must be ≤ 20 ms, got ${ms} ms`);
    }
  });

  it('installDebugLogger returns a handle with stop()', () => {
    assert.ok(
      peerLcSrc.includes('stop:') || peerLcSrc.includes("stop ()") || peerLcSrc.includes('stop:'),
      'installDebugLogger must return { stop() } to allow clean shutdown'
    );
  });

  it('installDebugLogger logs START bit events', () => {
    assert.ok(
      peerLcSrc.includes('START bit') || peerLcSrc.includes('startNow'),
      'installDebugLogger must detect and log the SIOCNT START bit'
    );
  });

  it('setDebugLogging(false) stops the logger', () => {
    // The setDebugLogging method must reference _debugHandle.stop to clean up
    assert.ok(
      peerLcSrc.includes('_debugHandle') &&
      (peerLcSrc.includes('.stop()') || peerLcSrc.includes('.stop(')),
      'setDebugLogging(false) must call _debugHandle.stop()'
    );
  });
});

// ─── UI Overlay ───────────────────────────────────────────────────────────
describe('peerLinkCable.js – Connect for Trade overlay', () => {
  it('has a Host / Join tab structure', () => {
    assert.ok(
      peerLcSrc.includes('plc-tab-host') && peerLcSrc.includes('plc-tab-join'),
      'Overlay must have Host and Join tabs'
    );
  });

  it('shows a room ID display element', () => {
    assert.ok(
      peerLcSrc.includes('plc-room-id-display'),
      'Overlay must have a plc-room-id-display element to show the room ID'
    );
  });

  it('has a Copy Room ID button', () => {
    assert.ok(
      peerLcSrc.includes('plc-copy-room-btn'),
      'Overlay must have a Copy Room ID button'
    );
  });

  it('has a debug logging toggle checkbox', () => {
    assert.ok(
      peerLcSrc.includes('plc-debug-toggle'),
      'Overlay must have a debug logging toggle checkbox'
    );
  });

  it('_updateOverlayStatus handles connected/disconnected/connecting states', () => {
    assert.ok(
      peerLcSrc.includes("'connected'") && peerLcSrc.includes("'disconnected'"),
      "_updateOverlayStatus must handle 'connected' and 'disconnected' states"
    );
  });
});

// ─── game.js integration ──────────────────────────────────────────────────
describe('game.js – PeerLinkCable integration', () => {
  const gameJs = fs.readFileSync(
    path.join(__dirname, '../public/js/game.js'),
    'utf8'
  );

  it('requestTransferWebRtc() prefers PeerLinkCable when connected', () => {
    const idx = gameJs.indexOf('function requestTransferWebRtc(');
    assert.ok(idx !== -1, 'requestTransferWebRtc must exist');
    const body = gameJs.substring(idx, idx + 400);
    assert.ok(
      body.includes('PeerLinkCable') && body.includes('exchangeWord'),
      'requestTransferWebRtc must use window.PeerLinkCable.exchangeWord() when connected'
    );
  });

  it('installRegisterInterceptor installs PeerLC debug logger', () => {
    const idx = gameJs.indexOf('function installRegisterInterceptor(');
    assert.ok(idx !== -1);
    const body = gameJs.substring(idx, idx + 600);
    assert.ok(
      body.includes('PeerLinkCable') && body.includes('installDebugLogger'),
      'installRegisterInterceptor must call PeerLinkCable.installDebugLogger() when debug is on'
    );
  });

  it('startLinkCablePolling wires PeerLC onSync to _luaInjectSync', () => {
    const idx = gameJs.indexOf('function startLinkCablePolling(');
    assert.ok(idx !== -1);
    const body = gameJs.substring(idx, idx + 1200);
    assert.ok(
      body.includes('onSync') && body.includes('_luaInjectSync'),
      'startLinkCablePolling must wire PeerLC onSync callback to _luaInjectSync'
    );
  });

  it('initUIEvents wires #peer-lc-btn to showOverlay()', () => {
    assert.ok(
      gameJs.includes('peer-lc-btn') && gameJs.includes('showOverlay'),
      'game.js must wire the #peer-lc-btn button to PeerLinkCable.showOverlay()'
    );
  });
});

// ─── game.html integration ────────────────────────────────────────────────
describe('game.html – PeerLinkCable integration', () => {
  const gameHtml = fs.readFileSync(
    path.join(__dirname, '../public/game.html'),
    'utf8'
  );

  it('includes peerjs.min.js before peerLinkCable.js', () => {
    assert.ok(
      gameHtml.includes('peerjs.min.js'),
      'game.html must include peerjs.min.js'
    );
    const peerjsIdx = gameHtml.indexOf('peerjs.min.js');
    const peerLcIdx = gameHtml.indexOf('peerLinkCable.js');
    assert.ok(peerjsIdx !== -1 && peerLcIdx !== -1);
    assert.ok(
      peerjsIdx < peerLcIdx,
      'peerjs.min.js must be included before peerLinkCable.js'
    );
  });

  it('includes peerLinkCable.js', () => {
    assert.ok(
      gameHtml.includes('peerLinkCable.js'),
      'game.html must include peerLinkCable.js'
    );
  });

  it('has the #peer-lc-btn "Trade" button', () => {
    assert.ok(
      gameHtml.includes('peer-lc-btn'),
      'game.html must have a #peer-lc-btn element for opening the trade overlay'
    );
  });
});

// ─── RFU multi-packet exchange ───────────────────────────────────────────────
describe('peerLinkCable.js – RFU multi-packet exchange', () => {
  it('defines exchangeRfuPacket() method', () => {
    assert.ok(
      peerLcSrc.includes('exchangeRfuPacket('),
      'peerLinkCable.js must define exchangeRfuPacket() for RFU multi-word packets'
    );
  });

  it('defines discoverGames() method', () => {
    assert.ok(
      peerLcSrc.includes('discoverGames('),
      'peerLinkCable.js must define discoverGames() for RFU lobby discovery'
    );
  });

  it('exchangeRfuPacket sends type: rfu message over DataChannel', () => {
    assert.ok(
      peerLcSrc.includes("type: 'rfu'") || peerLcSrc.includes("type:'rfu'"),
      "exchangeRfuPacket must send a message with type: 'rfu'"
    );
  });

  it('_handleMessage routes type:rfu responses to _rfuPendingResolve', () => {
    assert.ok(
      peerLcSrc.includes('_rfuPendingResolve'),
      '_handleMessage must handle type:rfu messages via _rfuPendingResolve'
    );
  });

  it('destroy() cleans up RFU pending state', () => {
    assert.ok(
      peerLcSrc.includes('_rfuPendingTimeout') && peerLcSrc.includes('_rfuPendingResolve'),
      'destroy() must clear _rfuPendingTimeout and _rfuPendingResolve'
    );
  });

  it('discoverGames emits rfu:search and returns games array', () => {
    assert.ok(
      peerLcSrc.includes("'rfu:search'"),
      "discoverGames must emit 'rfu:search' to discover wireless games"
    );
  });
});

// ─── game.js – RFU integration ───────────────────────────────────────────────
describe('game.js – RFU Wireless Adapter integration', () => {
  const gameJs = require('fs').readFileSync(
    require('path').join(__dirname, '../public/js/game.js'),
    'utf8'
  );

  it('connects to /rfu Socket.io namespace', () => {
    assert.ok(
      gameJs.includes("io('/rfu'"),
      "game.js must connect to the /rfu Socket.io namespace for RFU discovery"
    );
  });

  it('sets window._rfuLobbyId when /rfu socket connects', () => {
    assert.ok(
      gameJs.includes('window._rfuLobbyId'),
      'game.js must set window._rfuLobbyId so mgbaBridge.js can reference the lobby'
    );
  });

  it('wires MgbaBridge.setRfuSocket in enableLinkCable', () => {
    const fnStart = gameJs.indexOf('function enableLinkCable');
    assert.ok(fnStart !== -1, 'enableLinkCable must exist');
    const fnBody = gameJs.substring(fnStart, fnStart + 2000);
    assert.ok(
      fnBody.includes('setRfuSocket'),
      'enableLinkCable must call MgbaBridge.setRfuSocket to wire the /rfu socket'
    );
  });

  it('wires MgbaBridge.connectPeer in enableLinkCable', () => {
    const fnStart = gameJs.indexOf('function enableLinkCable');
    assert.ok(fnStart !== -1, 'enableLinkCable must exist');
    const fnBody = gameJs.substring(fnStart, fnStart + 2000);
    assert.ok(
      fnBody.includes('connectPeer'),
      'enableLinkCable must call MgbaBridge.connectPeer to wire PeerLinkCable'
    );
  });

  it('defines discoverWirelessGames() function', () => {
    assert.ok(
      gameJs.includes('function discoverWirelessGames'),
      'game.js must define discoverWirelessGames() for the frontend lobby UI'
    );
  });

  it('discoverWirelessGames emits rfu:search and returns results', () => {
    assert.ok(
      gameJs.includes("'rfu:search'"),
      "discoverWirelessGames must emit 'rfu:search' to find wireless games"
    );
  });

  it('exposes discoverWirelessGames on window for external UI access', () => {
    assert.ok(
      gameJs.includes('window.discoverWirelessGames'),
      'game.js must expose discoverWirelessGames on window'
    );
  });

  it('disableLinkCable disconnects the RFU bridge', () => {
    const fnStart = gameJs.indexOf('function disableLinkCable');
    assert.ok(fnStart !== -1, 'disableLinkCable must exist');
    const fnBody = gameJs.substring(fnStart, fnStart + 800);
    assert.ok(
      fnBody.includes('setRfuSocket(null)'),
      'disableLinkCable must call setRfuSocket(null) to clean up RFU state'
    );
    assert.ok(
      fnBody.includes('disconnectPeer'),
      'disableLinkCable must call disconnectPeer to clean up PeerJS'
    );
  });
});

// ─── rfuRelay.js – server-side socket ────────────────────────────────────────
describe('rfuRelay.js – server-side RFU relay', () => {
  const rfuRelaySrc = require('fs').readFileSync(
    require('path').join(__dirname, '../src/socket/rfuRelay.js'),
    'utf8'
  );

  it('file exists', () => {
    assert.ok(
      require('fs').existsSync(require('path').join(__dirname, '../src/socket/rfuRelay.js')),
      'src/socket/rfuRelay.js must exist'
    );
  });

  it('creates a /rfu Socket.io namespace', () => {
    assert.ok(
      rfuRelaySrc.includes("'/rfu'"),
      'rfuRelay.js must create the /rfu namespace'
    );
  });

  it('handles rfu:host to register a hosting player', () => {
    assert.ok(
      rfuRelaySrc.includes("'rfu:host'"),
      'rfuRelay.js must handle rfu:host for host registration'
    );
  });

  it('handles rfu:search to return the games list', () => {
    assert.ok(
      rfuRelaySrc.includes("'rfu:search'"),
      'rfuRelay.js must handle rfu:search for game discovery'
    );
  });

  it('includes peerId in rfu:search results so clients can do P2P', () => {
    assert.ok(
      rfuRelaySrc.includes('peerId'),
      'rfuRelay.js must include peerId in search results for direct PeerJS connection'
    );
  });

  it('handles rfu:data for relay fallback', () => {
    assert.ok(
      rfuRelaySrc.includes("'rfu:data'"),
      'rfuRelay.js must handle rfu:data for Socket.io relay fallback'
    );
  });

  it('broadcasts rfu:host-available when a new host registers', () => {
    assert.ok(
      rfuRelaySrc.includes("'rfu:host-available'"),
      'rfuRelay.js must emit rfu:host-available when a host registers'
    );
  });

  it('broadcasts rfu:host-left when a host disconnects', () => {
    assert.ok(
      rfuRelaySrc.includes("'rfu:host-left'"),
      'rfuRelay.js must emit rfu:host-left when a host leaves'
    );
  });

  it('is registered in server.js', () => {
    const serverJs = require('fs').readFileSync(
      require('path').join(__dirname, '../server.js'),
      'utf8'
    );
    assert.ok(
      serverJs.includes("require('./src/socket/rfuRelay')"),
      'server.js must require ./src/socket/rfuRelay'
    );
  });
});
