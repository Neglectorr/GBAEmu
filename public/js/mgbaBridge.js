'use strict';
/**
 * mgbaBridge.js – mGBA WASM / Emscripten bridge + RFU Wireless Adapter emulation
 *
 * Responsibilities:
 *   1. retro_run export: wraps mGBA's retro_run via Emscripten cwrap so
 *      external code can drive one emulator frame tick from JavaScript.
 *   2. SIO register reader: exposes readSioRegisters() to snapshot the
 *      current SIOCNT / SIODATA8 / SIOMULTI0-3 / RCNT / IE / IF values.
 *   3. SIO register injector: injectSioData(words) writes SIOMULTI0-3 and
 *      fires the SIO IRQ so the GBA game receives multiplayer data.
 *   4. PeerJS integration: connectPeer(peerLinkCable) wires the bridge to
 *      a PeerLinkCableImpl instance so that every detected SIO transfer is
 *      automatically routed through PeerJS (window.PeerLinkCable) and the
 *      received word array is injected back into the emulator registers.
 *   5. Per-frame polling: startPolling() / stopPolling() run a lightweight
 *      requestAnimationFrame loop that detects SIOMLT_SEND changes and
 *      START-bit edges, then triggers the PeerJS exchange.
 *   6. RFU Wireless Adapter emulation: detects when the game switches to
 *      NORMAL_32BIT SIO mode with the 0x9966 magic bytes and implements the
 *      full RFU command-response state machine. Commands are processed
 *      synchronously where possible and routed over PeerJS / Socket.io for
 *      data exchange (SendData 0x1C / RecvData 0x1D) and lobby discovery
 *      (SetBroadcastData 0x16 / GetBroadcastData 0x18).
 *
 * Lifecycle (called from game.js after EJS_onGameStart):
 *   window.MgbaBridge.init(wasmModule, ioBase);
 *   window.MgbaBridge.connectPeer(window.PeerLinkCable);
 *   window.MgbaBridge.setRfuSocket(rfuSocket);   // optional – enables RFU discovery
 *   window.MgbaBridge.startPolling();
 *
 * GBA I/O register offsets (relative to ioBase in the WASM heap):
 *   0x120  SIOMULTI0  – received word from P0 (also SIODATA32 low word)
 *   0x122  SIOMULTI1  – received word from P1 (also SIODATA32 high word)
 *   0x124  SIOMULTI2  – received word from P2
 *   0x126  SIOMULTI3  – received word from P3
 *   0x128  SIOCNT     – SIO control (bit 7 = START, bits 12-13 = mode)
 *   0x12A  SIODATA8 / SIOMLT_SEND – the word this player wants to send
 *   0x134  RCNT       – mode select (bit 15 = GPIO/JOY BUS mode)
 *   0x200  IE         – Interrupt Enable
 *   0x202  IF         – Interrupt Request Flags
 *
 * RFU Wireless Adapter registers (NORMAL_32BIT mode, same physical addresses):
 *   0x120  SIODATA32 low  – low 16 bits of the 32-bit SIO word
 *   0x122  SIODATA32 high – high 16 bits of the 32-bit SIO word
 *   Command format: 0x9966CCLL (magic + command + data-word count)
 *   Response format: 0x80CC0000 (adapter ACK) or 0x80CCRRNN (with result)
 */

// ─── RFU Wireless Adapter constants ─────────────────────────────────────────

/** Magic high-word that identifies an RFU command (0x9966____). */
const RFU_MAGIC = 0x9966;

/** RFU command IDs sent from the GBA to the Wireless Adapter. */
const RFU_CMD = Object.freeze({
  SYSTEM_RESET:       0x10,
  SET_CONFIG:         0x11,
  GET_GAME_ID:        0x12,
  SYSTEM_STATUS:      0x13,
  SLOT_STATUS:        0x14,
  CONFIG_STATUS:      0x15,
  SET_BROADCAST_DATA: 0x16,
  START_BROADCAST:    0x17,
  GET_BROADCAST_DATA: 0x18,
  AUTH_START:         0x19,
  ACCEPT_CONNECTIONS: 0x1A,
  END_SESSION:        0x1B,
  SEND_DATA:          0x1C,
  RECEIVE_DATA:       0x1D,
  WAIT:               0x1E,
  RECONNECT:          0x1F,
});

/** RFU state machine states. */
const RFU_STATE = Object.freeze({
  IDLE:             0,  // Waiting for a command header word
  READING_DATA:     1,  // Accumulating data words for the current command
  PROCESSING:       2,  // Async network operation in flight
  SENDING_RESPONSE: 3,  // Draining queued response words to SIODATA32
});

/** Timeout (ms) for async RFU network operations. */
const RFU_NET_TIMEOUT = 3000;

/**
 * High byte of the adapter ACK word written to SIODATA32.
 * Every response from the wireless adapter starts with 0x80CC____ where
 * CC = the command being acknowledged.  This constant is the 0x80 part.
 */
const RFU_ACK_HIGH_BYTE = 0x80;

/**
 * Maximum number of 32-bit words kept in the RFU receive buffer (_rfuRecvBuf).
 *
 * The buffer holds the most recent packet sent by the peer until the GBA
 * polls RecvData (0x1D) to retrieve it.  Because the GBA is single-threaded
 * and polls relatively slowly, data arriving faster than it is consumed is
 * silently dropped (oldest overwritten) beyond this limit.  A GBA game packet
 * is at most 87 bytes (22 words), so 64 words is a conservative safety cap.
 */
const RFU_RECV_BUF_MAX = 64;

/**
 * Hardware identifier returned in the high word of the SET_CONFIG (0x11)
 * response.  The value 0x0027 is the documented Wireless Adapter hardware ID
 * that Quetzal's multiplayer menu checks to display "Wireless Adapter" mode.
 */
const RFU_ADAPTER_HW_ID = 0x0027;

/**
 * Number of Int32 slots in the SharedArrayBuffer SIO register mirror.
 * Layout: [SIOMULTI0, SIOMULTI1, SIOMULTI2, SIOMULTI3, SIOCNT, SIODATA8, IE, IF]
 */
const SIO_SAB_SLOTS = 8;

/** Byte size of the SharedArrayBuffer SIO register mirror (8 × Int32 = 32 B). */
const SIO_SAB_BYTES = SIO_SAB_SLOTS * 4;

class MgbaBridgeImpl {
  constructor() {
    /** @type {object|null} Emscripten WASM Module (has HEAPU8 and/or HEAPU16) */
    this._mod = null;
    /** @type {number|null} Byte-offset of GBA I/O region inside the WASM heap */
    this._ioBase = null;
    /** @type {Function|null} cwrap-wrapped retro_run (void → void) */
    this._retroRun = null;
    /** @type {Function|null} Optional external SIO transfer callback */
    this._onSioTransfer = null;
    /** @type {object|null} Connected PeerLinkCable instance */
    this._peer = null;
    /** @type {number|null} requestAnimationFrame handle */
    this._rafHandle = null;
    /** @type {boolean} True while the polling loop is active */
    this._polling = false;
    /** @type {boolean} True while an async SIO exchange is in-flight */
    this._transferInProgress = false;
    /** @type {number} Monotonically increasing transfer counter */
    this._transferId = 0;
    /** @type {number} Last observed SIOMLT_SEND value for change detection */
    this._lastSendWord = -1;

    // ── RFU Wireless Adapter state ──────────────────────────────────────────
    /** @type {boolean} true when NORMAL_32BIT mode + 0x9966 magic detected */
    this._rfuEnabled    = false;
    /** @type {number} Current RFU state machine state (RFU_STATE.*) */
    this._rfuState      = RFU_STATE.IDLE;
    /** @type {number} Current RFU command being processed */
    this._rfuCmd        = 0;
    /** @type {number} Number of remaining data words to collect */
    this._rfuDataLen    = 0;
    /** @type {number[]} Accumulated 32-bit data words for the current command */
    this._rfuData       = [];
    /** @type {number[]} Response words queued for delivery to SIODATA32 */
    this._rfuRespQueue  = [];
    /** @type {number[]} Latest broadcast data set by the host (0x16) */
    this._rfuBroadcast  = [];
    /** @type {Array<{hostId:string,gameInfo:number[]}>} Discovered wireless games */
    this._rfuGames      = [];
    /** @type {number[]} Latest received data packet (from 0x1D RecvData) */
    this._rfuRecvBuf    = [];
    /** @type {object|null} Socket.io /rfu namespace socket for discovery */
    this._rfuSocket     = null;
    /** @type {string|null} Current game lobby ID (set via setRfuSocket) */
    this._rfuLobbyId    = null;
    /** @type {number} Previous SIOCNT value in NORMAL_32BIT mode (edge detect) */
    this._lastSiocnt32  = 0;

    // ── Frame-level lock-step stall ──────────────────────────────────────────
    /**
     * When true, retroRun() skips the underlying retro_run call so the
     * emulator does not advance a frame while waiting for an RFU network
     * packet from the connected peer.
     * @type {boolean}
     */
    this._frameStalled = false;

    // ── SharedArrayBuffer SIO register mirror ────────────────────────────────
    /**
     * SharedArrayBuffer backing the SIO register mirror, or null when SAB is
     * unavailable (e.g. non-isolated cross-origin context, Node without flag).
     * @type {SharedArrayBuffer|null}
     */
    this._sioSab = null;
    /**
     * Int32Array view over _sioSab for Atomics-based lock-free register access.
     * Slot layout matches SIO_SAB_SLOTS:
     *   0 SIOMULTI0, 1 SIOMULTI1, 2 SIOMULTI2, 3 SIOMULTI3,
     *   4 SIOCNT,    5 SIODATA8,  6 IE,         7 IF
     * @type {Int32Array|null}
     */
    this._sioSabView = null;
  }

  // ── Accessors ────────────────────────────────────────────────────────────

  /** true after init() has been called with a valid module and ioBase. */
  get ready() {
    return !!(this._mod && this._ioBase !== null);
  }

  /** The byte-offset of the GBA I/O region, or null if not initialised. */
  get ioBase() {
    return this._ioBase;
  }

  /** The connected PeerLinkCable instance, or null. */
  get peer() {
    return this._peer;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Initialise the bridge with the Emscripten module and the GBA I/O base.
   * Must be called after EmulatorJS has started (EJS_onGameStart) and after
   * the GBA I/O base has been located (installRegisterInterceptor).
   *
   * After init() the bridge:
   *   – derives HEAPU16 from HEAPU8 if the core only exposes the byte view,
   *   – wraps retro_run via cwrap (if available),
   *   – resets internal transfer state.
   *
   * @param {object} wasmModule – Emscripten module (must have HEAPU8 or HEAPU16)
   * @param {number} ioBase     – GBA I/O region byte-offset in the WASM heap
   */
  init(wasmModule, ioBase) {
    if (!wasmModule) throw new Error('[MgbaBridge] wasmModule is required');
    if (typeof ioBase !== 'number') throw new Error('[MgbaBridge] ioBase must be a number');

    this._mod    = wasmModule;
    this._ioBase = ioBase;

    // Derive HEAPU16 from HEAPU8's buffer if the core only exposes bytes.
    this._ensureHeap16();

    // Wrap retro_run via Emscripten cwrap (void function, no arguments).
    // This is the main libretro frame-advance entry point and lets external
    // code (e.g. test harnesses or synchronised multiplayer stepppers) drive
    // one emulation frame without going through the EmulatorJS main loop.
    if (typeof wasmModule.cwrap === 'function') {
      try {
        this._retroRun = wasmModule.cwrap('retro_run', null, []);
        console.log('[MgbaBridge] retro_run wrapped via cwrap');
      } catch (e) {
        console.warn('[MgbaBridge] cwrap(retro_run) failed:', e.message);
      }
    }

    this._lastSendWord       = -1;
    this._transferInProgress = false;
    this._transferId         = 0;
    this._frameStalled       = false;

    // Initialise SharedArrayBuffer SIO register mirror for lock-free access.
    // The SAB allows Web Workers (or future off-main-thread emulation) to read
    // SIO register snapshots via Atomics without posting messages to the UI
    // thread.  We guard with !this._sioSab so that subsequent init() calls
    // (e.g. game restart) reuse the same buffer rather than creating a new one
    // and invalidating any consumer references already held by worker threads.
    // Gracefully skip if SAB is unavailable (non-isolated cross-origin context).
    if (typeof SharedArrayBuffer !== 'undefined' && !this._sioSab) {
      try {
        this._sioSab     = new SharedArrayBuffer(SIO_SAB_BYTES);
        this._sioSabView = new Int32Array(this._sioSab);
      } catch (_) {
        this._sioSab     = null;
        this._sioSabView = null;
      }
    }

    console.log(`[MgbaBridge] Initialised. ioBase=0x${ioBase.toString(16)}`);
  }

  /**
   * Advance the GBA emulation by one frame by calling retro_run.
   *
   * Under EmulatorJS the internal main loop already drives frame ticks;
   * this method is intended for external code that needs to step the
   * emulator explicitly (e.g. test harnesses or frame-locked multiplayer).
   * Do NOT call this from within the EmulatorJS main loop or
   * requestAnimationFrame callbacks that are already running inside
   * EmulatorJS – doing so would schedule a double frame tick and could
   * cause audio/video desync.  Safe contexts include: after the EmulatorJS
   * main loop has been paused, inside a test harness that drives the
   * emulator manually, or from a separate Worker thread.
   *
   * Frame-level lock-step stall: when an RFU Wireless Adapter command that
   * requires a peer data packet is in-flight (_frameStalled === true), this
   * method returns false immediately without advancing the emulator so the
   * game does not make progress until the network round-trip completes.
   *
   * If the cwrap-wrapped function is not available this method is a no-op
   * and returns false, allowing callers to detect the unavailable state.
   *
   * @returns {boolean} true if retro_run was called, false otherwise.
   */
  retroRun() {
    this._ensureHeap16();

    // Frame-level lock-step: stall while waiting for an RFU network packet.
    if (this._frameStalled) return false;

    if (typeof this._retroRun === 'function') {
      this._retroRun();
      return true;
    }

    // Re-attempt cwrap in case the module was not yet fully initialised
    // when init() was called (e.g. deferred WASM compilation).
    if (this._mod && typeof this._mod.cwrap === 'function') {
      try {
        this._retroRun = this._mod.cwrap('retro_run', null, []);
        this._retroRun();
        return true;
      } catch (e) {
        // Not available – fall through to return false
      }
    }

    return false;
  }

  /**
   * Snapshot the current GBA Serial I/O registers from the WASM heap.
   *
   * Returns an object with all SIO-related register values so that callers
   * can inspect the communication state without direct heap access.
   *
   * @returns {{
   *   siocnt:   number,    SIOCNT  (IO+0x128) – control / status
   *   siodata8: number,    SIODATA8/SIOMLT_SEND (IO+0x12A) – our send word
   *   siomulti: number[],  [SIOMULTI0, SIOMULTI1, SIOMULTI2, SIOMULTI3]
   *   rcnt:     number,    RCNT (IO+0x134)
   *   ie:       number,    IE   (IO+0x200)
   *   ifReg:    number,    IF   (IO+0x202)
   * }|null} Current register snapshot, or null if not ready.
   */
  readSioRegisters() {
    const heap16 = this._getHeap16();
    if (!heap16 || this._ioBase === null) return null;

    const base = this._ioBase;
    const siocntIdx    = (base + 0x128) >>> 1;
    const siodata8Idx  = (base + 0x12A) >>> 1;
    const multi0Idx    = (base + 0x120) >>> 1;
    const rcntIdx      = (base + 0x134) >>> 1;
    const ieIdx        = (base + 0x200) >>> 1;
    const ifIdx        = (base + 0x202) >>> 1;
    const len          = heap16.length;

    const regs = {
      siocnt:   siocntIdx   < len ? heap16[siocntIdx]   : 0,
      siodata8: siodata8Idx < len ? heap16[siodata8Idx] : 0xFFFF,
      siomulti: [
        multi0Idx     < len ? heap16[multi0Idx]     : 0xFFFF,
        multi0Idx + 1 < len ? heap16[multi0Idx + 1] : 0xFFFF,
        multi0Idx + 2 < len ? heap16[multi0Idx + 2] : 0xFFFF,
        multi0Idx + 3 < len ? heap16[multi0Idx + 3] : 0xFFFF,
      ],
      rcnt:  rcntIdx < len ? heap16[rcntIdx] : 0,
      ie:    ieIdx   < len ? heap16[ieIdx]   : 0,
      ifReg: ifIdx   < len ? heap16[ifIdx]   : 0,
    };

    // Sync to SharedArrayBuffer so other threads (e.g. a Web Worker running
    // a frame-advance loop) can read SIO register values via Atomics.load()
    // without coordinating with the UI thread via postMessage.
    if (this._sioSabView) {
      Atomics.store(this._sioSabView, 0, regs.siomulti[0]);
      Atomics.store(this._sioSabView, 1, regs.siomulti[1]);
      Atomics.store(this._sioSabView, 2, regs.siomulti[2]);
      Atomics.store(this._sioSabView, 3, regs.siomulti[3]);
      Atomics.store(this._sioSabView, 4, regs.siocnt);
      Atomics.store(this._sioSabView, 5, regs.siodata8);
      Atomics.store(this._sioSabView, 6, regs.ie);
      Atomics.store(this._sioSabView, 7, regs.ifReg);
    }

    return regs;
  }

  /**
   * Write SIOMULTI0-3 into the WASM heap and trigger the SIO IRQ.
   *
   * After each successful PeerJS exchange the received 4-word array is
   * injected here so the GBA game's interrupt handler or polling loop sees
   * the correct multiplayer data from all connected players.
   *
   * – Writes words[0..3] to SIOMULTI0-3 (IO+0x120..0x126).
   * – Sets bit 7 (Serial Communication) in IF so the SIO IRQ fires.
   * – Ensures bit 7 is also set in IE so the game can receive the IRQ.
   * – Syncs the new values into the SharedArrayBuffer mirror via Atomics.
   *
   * @param {number[]} words – 4-element array [P0, P1, P2, P3] (16-bit values)
   */
  injectSioData(words) {
    const heap16 = this._getHeap16();
    if (!heap16 || this._ioBase === null) return;

    const base      = this._ioBase;
    const multi0Idx = (base + 0x120) >>> 1;
    const ifIdx     = (base + 0x202) >>> 1;
    const ieIdx     = (base + 0x200) >>> 1;

    if (multi0Idx + 3 >= heap16.length) return;

    const w0 = (words[0] ?? 0xFFFF) & 0xFFFF;
    const w1 = (words[1] ?? 0xFFFF) & 0xFFFF;
    const w2 = (words[2] ?? 0xFFFF) & 0xFFFF;
    const w3 = (words[3] ?? 0xFFFF) & 0xFFFF;

    heap16[multi0Idx]     = w0;
    heap16[multi0Idx + 1] = w1;
    heap16[multi0Idx + 2] = w2;
    heap16[multi0Idx + 3] = w3;

    // Fire the Serial Communication IRQ (bit 7 of IF) and enable it in IE
    if (ifIdx < heap16.length) heap16[ifIdx] |= (1 << 7);
    if (ieIdx < heap16.length) heap16[ieIdx] |= (1 << 7);

    // Mirror SIOMULTI values into the SAB so other threads can read them
    // atomically without UI-thread coordination.
    if (this._sioSabView) {
      Atomics.store(this._sioSabView, 0, w0);
      Atomics.store(this._sioSabView, 1, w1);
      Atomics.store(this._sioSabView, 2, w2);
      Atomics.store(this._sioSabView, 3, w3);
    }
  }

  /**
   * Register an optional external SIO transfer callback.
   *
   * This is used when PeerLinkCable is not connected but you still want
   * to intercept SIO transfers (e.g. to route through a custom channel).
   *
   * The callback receives:
   *   sendWord   {number}  – SIOMLT_SEND value (the word this player sends)
   *   transferId {number}  – monotonically increasing transfer counter
   *
   * It must return a Promise<number[]> that resolves with the 4-word
   * SIOMULTI response [P0, P1, P2, P3].
   *
   * When PeerLinkCable IS connected it takes priority over this callback.
   *
   * @param {Function} callback
   */
  onSioTransfer(callback) {
    this._onSioTransfer = callback;
  }

  /**
   * Wire a PeerLinkCable instance to the bridge.
   *
   * When a peer is connected every detected SIO transfer is routed through
   * peer.exchangeWord(sendWord, transferId) and the returned 4-word array
   * is automatically injected via injectSioData().
   *
   * @param {object} peerLinkCable – window.PeerLinkCable (PeerLinkCableImpl)
   */
  connectPeer(peerLinkCable) {
    this._peer = peerLinkCable;
    console.log('[MgbaBridge] PeerLinkCable wired');
  }

  /** Remove the wired PeerLinkCable instance. */
  disconnectPeer() {
    this._peer = null;
    console.log('[MgbaBridge] PeerLinkCable disconnected from bridge');
  }

  /**
   * Wire a Socket.io /rfu namespace socket for RFU lobby discovery.
   *
   * When set, SetBroadcastData (0x16) emits `rfu:host` to register the game,
   * and GetBroadcastData (0x18) emits `rfu:search` to populate the games list.
   *
   * Passing `lobbyId` removes the need for the global `window._rfuLobbyId`
   * variable and improves encapsulation.  Both are accepted for backwards
   * compatibility: if `lobbyId` is omitted the bridge falls back to reading
   * `window._rfuLobbyId`.
   *
   * @param {object|null} rfuSocket – Socket.io socket connected to '/rfu'
   * @param {string}      [lobbyId] – the current game-lobby ID
   */
  setRfuSocket(rfuSocket, lobbyId) {
    this._rfuSocket  = rfuSocket;
    if (lobbyId) this._rfuLobbyId = lobbyId;
    if (rfuSocket) {
      // Receive data packets relayed by the server from a peer
      rfuSocket.on('rfu:data', (msg) => {
        if (Array.isArray(msg?.packet)) {
          this._rfuOnPeerData({ data: msg.packet });
        }
      });
      // Update the games list when a host announces or leaves
      rfuSocket.on('rfu:host-available', () => this._rfuRefreshGames());
      rfuSocket.on('rfu:host-left',      () => this._rfuRefreshGames());
      console.log('[MgbaBridge] RFU socket wired');
    }
  }

  /**
   * Return true if the bridge has detected an active RFU wireless adapter
   * session (NORMAL_32BIT mode with 0x9966 magic was observed).
   */
  get rfuActive() {
    return this._rfuEnabled;
  }

  /**
   * Return a snapshot of the most recently discovered wireless games.
   * Updated automatically by GetBroadcastData (0x18) command processing.
   *
   * @returns {Array<{hostId:string, gameInfo:number[]}>}
   */
  get rfuGames() {
    return this._rfuGames.slice();
  }

  /**
   * Return true while the emulator frame is stalled waiting for an RFU
   * network packet from the connected peer.  When true, retroRun() will not
   * advance the emulator so the game cannot make progress past the current
   * command until the data round-trip completes.
   */
  get frameStalled() {
    return this._frameStalled;
  }

  /**
   * Return the SharedArrayBuffer used as the SIO register mirror, or null
   * if SharedArrayBuffer is unavailable in this environment.  The buffer is
   * backed by an Int32Array with SIO_SAB_SLOTS (8) slots:
   *   0 SIOMULTI0, 1 SIOMULTI1, 2 SIOMULTI2, 3 SIOMULTI3,
   *   4 SIOCNT,    5 SIODATA8,  6 IE,         7 IF
   *
   * Consumers on other threads should use Atomics.load() to read values.
   *
   * @returns {SharedArrayBuffer|null}
   */
  get sioSharedBuffer() {
    return this._sioSab;
  }

  /**
   * Start the per-frame SIO register polling loop.
   *
   * Uses requestAnimationFrame (~60 Hz) to detect SIOMLT_SEND changes and
   * SIOCNT START-bit edges.  On detection it triggers a PeerJS exchange
   * (or the onSioTransfer callback) and injects the result.
   *
   * Safe to call multiple times – duplicate calls are ignored.
   */
  startPolling() {
    if (this._polling) return;
    this._polling = true;
    this._scheduleNextFrame();
    console.log('[MgbaBridge] SIO polling started');
  }

  /**
   * Stop the per-frame SIO polling loop.
   * Any in-flight exchange is allowed to complete; future frames are skipped.
   */
  stopPolling() {
    this._polling = false;
    if (this._rafHandle != null) {
      cancelAnimationFrame(this._rafHandle);
      this._rafHandle = null;
    }
    console.log('[MgbaBridge] SIO polling stopped');
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /** Schedule the next animation frame poll tick. */
  _scheduleNextFrame() {
    if (!this._polling) return;
    this._rafHandle = requestAnimationFrame(() => {
      this._pollCycle();
      this._scheduleNextFrame();
    });
  }

  /**
   * One polling cycle – called every animation frame.
   *
   * Reads SIOMLT_SEND and SIOCNT; on detecting a new transfer (either a
   * change in the send word or a START-bit rising edge) initiates the
   * PeerJS / callback exchange and injects the result.
   *
   * When SIOCNT reports NORMAL_32BIT mode (bits 12-13 = 01) the call is
   * forwarded to _rfuPollCycle() which implements the Wireless Adapter
   * command-response state machine instead of the multiplay path.
   */
  _pollCycle() {
    if (!this.ready || this._transferInProgress) return;

    // Refresh HEAPU16 in case Emscripten grew the WASM memory
    this._ensureHeap16();
    const heap16 = this._getHeap16();
    if (!heap16) return;

    const base      = this._ioBase;
    const sendIdx   = (base + 0x12A) >>> 1;
    const siocntIdx = (base + 0x128) >>> 1;
    const rcntIdx   = (base + 0x134) >>> 1;

    if (siocntIdx >= heap16.length || sendIdx >= heap16.length) return;

    const siocnt = heap16[siocntIdx];
    const rcnt   = rcntIdx < heap16.length ? heap16[rcntIdx] : 0;

    // ── RFU / Wireless Adapter detection ─────────────────────────────────
    // SIOCNT bits 12-13 = 01 → NORMAL_32BIT mode.
    // RCNT bit 15 = 0 → SIO mode (not GPIO/JOY BUS).
    // If these conditions hold, the game may be talking to the RFU adapter.
    const modeBits = (siocnt >> 12) & 0x03;
    if (modeBits === 0x01 && !(rcnt & 0x8000)) {
      this._rfuPollCycle(heap16, siocnt, siocntIdx, base);
      this._lastSiocnt32 = siocnt;
      return;
    }

    // ── Multiplay path (original logic) ──────────────────────────────────
    const sendWord  = heap16[sendIdx];

    // Detect START bit edge (0→1) or SIOMLT_SEND change
    const startEdge   = !!(siocnt & 0x0080);
    const sendChanged = this._lastSendWord >= 0 && sendWord !== this._lastSendWord;

    if (!startEdge && !sendChanged) {
      this._lastSendWord = sendWord;
      return;
    }

    this._lastSendWord       = sendWord;
    this._transferInProgress = true;
    this._transferId         = (this._transferId + 1) & 0xFFFF;
    const xferId             = this._transferId;

    // Prefer wired PeerLinkCable (direct P2P) over the generic callback
    const peerExchange = this._peer?.connected
      ? this._peer.exchangeWord(sendWord, xferId)
      : null;

    const exchangePromise = peerExchange
      ?? (this._onSioTransfer
          ? Promise.resolve(this._onSioTransfer(sendWord, xferId))
          : Promise.resolve([0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF]));

    exchangePromise
      .then((words) => {
        this.injectSioData(words);
        this._transferInProgress = false;
      })
      .catch(() => {
        this._transferInProgress = false;
      });
  }

  // ── RFU Wireless Adapter state machine ───────────────────────────────────

  /**
   * RFU polling cycle – called from _pollCycle() when NORMAL_32BIT mode is
   * active.  Implements the GBA Wireless Adapter command-response protocol:
   *
   *   GBA  → Adapter: 0x9966CCLL (magic=0x9966, cmd=CC, data-words=LL)
   *   Adapter → GBA:  0x80CC0000 (ACK per word) or response data words
   *
   * Commands are processed synchronously where possible.  Network-dependent
   * commands (0x1C SendData, 0x1D RecvData) are handled asynchronously using
   * the wired PeerLinkCable instance.
   *
   * @param {Uint16Array} heap16
   * @param {number}      siocnt    – current SIOCNT value
   * @param {number}      siocntIdx – HEAPU16 index of SIOCNT
   * @param {number}      base      – GBA I/O base byte-offset
   * @private
   */
  _rfuPollCycle(heap16, siocnt, siocntIdx, base) {
    const multi0Idx = (base + 0x120) >>> 1; // SIODATA32 low
    if (multi0Idx + 1 >= heap16.length) return;

    const startBit  = !!(siocnt & 0x0080);
    const prevStart = !!(this._lastSiocnt32 & 0x0080);
    const startEdge = startBit && !prevStart; // 0 → 1 rising edge

    // ── Drain the response queue ────────────────────────────────────────────
    // If we have queued response words, deliver the next one to SIODATA32
    // whenever the GBA initiates a new transfer (START rising edge).
    if (startEdge && this._rfuRespQueue.length > 0) {
      const respWord = this._rfuRespQueue.shift();
      heap16[multi0Idx]     = respWord & 0xFFFF;
      heap16[multi0Idx + 1] = (respWord >>> 16) & 0xFFFF;
      // Clear START bit → transfer complete
      heap16[siocntIdx] = siocnt & ~0x0080;
      if (this._rfuRespQueue.length === 0) {
        this._rfuState = RFU_STATE.IDLE;
      }
      this._rfuFireIrq(heap16, base);
      return;
    }

    if (!startEdge) return; // Nothing to process

    // ── Read SIODATA32 (what the GBA just sent) ─────────────────────────────
    const lo    = heap16[multi0Idx];
    const hi    = heap16[multi0Idx + 1];
    const word32 = (hi << 16) | lo;

    if (this._rfuState === RFU_STATE.IDLE) {
      // Expect a command header: 0x9966CCLL
      if (hi === RFU_MAGIC) {
        this._rfuEnabled = true;
        this._rfuCmd     = (word32 >>> 8) & 0xFF;
        this._rfuDataLen = word32 & 0xFF;
        this._rfuData    = [];

        if (this._rfuDataLen === 0) {
          // No data words – process immediately
          this._processRfuCommand(heap16, siocntIdx, base);
        } else {
          // More data words to follow – ACK and wait
          this._rfuState = RFU_STATE.READING_DATA;
          this._rfuWriteAck(heap16, siocntIdx, base, this._rfuCmd);
        }
      } else {
        // Not an RFU command – return 0x00000000 (idle/ready state)
        heap16[multi0Idx]     = 0x0000;
        heap16[multi0Idx + 1] = 0x0000;
        heap16[siocntIdx] = siocnt & ~0x0080;
      }

    } else if (this._rfuState === RFU_STATE.READING_DATA) {
      // Accumulate data words
      this._rfuData.push(word32);

      if (this._rfuData.length >= this._rfuDataLen) {
        // All data collected – process the command
        this._processRfuCommand(heap16, siocntIdx, base);
      } else {
        // More data words expected – keep ACKing
        this._rfuWriteAck(heap16, siocntIdx, base, this._rfuCmd);
      }
    }
    // In PROCESSING state the _rfuPollCycle is re-entered when the GBA
    // polls again; the async handler will have populated _rfuRespQueue by then.
  }

  /**
   * Write an adapter ACK word to SIODATA32 and clear the START bit.
   * ACK format: 0x80CC0000 where CC = command being acknowledged.
   * @private
   */
  _rfuWriteAck(heap16, siocntIdx, base, cmd) {
    const multi0Idx = (base + 0x120) >>> 1;
    heap16[multi0Idx]     = 0x0000;
    // ACK high word: 0x80CC where CC = command
    heap16[multi0Idx + 1] = ((RFU_ACK_HIGH_BYTE << 8) | cmd) & 0xFFFF;
    heap16[siocntIdx] = heap16[siocntIdx] & ~0x0080;
    this._rfuFireIrq(heap16, base);
  }

  /**
   * Fire the Serial Communication IRQ (bit 7 of IF) so the GBA game's
   * SIO interrupt handler runs after each RFU adapter response.
   * @private
   */
  _rfuFireIrq(heap16, base) {
    const ifIdx = (base + 0x202) >>> 1;
    const ieIdx = (base + 0x200) >>> 1;
    if (ifIdx < heap16.length) heap16[ifIdx] |= (1 << 7);
    if (ieIdx < heap16.length) heap16[ieIdx] |= (1 << 7);
  }

  /**
   * Process a fully-received RFU command (header + all data words).
   *
   * Synchronous commands (reset, config, status, broadcast management) are
   * handled inline and queue their responses immediately.  Network-bound
   * commands (SendData 0x1C, RecvData 0x1D) are dispatched asynchronously
   * via the wired PeerLinkCable instance.
   *
   * @param {Uint16Array} heap16
   * @param {number}      siocntIdx
   * @param {number}      base
   * @private
   */
  _processRfuCommand(heap16, siocntIdx, base) {
    const cmd  = this._rfuCmd;
    const data = this._rfuData.slice();

    // Build the standard ACK word (0x80CC0000)
    const ack = (((RFU_ACK_HIGH_BYTE << 8) | cmd) << 16) >>> 0;

    this._rfuState = RFU_STATE.IDLE; // default; overridden for async ops

    switch (cmd) {

      // ── Reset / initialise ────────────────────────────────────────────────
      case RFU_CMD.SYSTEM_RESET:
        this._rfuBroadcast = [];
        this._rfuGames     = [];
        this._rfuRecvBuf   = [];
        this._rfuRespQueue = [ack];
        console.log('[MgbaBridge] RFU: System Reset');
        break;

      // ── SetConfig (0x11): initialise adapter and announce hardware type ─────
      // This is the first command sent by a game after the RFU magic exchange.
      // We immediately set _rfuEnabled so the multiplayer menu detects the
      // Wireless Adapter before any further commands are sent, and we return
      // the hardware identifier (RFU_ADAPTER_HW_ID = 0x0027) that Quetzal's
      // handshake code checks to display "Wireless Adapter" mode instantly.
      case RFU_CMD.SET_CONFIG:
        this._rfuEnabled  = true;
        this._rfuRespQueue = [ack, (RFU_ADAPTER_HW_ID << 16) >>> 0];
        console.log('[MgbaBridge] RFU: SetConfig – Wireless Adapter advertised');
        break;

      // ── ConfigStatus: echo back the current configuration ────────────────
      case RFU_CMD.CONFIG_STATUS:
        this._rfuRespQueue = [ack, ...(data.length ? data : [0x00000000])];
        break;

      // ── Game / adapter ID (return placeholder values) ────────────────────
      case RFU_CMD.GET_GAME_ID:
        // Returns: [ACK, gameId (4 bytes), adapterId (4 bytes)]
        this._rfuRespQueue = [ack, 0x00000001, 0x00000001];
        break;

      // ── Status queries ────────────────────────────────────────────────────
      case RFU_CMD.SYSTEM_STATUS:
      case RFU_CMD.SLOT_STATUS:
        this._rfuRespQueue = [ack, 0x00000000];
        break;

      // ── SetBroadcastData: store the host's game announcement ─────────────
      // data[0] is typically the game ID / name info encoded by the game ROM.
      // We store it locally and emit it to the RFU relay so other players
      // calling GetBroadcastData can discover this host.
      case RFU_CMD.SET_BROADCAST_DATA:
        this._rfuBroadcast = data;
        this._rfuRespQueue = [ack];
        if (this._rfuSocket?.connected) {
          const lobbyId = this._rfuLobbyId ?? window._rfuLobbyId;
          if (lobbyId) {
            this._rfuSocket.emit('rfu:host', { lobbyId, gameInfo: data });
          }
        }
        console.log('[MgbaBridge] RFU: SetBroadcastData', data);
        break;

      // ── StartBroadcast: create PeerJS room and register as host ──────────
      // The host calls 0x16 (SetBroadcastData) first to announce the game,
      // then 0x17 (StartBroadcast) to begin accepting connections.
      // We create a PeerJS room here so clients can connect directly.
      case RFU_CMD.START_BROADCAST:
        this._rfuRespQueue = [ack];
        if (this._peer && !this._peer.connected &&
            typeof this._peer.createRoom === 'function') {
          this._peer.createRoom()
            .then((peerId) => {
              // Broadcast the PeerJS room ID so clients can connect via rfu:search
              const lobbyId = this._rfuLobbyId ?? window._rfuLobbyId;
              if (this._rfuSocket?.connected && lobbyId) {
                this._rfuSocket.emit('rfu:host', {
                  lobbyId,
                  gameInfo: this._rfuBroadcast,
                  peerId,
                });
              }
              console.log('[MgbaBridge] RFU: hosting on PeerJS room', peerId);
            })
            .catch((e) => {
              console.warn('[MgbaBridge] RFU: PeerJS createRoom failed:', e.message);
            });
        }
        console.log('[MgbaBridge] RFU: StartBroadcast');
        break;

      // ── GetBroadcastData: return the list of available wireless games ─────
      // Returns up to 4 slots.  Each slot is 6 words (game header).
      // We use the cached _rfuGames list (refreshed from Socket.io) and
      // schedule an async refresh for future polls.
      case RFU_CMD.GET_BROADCAST_DATA: {
        const games    = this._rfuGames.slice(0, 4);
        const response = [ack];
        for (let i = 0; i < 4; i++) {
          const g = games[i];
          if (g && Array.isArray(g.gameInfo)) {
            // Pad / truncate to exactly 6 words per slot
            for (let j = 0; j < 6; j++) {
              response.push((g.gameInfo[j] ?? 0) >>> 0);
            }
          } else {
            // Empty slot: 6 zero words
            response.push(0, 0, 0, 0, 0, 0);
          }
        }
        this._rfuRespQueue = response;
        // Trigger an async refresh for future GetBroadcastData calls
        this._rfuRefreshGames();
        console.log('[MgbaBridge] RFU: GetBroadcastData', games.length, 'games');
        break;
      }

      // ── Authentication start: ACK + dummy auth sequence ──────────────────
      case RFU_CMD.AUTH_START:
        this._rfuRespQueue = [ack, 0x00000000, 0x00000000];
        break;

      // ── AcceptConnections / Connect: join the host's PeerJS room ─────────
      // data[0] encodes the target slot index from the GetBroadcastData list.
      // We use the stored peerId (supplied by the host via rfu:host) to
      // establish a direct PeerJS P2P DataChannel for subsequent data exchange.
      case RFU_CMD.ACCEPT_CONNECTIONS: {
        this._rfuRespQueue = [ack];
        const slotIdx    = (data[0] ?? 0) & 0xFF;
        const targetGame = this._rfuGames[slotIdx] || this._rfuGames[0];
        if (targetGame?.peerId && this._peer &&
            typeof this._peer.joinRoom === 'function') {
          this._peer.joinRoom(targetGame.peerId)
            .then(() => {
              console.log('[MgbaBridge] RFU: joined PeerJS room', targetGame.peerId);
            })
            .catch((e) => {
              console.warn('[MgbaBridge] RFU: PeerJS joinRoom failed:', e.message);
            });
        }
        console.log('[MgbaBridge] RFU: AcceptConnections slot', slotIdx, targetGame);
        break;
      }

      // ── EndSession / Reconnect ────────────────────────────────────────────
      case RFU_CMD.END_SESSION:
      case RFU_CMD.RECONNECT:
        this._rfuRespQueue = [ack];
        break;

      // ── SendData: relay packet to connected PeerJS peer ──────────────────
      // Set _frameStalled to stall the emulator until the peer data arrives;
      // cleared on both resolve and reject to prevent a permanent stall.
      case RFU_CMD.SEND_DATA:
        this._rfuRespQueue = [ack];
        if (this._peer?.connected && typeof this._peer.exchangeRfuPacket === 'function') {
          this._transferInProgress = true;
          this._rfuState    = RFU_STATE.PROCESSING;
          this._frameStalled = true;
          this._peer.exchangeRfuPacket({ cmd, data })
            .then((resp) => {
              if (Array.isArray(resp?.data) && resp.data.length > 0) {
                this._rfuRecvBuf = resp.data.slice(0, RFU_RECV_BUF_MAX);
              }
              this._rfuState        = RFU_STATE.IDLE;
              this._transferInProgress = false;
              this._frameStalled    = false;
            })
            .catch(() => {
              this._rfuState        = RFU_STATE.IDLE;
              this._transferInProgress = false;
              this._frameStalled    = false;
            });
        } else {
          const lobbyId = this._rfuLobbyId ?? window._rfuLobbyId;
          if (this._rfuSocket?.connected && lobbyId) {
            // Fallback: relay via Socket.io
            this._rfuSocket.emit('rfu:data', {
              lobbyId,
              packet: data,
            });
          }
        }
        console.log('[MgbaBridge] RFU: SendData', data.length, 'words');
        break;

      // ── RecvData: deliver the latest buffered data to the GBA ────────────
      case RFU_CMD.RECEIVE_DATA: {
        const buf      = this._rfuRecvBuf;
        const response = [ack];
        // Encode data length in the ACK word (low byte)
        const lenWord  = (((RFU_ACK_HIGH_BYTE << 8) | cmd) << 16 | (buf.length & 0xFF)) >>> 0;
        response[0] = lenWord;
        response.push(...buf);
        this._rfuRespQueue = response;
        this._rfuRecvBuf   = [];
        console.log('[MgbaBridge] RFU: RecvData', buf.length, 'words');
        break;
      }

      // ── Wait: return ACK with current connection status ───────────────────
      case RFU_CMD.WAIT:
        this._rfuRespQueue = [ack, this._peer?.connected ? 0x00000001 : 0x00000000];
        break;

      // ── Unknown: generic ACK ──────────────────────────────────────────────
      default:
        this._rfuRespQueue = [ack];
        break;
    }

    // Write the first response word immediately if available
    if (this._rfuRespQueue.length > 0) {
      const multi0Idx = (base + 0x120) >>> 1;
      const resp      = this._rfuRespQueue.shift();
      heap16[multi0Idx]     = resp & 0xFFFF;
      heap16[multi0Idx + 1] = (resp >>> 16) & 0xFFFF;
      heap16[siocntIdx] = heap16[siocntIdx] & ~0x0080;
      this._rfuFireIrq(heap16, base);
      if (this._rfuRespQueue.length > 0) {
        this._rfuState = RFU_STATE.SENDING_RESPONSE;
      }
    }
  }

  /**
   * Async refresh of the games list from the RFU relay server.
   * Called automatically when the game sends GetBroadcastData (0x18).
   * @private
   */
  _rfuRefreshGames() {
    const lobbyId = this._rfuLobbyId ?? window._rfuLobbyId;
    if (!this._rfuSocket?.connected || !lobbyId) return;
    this._rfuSocket.emit('rfu:search', { lobbyId }, (res) => {
      if (Array.isArray(res?.games)) {
        this._rfuGames = res.games;
        console.log('[MgbaBridge] RFU: discovered', res.games.length, 'game(s)');
      }
    });
  }

  /**
   * Handle a data packet pushed to us by the peer via PeerJS.
   * Called by peerLinkCable.js when an unsolicited 'rfu' message arrives
   * (e.g. the host pushing game data before we poll RecvData 0x1D).
   *
   * @param {{ cmd: number, data: number[] }} packet
   */
  _rfuOnPeerData(packet) {
    if (Array.isArray(packet?.data) && packet.data.length > 0) {
      // Enforce buffer size cap: drop oldest words if the peer is sending
      // faster than the GBA polls RecvData (0x1D).
      const trimmed = packet.data.slice(0, RFU_RECV_BUF_MAX);
      this._rfuRecvBuf = trimmed;
    }
  }

  /**
   * Ensure HEAPU16 is present and backed by the current WASM memory buffer.
   * Emscripten may grow the heap (replacing HEAPU8's buffer); we must
   * re-derive HEAPU16 whenever that happens to avoid stale typed-array views.
   * @private
   */
  _ensureHeap16() {
    const mod = this._mod;
    if (!mod) return;
    if (!mod.HEAPU16 || (mod.HEAPU8 && mod.HEAPU16.buffer !== mod.HEAPU8.buffer)) {
      if (mod.HEAPU8) {
        mod.HEAPU16 = new Uint16Array(mod.HEAPU8.buffer);
      }
    }
  }

  /** Return the current HEAPU16 view, or null. @private */
  _getHeap16() {
    this._ensureHeap16();
    return this._mod?.HEAPU16 ?? null;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────
// Exposed as window.MgbaBridge so game.js, peerLinkCable.js, and any
// browser console script can access the bridge without module bundling.
window.MgbaBridge = new MgbaBridgeImpl();
