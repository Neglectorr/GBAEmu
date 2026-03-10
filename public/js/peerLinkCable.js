'use strict';
/**
 * peerLinkCable.js – PeerJS-based GBA Link Cable for Pokémon Trading
 *
 * This module provides a Peer-to-Peer (WebRTC DataChannel) link cable
 * implementation using the PeerJS library. It is designed to replace the
 * Socket.IO relay for direct 2-player Pokémon trading with minimal latency.
 *
 * Features:
 *   1. Trade Room: Host generates a Room ID; guest enters it to join.
 *   2. SIO Debug Logger: Polls SIOCNT / SIODATA8 / SIODATA32 every ~16 ms
 *      and logs changes + START-bit events to the console.  Useful for
 *      verifying the register hook is working before connecting a peer.
 *   3. Lock-step Exchange: exchangeWord() sends our word and waits for the
 *      peer's word – both sides must exchange before either can continue.
 *   4. Pokémon Handshake Detection: Detects the Gen 3 handshake byte
 *      sequence (repeated 0x0000 transfers) and applies a longer timeout
 *      during that critical phase to prevent "Communication Errors".
 *   5. Connect for Trade UI Overlay: A floating panel rendered into the
 *      page DOM; call PeerLinkCable.showOverlay() to open it.
 *
 * Integration with game.js:
 *   • installRegisterInterceptor() calls
 *     window.PeerLinkCable.installDebugLogger() when debug mode is on.
 *   • requestTransferWebRtc() prefers window.PeerLinkCable.exchangeWord()
 *     when a PeerJS connection is active.
 *   • window._luaInjectSync is called from the onSync callback to feed
 *     received words into the mGBA WASM registers.
 *
 * GBA I/O register offsets used (relative to the I/O base in the WASM heap):
 *   0x120  SIOMULTI0  – Player 0 received data (also SIODATA32 low word)
 *   0x122  SIOMULTI1  – Player 1 received data (also SIODATA32 high word)
 *   0x124  SIOMULTI2  – Player 2 received data
 *   0x126  SIOMULTI3  – Player 3 received data
 *   0x128  SIOCNT     – SIO Control (bit 7 = START, bits 12-13 = mode, …)
 *   0x12A  SIODATA8 / SIOMLT_SEND – the word this player sends
 *   0x134  RCNT       – R-Counter / mode select (bit 15 = GPIO/JOY mode)
 */

// ─── GBA SIO Register Offsets ──────────────────────────────────────────────
const SIO_OFF = {
  SIOMULTI0:  0x120,
  SIOMULTI1:  0x122,
  SIOMULTI2:  0x124,
  SIOMULTI3:  0x126,
  SIOCNT:     0x128,
  SIODATA8:   0x12A,  // also SIOMLT_SEND
  RCNT:       0x134,
  IE:         0x200,
  IF:         0x202,
};

// ─── Pokémon Gen 3 Handshake Detection ────────────────────────────────────
// Gen 3 games begin trading with a burst of 0x0000 transfers.  Detecting
// this lets us apply an extended timeout so a slow network round-trip
// does not trigger an in-game "Communication Error".
const HANDSHAKE_SENTINEL  = 0x0000;
const HANDSHAKE_THRESHOLD = 3;      // how many consecutive 0x0000 to trigger
const HANDSHAKE_TIMEOUT   = 6000;   // ms the handshake phase lasts
const NORMAL_TIMEOUT      = 2500;   // ms per exchange in normal play
const HANDSHAKE_XFER_TIMEOUT = 8000; // ms per exchange during handshake

// ─── Overlay IDs ───────────────────────────────────────────────────────────
const OVERLAY_ID       = 'peer-lc-overlay';
const OVERLAY_STYLE_ID = 'peer-lc-overlay-styles';

// ─── PeerLinkCableImpl ─────────────────────────────────────────────────────

class PeerLinkCableImpl {
  constructor() {
    /** @type {import('peerjs').Peer|null} */
    this._peer     = null;
    /** @type {import('peerjs').DataConnection|null} */
    this._conn     = null;
    this._roomId   = null;   // our PeerJS peer ID (used as Room ID)
    this._isHost   = false;  // true = created room; false = joined room

    // ── Callbacks ────────────────────────────────────────────────────────
    this._onConnected    = null;
    this._onDisconnected = null;
    this._onError        = null;
    this._onRoomCreated  = null;
    this._onSync         = null;   // (words, transferId) → void

    // ── Lock-step transfer state ─────────────────────────────────────────
    this._pendingResolve = null;
    this._pendingTimeout = null;
    this._lastSentWord   = 0xFFFF;
    this._transferId     = 0;
    this._connected      = false;

    // ── Debug logger state ───────────────────────────────────────────────
    this._debugEnabled = false;
    this._debugHandle  = null;   // { stop() } returned by installDebugLogger

    // ── Pokémon handshake detection ──────────────────────────────────────
    this._handshakeMode        = false;
    this._consecutiveZeroCount = 0;
    this._handshakeTimer       = null;

    // ── RFU multi-packet state ────────────────────────────────────────────
    /** @type {Function|null} Pending resolve for an in-flight RFU packet exchange */
    this._rfuPendingResolve  = null;
    /** @type {number|null} Timeout handle for the in-flight RFU exchange */
    this._rfuPendingTimeout  = null;
  }

  // ── Accessors ───────────────────────────────────────────────────────────

  /** true when a DataChannel is open and ready for transfers. */
  get connected() { return this._connected; }

  /** The PeerJS room ID to share with the other player. */
  get roomId() { return this._roomId; }

  /** true = we created the room; false = we joined someone else's room. */
  get isHost() { return this._isHost; }

  /** true during the Pokémon Gen 3 trade handshake phase. */
  get inHandshakeMode() { return this._handshakeMode; }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Enable or disable the SIO register debug logger.
   * Must be called before installDebugLogger() for the flag to take effect
   * at startup, though installDebugLogger() can also be called directly.
   *
   * @param {boolean} enabled
   */
  setDebugLogging(enabled) {
    this._debugEnabled = !!enabled;
    if (enabled) {
      console.log(
        '[PeerLC DEBUG] SIO debug logging ENABLED.\n' +
        '[PeerLC DEBUG] Watching SIOCNT (0x128), SIODATA8 (0x12A), SIOMULTI0-3 (0x120-0x126).\n' +
        '[PeerLC DEBUG] A "⚡ START bit set" message means the game is trying to use the link cable.'
      );
    } else {
      if (this._debugHandle) {
        this._debugHandle.stop();
        this._debugHandle = null;
      }
    }
  }

  /**
   * Register event callbacks.
   *
   * @param {object}   handlers
   * @param {Function} [handlers.onConnected]    – peer DataChannel opened
   * @param {Function} [handlers.onDisconnected] – peer DataChannel closed
   * @param {Function} [handlers.onError]        – error(err)
   * @param {Function} [handlers.onRoomCreated]  – roomCreated(roomId)
   * @param {Function} [handlers.onSync]         – sync(words, transferId)
   */
  on(handlers) {
    if (handlers.onConnected)    this._onConnected    = handlers.onConnected;
    if (handlers.onDisconnected) this._onDisconnected = handlers.onDisconnected;
    if (handlers.onError)        this._onError        = handlers.onError;
    if (handlers.onRoomCreated)  this._onRoomCreated  = handlers.onRoomCreated;
    if (handlers.onSync)         this._onSync         = handlers.onSync;
  }

  /**
   * Create a new Trade Room.
   * This player becomes the host (P0 / master).  The returned room ID
   * should be shared with the other player so they can call joinRoom().
   *
   * @returns {Promise<string>} Resolves with the room ID once PeerJS is ready.
   */
  createRoom() {
    return new Promise((resolve, reject) => {
      this._teardownPeer();

      if (!window.Peer) {
        const err = new Error(
          'PeerJS not loaded. Ensure peerjs.min.js is included before peerLinkCable.js.'
        );
        console.error('[PeerLC]', err.message);
        reject(err);
        return;
      }

      this._isHost = true;
      this._peer   = new window.Peer({ debug: this._debugEnabled ? 3 : 0 });

      this._peer.on('open', (id) => {
        this._roomId = id;
        console.log(`[PeerLC] Trade room created. Share this Room ID: ${id}`);
        if (this._onRoomCreated) this._onRoomCreated(id);

        // Host waits for an inbound connection from the guest
        this._peer.on('connection', (conn) => {
          if (this._conn) this._conn.close(); // only 1 peer in a trade
          this._setupConnection(conn);
        });

        resolve(id);
      });

      this._peer.on('error', (err) => {
        console.error('[PeerLC] PeerJS error:', err.type || err);
        if (this._onError) this._onError(err);
        reject(err);
      });

      this._peer.on('disconnected', () => {
        console.warn('[PeerLC] Disconnected from PeerJS signaling server – reconnecting…');
        this._peer.reconnect();
      });
    });
  }

  /**
   * Join an existing Trade Room.
   * This player becomes the guest (P1 / slave).
   *
   * @param {string} roomId – The host's room ID
   * @returns {Promise<void>} Resolves once the connection attempt is initiated.
   */
  joinRoom(roomId) {
    return new Promise((resolve, reject) => {
      this._teardownPeer();

      if (!window.Peer) {
        const err = new Error('PeerJS not loaded.');
        console.error('[PeerLC]', err.message);
        reject(err);
        return;
      }

      this._isHost = false;
      this._peer   = new window.Peer({ debug: this._debugEnabled ? 3 : 0 });

      this._peer.on('open', () => {
        console.log(`[PeerLC] Connecting to trade room: ${roomId}`);
        const conn = this._peer.connect(roomId, {
          reliable:      true,
          serialization: 'json',
        });
        this._setupConnection(conn);
        resolve();
      });

      this._peer.on('error', (err) => {
        console.error('[PeerLC] PeerJS error:', err.type || err);
        if (this._onError) this._onError(err);
        reject(err);
      });
    });
  }

  /**
   * Lock-step word exchange.
   *
   * Sends `word` to the peer and waits for the peer's word.  The emulator
   * register interceptor should only inject the received data after this
   * promise resolves (i.e. both sides have committed their byte).
   *
   * @param {number} word        – 16-bit SIOMLT_SEND / SIODATA8 value
   * @param {number} transferId  – Monotonically increasing transfer counter
   * @returns {Promise<number[]>} 4-element array [P0, P1, 0xFFFF, 0xFFFF]
   */
  exchangeWord(word, transferId) {
    return new Promise((resolve) => {
      if (!this._connected || !this._conn) {
        resolve([0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF]);
        return;
      }

      this._detectHandshake(word);
      this._lastSentWord  = word & 0xFFFF;
      this._transferId    = transferId;

      this._pendingResolve = resolve;
      this._pendingTimeout = setTimeout(() => {
        if (this._pendingResolve) {
          console.warn('[PeerLC] Exchange timeout – returning disconnect values');
          this._pendingResolve = null;
          resolve([0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF]);
        }
      }, this._getExchangeTimeout());

      try {
        this._conn.send({ type: 'word', word: word & 0xFFFF, transferId });
      } catch (e) {
        clearTimeout(this._pendingTimeout);
        this._pendingResolve = null;
        console.error('[PeerLC] Failed to send word:', e);
        resolve([0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF]);
      }
    });
  }

  /**
   * Exchange an RFU data packet with the connected peer.
   *
   * Used by mgbaBridge.js for commands that carry larger payloads than a
   * single 16-bit link-cable word (e.g. 0x1C SendData, 0x1D RecvData).
   * The packet is sent as a JSON message with type 'rfu' over the existing
   * PeerJS DataChannel; the peer replies with a matching 'rfu' message.
   *
   * @param {{ cmd: number, data: number[] }} packet
   * @returns {Promise<{ cmd: number, data: number[] }>}
   */
  exchangeRfuPacket(packet) {
    return new Promise((resolve) => {
      if (!this._connected || !this._conn) {
        resolve({ cmd: packet.cmd, data: [] });
        return;
      }

      // Cancel any previous in-flight RFU exchange
      if (this._rfuPendingResolve) {
        clearTimeout(this._rfuPendingTimeout);
        this._rfuPendingResolve({ cmd: packet.cmd, data: [] });
        this._rfuPendingResolve = null;
      }

      this._rfuPendingResolve = resolve;
      this._rfuPendingTimeout = setTimeout(() => {
        if (this._rfuPendingResolve) {
          this._rfuPendingResolve = null;
          console.warn('[PeerLC] RFU exchange timeout – returning empty data');
          resolve({ cmd: packet.cmd, data: [] });
        }
      }, this._getExchangeTimeout());

      try {
        this._conn.send({ type: 'rfu', cmd: packet.cmd, data: packet.data ?? [] });
      } catch (e) {
        clearTimeout(this._rfuPendingTimeout);
        this._rfuPendingResolve = null;
        console.error('[PeerLC] Failed to send RFU packet:', e);
        resolve({ cmd: packet.cmd, data: [] });
      }
    });
  }

  /**
   * Query the Socket.io /rfu namespace for available wireless games in the
   * given lobby.  Returns a list of lobby entries, each containing:
   *   { hostId, userName, gameInfo, peerId }
   * where `peerId` is the PeerJS room ID to pass to joinRoom().
   *
   * This implements the "Search" discovery function required by the RFU
   * wireless adapter protocol (GetBroadcastData 0x18).
   *
   * @param {object} rfuSocket  – Socket.io socket connected to '/rfu'
   * @param {string} lobbyId    – current game lobby ID
   * @returns {Promise<Array<{hostId:string, userName:string, gameInfo:number[], peerId:string}>>}
   */
  discoverGames(rfuSocket, lobbyId) {
    return new Promise((resolve) => {
      if (!rfuSocket?.connected || !lobbyId) {
        resolve([]);
        return;
      }
      const timeoutId = setTimeout(() => resolve([]), 3000);
      rfuSocket.emit('rfu:search', { lobbyId }, (res) => {
        clearTimeout(timeoutId);
        resolve(Array.isArray(res?.games) ? res.games : []);
      });
    });
  }

  /**
   * Install a debug logger that polls the GBA SIO registers and logs
   * any changes (including START-bit events) to the browser console.
   *
   * This is the first step to verify the register hook is working –
   * run this before trying to connect to another player.
   *
   * @param {number} ioBase      – GBA I/O base byte-offset in the WASM heap
   * @param {object} wasmModule  – Emscripten module with HEAPU16 or HEAPU8
   * @param {boolean} [logOnChange=true] – Only log when values change
   * @returns {{ stop: Function }|null}  Handle to stop polling, or null.
   */
  installDebugLogger(ioBase, wasmModule, logOnChange = true) {
    if (this._debugHandle) {
      this._debugHandle.stop();
      this._debugHandle = null;
    }

    const mod = wasmModule;
    if (!mod) {
      console.warn('[PeerLC DEBUG] WASM module not available – debug logger not installed');
      return null;
    }

    // Derive HEAPU16 from HEAPU8 if the core only exposes the byte view.
    if (!mod.HEAPU16 && mod.HEAPU8) {
      mod.HEAPU16 = new Uint16Array(mod.HEAPU8.buffer);
    }
    if (!mod.HEAPU16) {
      console.warn('[PeerLC DEBUG] Module has neither HEAPU16 nor HEAPU8');
      return null;
    }

    const siocntIdx    = (ioBase + SIO_OFF.SIOCNT)   >>> 1;
    const siodata8Idx  = (ioBase + SIO_OFF.SIODATA8) >>> 1;
    const siomulti0Idx = (ioBase + SIO_OFF.SIOMULTI0) >>> 1;

    let prevSiocnt    = -1;
    let prevSiodata8  = -1;
    let prevMulti0    = -1;
    let active        = true;

    console.log(
      '[PeerLC DEBUG] ─────────────────────────────────────────────\n' +
      '[PeerLC DEBUG] SIO register debug logger installed.\n' +
      '[PeerLC DEBUG]   SIOCNT    @ heap[' + siocntIdx    + '] (IO+0x128)\n' +
      '[PeerLC DEBUG]   SIODATA8  @ heap[' + siodata8Idx  + '] (IO+0x12A)\n' +
      '[PeerLC DEBUG]   SIOMULTI0 @ heap[' + siomulti0Idx + '] (IO+0x120)\n' +
      '[PeerLC DEBUG] Watch for "⚡ START bit set" to verify link cable activity.\n' +
      '[PeerLC DEBUG] ─────────────────────────────────────────────'
    );

    const intervalId = setInterval(() => {
      if (!active) return;

      // Re-derive HEAPU16 after potential Emscripten memory growth.
      if (mod.HEAPU8 && (!mod.HEAPU16 || mod.HEAPU16.buffer !== mod.HEAPU8.buffer)) {
        mod.HEAPU16 = new Uint16Array(mod.HEAPU8.buffer);
      }
      const h16 = mod.HEAPU16;
      if (!h16 || siocntIdx >= h16.length) return;

      const siocnt   = h16[siocntIdx];
      const siodata8 = siodata8Idx  < h16.length ? h16[siodata8Idx]  : 0;
      const multi0   = siomulti0Idx < h16.length ? h16[siomulti0Idx] : 0xFFFF;

      // ── Detect the START bit rising edge ────────────────────────────────
      const startNow  = !!(siocnt & 0x0080);
      const startPrev = prevSiocnt >= 0 && !!(prevSiocnt & 0x0080);
      if (startNow && !startPrev) {
        const modeBits = (siocnt >> 12) & 3;
        const modeStr  = ['Normal-8bit', 'Normal-32bit', 'Multiplay', 'UART'][modeBits];
        const playerId = (siocnt >> 4) & 3;
        console.log(
          `[PeerLC DEBUG] ⚡ START bit set! Mode=${modeStr} Player=${playerId} ` +
          `SIOCNT=0x${siocnt.toString(16).padStart(4,'0')} ` +
          `SIODATA8/SEND=0x${siodata8.toString(16).padStart(4,'0')}`
        );
      }

      // ── Log SIOCNT changes ───────────────────────────────────────────────
      if (!logOnChange || siocnt !== prevSiocnt) {
        if (prevSiocnt !== -1) {
          const startBit = (siocnt >> 7) & 1;
          const errBit   = (siocnt >> 6) & 1;
          const playerId = (siocnt >> 4) & 3;
          const irqBit   = (siocnt >> 14) & 1;
          console.log(
            `[PeerLC DEBUG] SIOCNT  0x${siocnt.toString(16).padStart(4,'0')} ` +
            `(START=${startBit} ERR=${errBit} PLAYER=${playerId} IRQ=${irqBit})`
          );
        }
        prevSiocnt = siocnt;
      }

      // ── Log SIODATA8 / SIOMLT_SEND changes ──────────────────────────────
      if (!logOnChange || siodata8 !== prevSiodata8) {
        if (prevSiodata8 !== -1) {
          console.log(
            `[PeerLC DEBUG] SIODATA8/SIOMLT_SEND  0x${siodata8.toString(16).padStart(4,'0')}`
          );
        }
        prevSiodata8 = siodata8;
      }

      // ── Log SIOMULTI0-3 changes ──────────────────────────────────────────
      if (!logOnChange || multi0 !== prevMulti0) {
        if (prevMulti0 !== -1) {
          const m1 = (siomulti0Idx + 1) < h16.length ? h16[siomulti0Idx + 1] : 0xFFFF;
          const m2 = (siomulti0Idx + 2) < h16.length ? h16[siomulti0Idx + 2] : 0xFFFF;
          const m3 = (siomulti0Idx + 3) < h16.length ? h16[siomulti0Idx + 3] : 0xFFFF;
          console.log(
            `[PeerLC DEBUG] SIOMULTI [` +
            `0x${multi0.toString(16)}, ` +
            `0x${m1.toString(16)}, ` +
            `0x${m2.toString(16)}, ` +
            `0x${m3.toString(16)}]`
          );
        }
        prevMulti0 = multi0;
      }
    }, 16); // ~60 Hz polling

    const handle = {
      stop: () => {
        active = false;
        clearInterval(intervalId);
        console.log('[PeerLC DEBUG] SIO register debug logger stopped.');
      },
    };
    this._debugHandle = handle;
    return handle;
  }

  /**
   * Show the "Connect for Trade" UI overlay.
   * Creates and inserts the overlay into the page DOM if it does not already
   * exist, then makes it visible.
   */
  showOverlay() {
    this._ensureOverlayDOM();
    const el = document.getElementById(OVERLAY_ID);
    if (el) el.style.display = 'flex';
  }

  /** Hide the "Connect for Trade" overlay without destroying it. */
  hideOverlay() {
    const el = document.getElementById(OVERLAY_ID);
    if (el) el.style.display = 'none';
  }

  /**
   * Destroy the PeerJS peer and all connections, and clean up timers.
   * Safe to call even if already disconnected.
   */
  destroy() {
    this._connected = false;
    if (this._pendingTimeout)    { clearTimeout(this._pendingTimeout);    this._pendingTimeout    = null; }
    if (this._handshakeTimer)    { clearTimeout(this._handshakeTimer);    this._handshakeTimer    = null; }
    if (this._debugHandle)       { this._debugHandle.stop(); this._debugHandle = null; }
    if (this._rfuPendingTimeout) { clearTimeout(this._rfuPendingTimeout); this._rfuPendingTimeout = null; }
    if (this._pendingResolve)  {
      this._pendingResolve([0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF]);
      this._pendingResolve = null;
    }
    if (this._rfuPendingResolve) {
      this._rfuPendingResolve({ cmd: 0, data: [] });
      this._rfuPendingResolve = null;
    }
    if (this._conn)  { try { this._conn.close();    } catch (e) { /* ignore */ } this._conn  = null; }
    if (this._peer)  { try { this._peer.destroy();  } catch (e) { /* ignore */ } this._peer  = null; }
    this._isHost  = false;
    this._roomId  = null;
    this._handshakeMode        = false;
    this._consecutiveZeroCount = 0;
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  _teardownPeer() {
    this.destroy();
  }

  _setupConnection(conn) {
    this._conn = conn;

    conn.on('open', () => {
      this._connected = true;
      console.log('[PeerLC] ✅ DataChannel open – P2P link cable active');
      this._updateOverlayStatus('connected');
      if (this._onConnected) this._onConnected();
    });

    conn.on('data', (data) => {
      this._handleMessage(data);
    });

    conn.on('close', () => {
      this._connected = false;
      console.log('[PeerLC] DataChannel closed');
      this._updateOverlayStatus('disconnected');
      this._resolvePendingWithDisconnect();
      if (this._onDisconnected) this._onDisconnected();
    });

    conn.on('error', (err) => {
      console.error('[PeerLC] DataChannel error:', err);
      this._resolvePendingWithDisconnect();
      if (this._onError) this._onError(err);
    });
  }

  _handleMessage(data) {
    if (!data || typeof data !== 'object') return;

    if (data.type === 'word') {
      const peerWord   = (data.word ?? 0xFFFF) & 0xFFFF;
      const transferId = data.transferId;

      if (this._debugEnabled) {
        console.log(
          `[PeerLC DEBUG] ← Received word 0x${peerWord.toString(16).padStart(4,'0')} ` +
          `(transfer ${transferId})`
        );
      }

      this._detectHandshake(peerWord);

      if (this._pendingResolve) {
        clearTimeout(this._pendingTimeout);
        const resolve = this._pendingResolve;
        this._pendingResolve = null;

        // Build the 4-word SIOMULTI response.
        // Host = P0 (index 0), guest = P1 (index 1).
        const words = this._isHost
          ? [this._lastSentWord & 0xFFFF, peerWord, 0xFFFF, 0xFFFF]
          : [peerWord, this._lastSentWord & 0xFFFF, 0xFFFF, 0xFFFF];

        if (this._onSync) this._onSync(words, transferId);
        resolve(words);
      }
    } else if (data.type === 'rfu') {
      // RFU multi-packet response from peer
      if (this._rfuPendingResolve) {
        clearTimeout(this._rfuPendingTimeout);
        const resolve = this._rfuPendingResolve;
        this._rfuPendingResolve = null;
        resolve({ cmd: data.cmd ?? 0, data: Array.isArray(data.data) ? data.data : [] });
      } else {
        // Unsolicited RFU packet from peer (e.g. host pushing data to client)
        // Dispatch to mgbaBridge if wired
        if (window.MgbaBridge && typeof window.MgbaBridge._rfuOnPeerData === 'function') {
          window.MgbaBridge._rfuOnPeerData({ cmd: data.cmd ?? 0, data: data.data ?? [] });
        }
      }
    }
  }

  /**
   * Detect the Pokémon Gen 3 handshake pattern (burst of 0x0000 words)
   * and activate extended timeouts for that phase.
   *
   * State machine:
   *   NORMAL → HANDSHAKE: after HANDSHAKE_THRESHOLD consecutive 0x0000 words.
   *   HANDSHAKE → NORMAL: after HANDSHAKE_TIMEOUT ms (timer set at transition).
   *     The timer (this._handshakeTimer) clears _handshakeMode and resets the
   *     counter.  A single non-zero word does NOT immediately end handshake mode
   *     to avoid false exits caused by one out-of-sequence byte.
   */
  _detectHandshake(word) {
    if ((word & 0xFFFF) === HANDSHAKE_SENTINEL) {
      this._consecutiveZeroCount++;
      if (this._consecutiveZeroCount >= HANDSHAKE_THRESHOLD && !this._handshakeMode) {
        this._handshakeMode = true;
        console.log('[PeerLC] 🤝 Pokémon handshake detected – using extended timeouts');
        if (this._handshakeTimer) clearTimeout(this._handshakeTimer);
        // Transition back to NORMAL after HANDSHAKE_TIMEOUT ms.
        this._handshakeTimer = setTimeout(() => {
          this._handshakeMode        = false;
          this._consecutiveZeroCount = 0;
          console.log('[PeerLC] Handshake phase ended');
        }, HANDSHAKE_TIMEOUT);
      }
    } else {
      // Non-zero words reset the consecutive counter but do NOT immediately
      // clear handshake mode – the timer handles the HANDSHAKE → NORMAL
      // transition so a single non-zero byte mid-handshake doesn't end it.
      this._consecutiveZeroCount = 0;
    }
  }

  /**
   * Return the appropriate per-transfer timeout in milliseconds.
   * During the Pokémon handshake phase a longer timeout is applied to
   * prevent premature fallback to disconnect values on slow networks.
   * @returns {number}
   */
  _getExchangeTimeout() {
    return this._handshakeMode ? HANDSHAKE_XFER_TIMEOUT : NORMAL_TIMEOUT;
  }

  _resolvePendingWithDisconnect() {
    if (this._pendingResolve) {
      clearTimeout(this._pendingTimeout);
      this._pendingResolve([0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF]);
      this._pendingResolve = null;
    }
  }

  // ── UI Overlay ─────────────────────────────────────────────────────────

  /**
   * Inject overlay styles once into the document <head>.
   * @private
   */
  _ensureOverlayStyles() {
    if (document.getElementById(OVERLAY_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = OVERLAY_STYLE_ID;
    style.textContent = `
      #${OVERLAY_ID} {
        display: none;
        position: fixed;
        inset: 0;
        z-index: 10000;
        background: rgba(0,0,0,.82);
        align-items: center;
        justify-content: center;
        font-family: var(--font-body, system-ui, sans-serif);
      }
      #${OVERLAY_ID} .plc-card {
        background: var(--bg-secondary, #1e1e2e);
        border-radius: 14px;
        padding: 28px 32px;
        max-width: 440px;
        width: 92%;
        box-shadow: 0 8px 40px rgba(0,0,0,.6);
        color: var(--text-primary, #e2e2f0);
      }
      #${OVERLAY_ID} h2 {
        margin: 0 0 6px;
        font-size: 1.2rem;
      }
      #${OVERLAY_ID} p.plc-sub {
        margin: 0 0 18px;
        font-size: .87rem;
        color: var(--text-secondary, #9ca3af);
      }
      #${OVERLAY_ID} .plc-tabs {
        display: flex;
        gap: 8px;
        margin-bottom: 18px;
      }
      #${OVERLAY_ID} .plc-tab {
        flex: 1;
        padding: 8px;
        border-radius: 8px;
        border: 1px solid var(--border, #333);
        background: transparent;
        color: var(--text-secondary, #9ca3af);
        cursor: pointer;
        font-size: .9rem;
        transition: background .15s, color .15s;
      }
      #${OVERLAY_ID} .plc-tab.active {
        background: var(--accent, #7c3aed);
        color: #fff;
        border-color: var(--accent, #7c3aed);
      }
      #${OVERLAY_ID} .plc-section { display: none; }
      #${OVERLAY_ID} .plc-section.visible { display: block; }
      #${OVERLAY_ID} .plc-room-id {
        font-family: monospace;
        font-size: 1.1rem;
        background: var(--bg-primary, #13131f);
        border-radius: 8px;
        padding: 10px 14px;
        word-break: break-all;
        letter-spacing: .04em;
        margin-bottom: 10px;
        color: var(--accent-light, #a78bfa);
        border: 1px solid var(--border, #333);
      }
      #${OVERLAY_ID} .plc-input {
        width: 100%;
        box-sizing: border-box;
        padding: 9px 12px;
        border-radius: 8px;
        border: 1px solid var(--border, #333);
        background: var(--bg-primary, #13131f);
        color: var(--text-primary, #e2e2f0);
        font-size: .95rem;
        margin-bottom: 12px;
      }
      #${OVERLAY_ID} .plc-btn {
        width: 100%;
        padding: 10px;
        border-radius: 8px;
        border: none;
        cursor: pointer;
        font-size: .95rem;
        font-weight: 600;
        margin-bottom: 8px;
        transition: opacity .15s;
      }
      #${OVERLAY_ID} .plc-btn:disabled { opacity: .5; cursor: not-allowed; }
      #${OVERLAY_ID} .plc-btn-primary {
        background: var(--accent, #7c3aed);
        color: #fff;
      }
      #${OVERLAY_ID} .plc-btn-secondary {
        background: var(--bg-primary, #13131f);
        color: var(--text-primary, #e2e2f0);
        border: 1px solid var(--border, #333);
      }
      #${OVERLAY_ID} .plc-status {
        margin-top: 10px;
        font-size: .85rem;
        padding: 8px 12px;
        border-radius: 6px;
        text-align: center;
      }
      #${OVERLAY_ID} .plc-status.idle        { background: var(--bg-primary,#13131f); color: var(--text-secondary,#9ca3af); }
      #${OVERLAY_ID} .plc-status.connecting  { background: #92400e22; color: #fbbf24; }
      #${OVERLAY_ID} .plc-status.connected   { background: #06562022; color: #34d399; }
      #${OVERLAY_ID} .plc-status.disconnected{ background: #7f1d1d22; color: #f87171; }
      #${OVERLAY_ID} .plc-close {
        float: right;
        background: none;
        border: none;
        font-size: 1.3rem;
        cursor: pointer;
        color: var(--text-secondary, #9ca3af);
        line-height: 1;
        padding: 0;
      }
      #${OVERLAY_ID} .plc-debug-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 12px;
        font-size: .82rem;
        color: var(--text-secondary, #9ca3af);
      }
      #${OVERLAY_ID} .plc-debug-row input[type=checkbox] { cursor: pointer; }
    `;
    document.head.appendChild(style);
  }

  /**
   * Create and inject the overlay HTML into document.body (once).
   * @private
   */
  _ensureOverlayDOM() {
    if (document.getElementById(OVERLAY_ID)) return;
    this._ensureOverlayStyles();

    const div = document.createElement('div');
    div.id = OVERLAY_ID;
    div.setAttribute('role', 'dialog');
    div.setAttribute('aria-modal', 'true');
    div.setAttribute('aria-label', 'Connect for Trade');
    div.innerHTML = `
      <div class="plc-card">
        <button class="plc-close" id="plc-close-btn" aria-label="Close">✕</button>
        <h2>🔗 Connect for Trade</h2>
        <p class="plc-sub">
          Create a Trade Room or enter a friend's Room ID to trade Pokémon directly
          via a peer-to-peer link cable connection.
        </p>

        <div class="plc-tabs">
          <button class="plc-tab active" id="plc-tab-host">🏠 Host Trade</button>
          <button class="plc-tab"        id="plc-tab-join">🔌 Join Trade</button>
        </div>

        <!-- Host section -->
        <div class="plc-section visible" id="plc-section-host">
          <button class="plc-btn plc-btn-primary" id="plc-create-room-btn">
            ✨ Create Trade Room
          </button>
          <div id="plc-room-id-wrap" style="display:none;">
            <p style="margin:0 0 6px;font-size:.82rem;color:var(--text-secondary,#9ca3af);">
              Share this Room ID with your trading partner:
            </p>
            <div class="plc-room-id" id="plc-room-id-display">—</div>
            <button class="plc-btn plc-btn-secondary" id="plc-copy-room-btn">📋 Copy Room ID</button>
          </div>
        </div>

        <!-- Join section -->
        <div class="plc-section" id="plc-section-join">
          <input class="plc-input" id="plc-join-input"
            type="text" placeholder="Enter Room ID…" autocomplete="off" spellcheck="false">
          <button class="plc-btn plc-btn-primary" id="plc-join-room-btn">
            🔌 Join Trade Room
          </button>
        </div>

        <!-- Status bar -->
        <div class="plc-status idle" id="plc-status-bar">Not connected</div>

        <!-- Debug logging toggle -->
        <div class="plc-debug-row">
          <input type="checkbox" id="plc-debug-toggle">
          <label for="plc-debug-toggle">Enable SIO debug logging (see browser console)</label>
        </div>
      </div>
    `;
    document.body.appendChild(div);
    this._bindOverlayEvents(div);
  }

  /**
   * Attach click / change handlers to the overlay controls.
   * @private
   */
  _bindOverlayEvents(overlayEl) {
    const $  = (id) => overlayEl.querySelector('#' + id);

    // Tab switching
    $('plc-tab-host').addEventListener('click', () => {
      $('plc-tab-host').classList.add('active');
      $('plc-tab-join').classList.remove('active');
      $('plc-section-host').classList.add('visible');
      $('plc-section-join').classList.remove('visible');
    });
    $('plc-tab-join').addEventListener('click', () => {
      $('plc-tab-join').classList.add('active');
      $('plc-tab-host').classList.remove('active');
      $('plc-section-join').classList.add('visible');
      $('plc-section-host').classList.remove('visible');
    });

    // Close button
    $('plc-close-btn').addEventListener('click', () => this.hideOverlay());

    // Close overlay on backdrop click
    overlayEl.addEventListener('click', (e) => {
      if (e.target === overlayEl) this.hideOverlay();
    });

    // Create room
    $('plc-create-room-btn').addEventListener('click', async () => {
      const btn = $('plc-create-room-btn');
      btn.disabled = true;
      btn.textContent = '⏳ Creating room…';
      this._updateOverlayStatus('connecting', 'Creating room…');
      try {
        const id = await this.createRoom();
        $('plc-room-id-display').textContent = id;
        $('plc-room-id-wrap').style.display = 'block';
        this._updateOverlayStatus('connecting', 'Waiting for trading partner…');
        btn.textContent = '✨ Create Trade Room';
        btn.disabled = false;
      } catch (err) {
        this._updateOverlayStatus('disconnected', 'Error: ' + (err.message || err));
        btn.textContent = '✨ Create Trade Room';
        btn.disabled = false;
      }
    });

    // Copy room ID
    $('plc-copy-room-btn').addEventListener('click', () => {
      const id = $('plc-room-id-display').textContent;
      if (id && id !== '—' && navigator.clipboard) {
        navigator.clipboard.writeText(id).then(() => {
          $('plc-copy-room-btn').textContent = '✅ Copied!';
          setTimeout(() => { $('plc-copy-room-btn').textContent = '📋 Copy Room ID'; }, 2000);
        });
      }
    });

    // Join room
    $('plc-join-room-btn').addEventListener('click', async () => {
      const roomId = $('plc-join-input').value.trim();
      if (!roomId) return;
      const btn = $('plc-join-room-btn');
      btn.disabled = true;
      btn.textContent = '⏳ Connecting…';
      this._updateOverlayStatus('connecting', 'Connecting to ' + roomId + '…');
      try {
        await this.joinRoom(roomId);
        // Status updates are handled by _setupConnection callbacks
        btn.textContent = '🔌 Join Trade Room';
        btn.disabled = false;
      } catch (err) {
        this._updateOverlayStatus('disconnected', 'Error: ' + (err.message || err));
        btn.textContent = '🔌 Join Trade Room';
        btn.disabled = false;
      }
    });

    // Debug toggle
    $('plc-debug-toggle').addEventListener('change', (e) => {
      this.setDebugLogging(e.target.checked);
    });
  }

  /**
   * Update the status bar text and CSS class in the overlay.
   *
   * @param {'idle'|'connecting'|'connected'|'disconnected'} state
   * @param {string} [text]
   * @private
   */
  _updateOverlayStatus(state, text) {
    const el = document.getElementById('plc-status-bar');
    if (!el) return;
    el.className = `plc-status ${state}`;
    el.textContent = text || {
      idle:         'Not connected',
      connecting:   'Connecting…',
      connected:    '✅ Connected – link cable active!',
      disconnected: '❌ Disconnected',
    }[state] || state;
  }
}

// ─── Singleton export ──────────────────────────────────────────────────────
// game.js and other scripts access the instance via window.PeerLinkCable.
window.PeerLinkCable = new PeerLinkCableImpl();
