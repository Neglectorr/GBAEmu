'use strict';
/**
 * test/mgbaBridge.test.js
 *
 * Tests for public/js/mgbaBridge.js
 *
 * These tests run in Node.js (no browser) and use a lightweight mock of the
 * browser globals (window, requestAnimationFrame, cancelAnimationFrame).
 * They validate:
 *   – module structure and exported API
 *   – retro_run wrapper behaviour
 *   – SIO register read / write helpers
 *   – PeerLinkCable wiring
 *   – per-frame polling logic
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const bridgeSrc = fs.readFileSync(
  path.join(__dirname, '../public/js/mgbaBridge.js'),
  'utf8'
);

// ── Minimal browser-environment shim ───────────────────────────────────────
// mgbaBridge.js writes to window.MgbaBridge and uses requestAnimationFrame.
// We provide a minimal shim so the module can be eval'd in Node.

function makeBrowserShim() {
  const window = {};
  let _nextRafId = 1;
  const _rafQueue = new Map();

  window.requestAnimationFrame  = (cb) => {
    const id = _nextRafId++;
    _rafQueue.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    _rafQueue.delete(id);
  };

  // Flush all pending requestAnimationFrame callbacks once
  window._flushRaf = () => {
    const entries = [..._rafQueue.entries()];
    _rafQueue.clear();
    for (const [, cb] of entries) cb(performance.now());
  };

  return window;
}

// Evaluate the bridge source inside a fresh window context
function loadBridge(win) {
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'window', 'requestAnimationFrame', 'cancelAnimationFrame',
    bridgeSrc + '\n//# sourceURL=mgbaBridge.js'
  );
  fn(win, win.requestAnimationFrame, win.cancelAnimationFrame);
  return win.MgbaBridge;
}

// Build a minimal fake Emscripten WASM module with a heap of `size` bytes
function makeFakeModule(size = 4096) {
  const buffer = new ArrayBuffer(size);
  const mod = {
    HEAPU8:  new Uint8Array(buffer),
    HEAPU16: new Uint16Array(buffer),
  };
  // Minimal cwrap: only wraps 'retro_run' → no-op function
  let retroRunCallCount = 0;
  mod.cwrap = (name, retType, argTypes) => {
    if (name === 'retro_run') {
      return () => { retroRunCallCount++; };
    }
    throw new Error(`Unknown function: ${name}`);
  };
  mod._retroRunCallCount = () => retroRunCallCount;
  return mod;
}

// Helper: write a 16-bit value to the fake heap at a byte offset
function heap16Write(mod, byteOffset, value) {
  mod.HEAPU16[byteOffset >>> 1] = value & 0xFFFF;
}

// Helper: read a 16-bit value from the fake heap at a byte offset
function heap16Read(mod, byteOffset) {
  return mod.HEAPU16[byteOffset >>> 1];
}

// ─── Source file checks ────────────────────────────────────────────────────
describe('mgbaBridge.js – source file', () => {
  it('file exists', () => {
    assert.ok(
      fs.existsSync(path.join(__dirname, '../public/js/mgbaBridge.js')),
      'mgbaBridge.js must exist in public/js/'
    );
  });

  it('assigns window.MgbaBridge', () => {
    assert.ok(
      bridgeSrc.includes('window.MgbaBridge'),
      'mgbaBridge.js must assign the singleton to window.MgbaBridge'
    );
  });

  it('defines MgbaBridgeImpl class', () => {
    assert.ok(
      bridgeSrc.includes('class MgbaBridgeImpl'),
      'mgbaBridge.js must define MgbaBridgeImpl'
    );
  });
});

// ─── Public API surface ────────────────────────────────────────────────────
describe('mgbaBridge.js – public API', () => {
  it('defines init()', () => {
    assert.ok(bridgeSrc.includes('init('), 'must define init()');
  });

  it('defines retroRun()', () => {
    assert.ok(bridgeSrc.includes('retroRun()'), 'must define retroRun()');
  });

  it('defines readSioRegisters()', () => {
    assert.ok(bridgeSrc.includes('readSioRegisters()'), 'must define readSioRegisters()');
  });

  it('defines injectSioData()', () => {
    assert.ok(bridgeSrc.includes('injectSioData('), 'must define injectSioData()');
  });

  it('defines onSioTransfer()', () => {
    assert.ok(bridgeSrc.includes('onSioTransfer('), 'must define onSioTransfer()');
  });

  it('defines connectPeer()', () => {
    assert.ok(bridgeSrc.includes('connectPeer('), 'must define connectPeer()');
  });

  it('defines disconnectPeer()', () => {
    assert.ok(bridgeSrc.includes('disconnectPeer()'), 'must define disconnectPeer()');
  });

  it('defines startPolling()', () => {
    assert.ok(bridgeSrc.includes('startPolling()'), 'must define startPolling()');
  });

  it('defines stopPolling()', () => {
    assert.ok(bridgeSrc.includes('stopPolling()'), 'must define stopPolling()');
  });

  it('uses cwrap to wrap retro_run', () => {
    assert.ok(
      bridgeSrc.includes("cwrap('retro_run'") || bridgeSrc.includes('cwrap("retro_run"'),
      'must call cwrap("retro_run", …) to wrap the libretro frame-advance function'
    );
  });
});

// ─── GBA SIO register offsets ─────────────────────────────────────────────
describe('mgbaBridge.js – GBA SIO register offsets', () => {
  it('uses SIOMULTI0 at offset 0x120', () => {
    assert.ok(bridgeSrc.includes('0x120'), 'must reference SIOMULTI0 at 0x120');
  });

  it('uses SIOCNT at offset 0x128', () => {
    assert.ok(bridgeSrc.includes('0x128'), 'must reference SIOCNT at 0x128');
  });

  it('uses SIODATA8 / SIOMLT_SEND at offset 0x12A', () => {
    assert.ok(bridgeSrc.includes('0x12A'), 'must reference SIODATA8 at 0x12A');
  });

  it('uses IF register at offset 0x202', () => {
    assert.ok(bridgeSrc.includes('0x202'), 'must reference IF at 0x202');
  });

  it('uses IE register at offset 0x200', () => {
    assert.ok(bridgeSrc.includes('0x200'), 'must reference IE at 0x200');
  });
});

// ─── init() behaviour ─────────────────────────────────────────────────────
describe('mgbaBridge.js – init()', () => {
  let win, bridge;

  beforeEach(() => {
    win    = makeBrowserShim();
    bridge = loadBridge(win);
  });

  it('ready is false before init', () => {
    assert.strictEqual(bridge.ready, false);
  });

  it('ready becomes true after init with valid args', () => {
    const mod = makeFakeModule();
    bridge.init(mod, 0x1000);
    assert.strictEqual(bridge.ready, true);
  });

  it('ioBase is accessible after init', () => {
    const mod = makeFakeModule();
    bridge.init(mod, 0x2000);
    assert.strictEqual(bridge.ioBase, 0x2000);
  });

  it('throws when wasmModule is missing', () => {
    assert.throws(() => bridge.init(null, 0), /wasmModule/);
  });

  it('throws when ioBase is not a number', () => {
    assert.throws(() => bridge.init(makeFakeModule(), 'bad'), /ioBase/);
  });

  it('derives HEAPU16 from HEAPU8 when HEAPU16 is absent', () => {
    const buf  = new ArrayBuffer(4096);
    const mod  = { HEAPU8: new Uint8Array(buf) };
    mod.cwrap  = () => () => {};
    bridge.init(mod, 0x0);
    assert.ok(mod.HEAPU16 instanceof Uint16Array, 'HEAPU16 must be derived from HEAPU8');
    assert.strictEqual(mod.HEAPU16.buffer, mod.HEAPU8.buffer);
  });
});

// ─── retroRun() ───────────────────────────────────────────────────────────
describe('mgbaBridge.js – retroRun()', () => {
  let win, bridge;

  beforeEach(() => {
    win    = makeBrowserShim();
    bridge = loadBridge(win);
  });

  it('returns false before init', () => {
    assert.strictEqual(bridge.retroRun(), false);
  });

  it('calls the cwrap-wrapped retro_run and returns true', () => {
    const mod = makeFakeModule();
    bridge.init(mod, 0x0);
    const result = bridge.retroRun();
    assert.strictEqual(result, true);
    assert.strictEqual(mod._retroRunCallCount(), 1);
  });

  it('calling retroRun() multiple times increments the call count', () => {
    const mod = makeFakeModule();
    bridge.init(mod, 0x0);
    bridge.retroRun();
    bridge.retroRun();
    bridge.retroRun();
    assert.strictEqual(mod._retroRunCallCount(), 3);
  });

  it('returns false when cwrap is unavailable', () => {
    const buf = new ArrayBuffer(4096);
    const mod = {
      HEAPU8:  new Uint8Array(buf),
      HEAPU16: new Uint16Array(buf),
    };
    // No cwrap function
    bridge.init(mod, 0x0);
    assert.strictEqual(bridge.retroRun(), false);
  });
});

// ─── readSioRegisters() ───────────────────────────────────────────────────
describe('mgbaBridge.js – readSioRegisters()', () => {
  let win, bridge;

  beforeEach(() => {
    win    = makeBrowserShim();
    bridge = loadBridge(win);
  });

  it('returns null before init', () => {
    assert.strictEqual(bridge.readSioRegisters(), null);
  });

  it('returns an object with all SIO register fields', () => {
    const mod    = makeFakeModule(8192);
    const ioBase = 0x0400;
    bridge.init(mod, ioBase);

    const regs = bridge.readSioRegisters();
    assert.ok(regs, 'must return a register snapshot');
    assert.ok('siocnt'   in regs, 'must have siocnt');
    assert.ok('siodata8' in regs, 'must have siodata8');
    assert.ok(Array.isArray(regs.siomulti), 'must have siomulti array');
    assert.strictEqual(regs.siomulti.length, 4, 'siomulti must have 4 elements');
    assert.ok('rcnt'  in regs, 'must have rcnt');
    assert.ok('ie'    in regs, 'must have ie');
    assert.ok('ifReg' in regs, 'must have ifReg');
  });

  it('reads the correct value written to SIOCNT', () => {
    const mod    = makeFakeModule(8192);
    const ioBase = 0x0400;
    bridge.init(mod, ioBase);

    heap16Write(mod, ioBase + 0x128, 0x5083); // some SIOCNT value
    const regs = bridge.readSioRegisters();
    assert.strictEqual(regs.siocnt, 0x5083);
  });

  it('reads SIODATA8 / SIOMLT_SEND', () => {
    const mod    = makeFakeModule(8192);
    const ioBase = 0x0400;
    bridge.init(mod, ioBase);

    heap16Write(mod, ioBase + 0x12A, 0xABCD);
    const regs = bridge.readSioRegisters();
    assert.strictEqual(regs.siodata8, 0xABCD);
  });

  it('reads all four SIOMULTI registers', () => {
    const mod    = makeFakeModule(8192);
    const ioBase = 0x0400;
    bridge.init(mod, ioBase);

    heap16Write(mod, ioBase + 0x120, 0x1111);
    heap16Write(mod, ioBase + 0x122, 0x2222);
    heap16Write(mod, ioBase + 0x124, 0x3333);
    heap16Write(mod, ioBase + 0x126, 0x4444);

    const regs = bridge.readSioRegisters();
    assert.deepStrictEqual(regs.siomulti, [0x1111, 0x2222, 0x3333, 0x4444]);
  });
});

// ─── injectSioData() ──────────────────────────────────────────────────────
describe('mgbaBridge.js – injectSioData()', () => {
  let win, bridge;

  beforeEach(() => {
    win    = makeBrowserShim();
    bridge = loadBridge(win);
  });

  it('is a no-op before init', () => {
    assert.doesNotThrow(() => bridge.injectSioData([1, 2, 3, 4]));
  });

  it('writes all four words to SIOMULTI0-3', () => {
    const mod    = makeFakeModule(8192);
    const ioBase = 0x0400;
    bridge.init(mod, ioBase);

    bridge.injectSioData([0xAAAA, 0xBBBB, 0xCCCC, 0xDDDD]);

    assert.strictEqual(heap16Read(mod, ioBase + 0x120), 0xAAAA);
    assert.strictEqual(heap16Read(mod, ioBase + 0x122), 0xBBBB);
    assert.strictEqual(heap16Read(mod, ioBase + 0x124), 0xCCCC);
    assert.strictEqual(heap16Read(mod, ioBase + 0x126), 0xDDDD);
  });

  it('truncates values to 16 bits', () => {
    const mod    = makeFakeModule(8192);
    const ioBase = 0x0400;
    bridge.init(mod, ioBase);

    bridge.injectSioData([0x1FFFF, 0, 0, 0]);
    assert.strictEqual(heap16Read(mod, ioBase + 0x120), 0xFFFF);
  });

  it('sets bit 7 in IF (SIO IRQ)', () => {
    const mod    = makeFakeModule(8192);
    const ioBase = 0x0400;
    bridge.init(mod, ioBase);

    heap16Write(mod, ioBase + 0x202, 0x0000); // clear IF
    bridge.injectSioData([0, 0, 0, 0]);

    const ifVal = heap16Read(mod, ioBase + 0x202);
    assert.ok((ifVal & 0x0080) !== 0, 'bit 7 (SIO IRQ) must be set in IF');
  });

  it('sets bit 7 in IE (SIO IRQ enable)', () => {
    const mod    = makeFakeModule(8192);
    const ioBase = 0x0400;
    bridge.init(mod, ioBase);

    heap16Write(mod, ioBase + 0x200, 0x0000); // clear IE
    bridge.injectSioData([0, 0, 0, 0]);

    const ieVal = heap16Read(mod, ioBase + 0x200);
    assert.ok((ieVal & 0x0080) !== 0, 'bit 7 (SIO IRQ enable) must be set in IE');
  });

  it('uses 0xFFFF for undefined/null words', () => {
    const mod    = makeFakeModule(8192);
    const ioBase = 0x0400;
    bridge.init(mod, ioBase);

    bridge.injectSioData([undefined, null, undefined, null]);
    assert.strictEqual(heap16Read(mod, ioBase + 0x120), 0xFFFF);
    assert.strictEqual(heap16Read(mod, ioBase + 0x122), 0xFFFF);
  });
});

// ─── onSioTransfer() callback ─────────────────────────────────────────────
describe('mgbaBridge.js – onSioTransfer() callback', () => {
  it('stores the callback', () => {
    const win    = makeBrowserShim();
    const bridge = loadBridge(win);
    const cb     = () => Promise.resolve([0, 0, 0, 0]);
    bridge.onSioTransfer(cb);
    assert.strictEqual(bridge._onSioTransfer, cb);
  });
});

// ─── connectPeer() / disconnectPeer() ─────────────────────────────────────
describe('mgbaBridge.js – connectPeer() / disconnectPeer()', () => {
  let win, bridge;

  beforeEach(() => {
    win    = makeBrowserShim();
    bridge = loadBridge(win);
  });

  it('peer is null initially', () => {
    assert.strictEqual(bridge.peer, null);
  });

  it('connectPeer() stores the peer', () => {
    const fakePeer = { connected: false };
    bridge.connectPeer(fakePeer);
    assert.strictEqual(bridge.peer, fakePeer);
  });

  it('disconnectPeer() sets peer to null', () => {
    bridge.connectPeer({ connected: false });
    bridge.disconnectPeer();
    assert.strictEqual(bridge.peer, null);
  });
});

// ─── startPolling() / stopPolling() ───────────────────────────────────────
describe('mgbaBridge.js – startPolling() / stopPolling()', () => {
  let win, bridge;

  beforeEach(() => {
    win    = makeBrowserShim();
    bridge = loadBridge(win);
  });

  it('startPolling() sets the polling flag', () => {
    bridge.startPolling();
    assert.strictEqual(bridge._polling, true);
    bridge.stopPolling();
  });

  it('startPolling() registers a requestAnimationFrame callback', () => {
    bridge.startPolling();
    // At least one RAF should have been registered
    assert.ok(bridge._rafHandle != null, 'rafHandle must be set after startPolling');
    bridge.stopPolling();
  });

  it('stopPolling() clears the polling flag', () => {
    bridge.startPolling();
    bridge.stopPolling();
    assert.strictEqual(bridge._polling, false);
  });

  it('stopPolling() cancels the RAF', () => {
    bridge.startPolling();
    bridge.stopPolling();
    assert.strictEqual(bridge._rafHandle, null);
  });

  it('duplicate startPolling() calls are safe (only one loop)', () => {
    bridge.startPolling();
    const handle1 = bridge._rafHandle;
    bridge.startPolling(); // should be ignored
    assert.strictEqual(bridge._rafHandle, handle1, 'second startPolling should not replace the RAF handle');
    bridge.stopPolling();
  });
});

// ─── Polling cycle – SIO transfer detection ───────────────────────────────
describe('mgbaBridge.js – polling cycle (SIO transfer detection)', () => {
  let win, bridge;

  beforeEach(() => {
    win    = makeBrowserShim();
    bridge = loadBridge(win);
  });

  afterEach(() => {
    bridge.stopPolling();
  });

  it('fires onSioTransfer when SIOMLT_SEND changes', async () => {
    const mod    = makeFakeModule(8192);
    const ioBase = 0x0400;
    bridge.init(mod, ioBase);

    let capturedWord = null;
    bridge.onSioTransfer((sendWord) => {
      capturedWord = sendWord;
      return Promise.resolve([sendWord, 0xFFFF, 0xFFFF, 0xFFFF]);
    });

    // Seed lastSendWord so first change is detected
    heap16Write(mod, ioBase + 0x12A, 0x0042);
    bridge.startPolling();
    win._flushRaf(); // run one poll cycle to seed lastSendWord
    await new Promise(r => setTimeout(r, 0)); // allow microtasks

    // Now change SIOMLT_SEND
    heap16Write(mod, ioBase + 0x12A, 0x0099);
    win._flushRaf();
    await new Promise(r => setTimeout(r, 10));

    assert.strictEqual(capturedWord, 0x0099, 'onSioTransfer must receive the new SIOMLT_SEND value');
  });

  it('injects received words into SIOMULTI after exchange', async () => {
    const mod    = makeFakeModule(8192);
    const ioBase = 0x0400;
    bridge.init(mod, ioBase);

    bridge.onSioTransfer(() =>
      Promise.resolve([0x1234, 0x5678, 0x9ABC, 0xDEF0])
    );

    // Seed, then change SIOMLT_SEND to trigger a transfer
    heap16Write(mod, ioBase + 0x12A, 0x0001);
    bridge.startPolling();
    win._flushRaf();
    await new Promise(r => setTimeout(r, 0));

    heap16Write(mod, ioBase + 0x12A, 0x0002);
    win._flushRaf();
    // Let the Promise resolve
    await new Promise(r => setTimeout(r, 20));

    assert.strictEqual(heap16Read(mod, ioBase + 0x120), 0x1234, 'SIOMULTI0 must match injected P0 word');
    assert.strictEqual(heap16Read(mod, ioBase + 0x122), 0x5678, 'SIOMULTI1 must match injected P1 word');
  });

  it('prefers PeerLinkCable.exchangeWord over onSioTransfer when peer is connected', async () => {
    const mod    = makeFakeModule(8192);
    const ioBase = 0x0400;
    bridge.init(mod, ioBase);

    let peerCalled    = false;
    let callbackCalled = false;

    const fakePeer = {
      connected: true,
      exchangeWord: (word, id) => {
        peerCalled = true;
        return Promise.resolve([word, 0xFFFF, 0xFFFF, 0xFFFF]);
      },
    };
    bridge.connectPeer(fakePeer);
    bridge.onSioTransfer(() => {
      callbackCalled = true;
      return Promise.resolve([0, 0, 0, 0]);
    });

    heap16Write(mod, ioBase + 0x12A, 0x0010);
    bridge.startPolling();
    win._flushRaf();
    await new Promise(r => setTimeout(r, 0));

    heap16Write(mod, ioBase + 0x12A, 0x0020);
    win._flushRaf();
    await new Promise(r => setTimeout(r, 20));

    assert.strictEqual(peerCalled, true,    'PeerLinkCable.exchangeWord must be called');
    assert.strictEqual(callbackCalled, false, 'onSioTransfer callback must NOT be called when peer is connected');
  });
});

// ─── game.js integration ──────────────────────────────────────────────────
describe('game.js – MgbaBridge integration', () => {
  const gameJs = fs.readFileSync(
    path.join(__dirname, '../public/js/game.js'),
    'utf8'
  );

  it('installRegisterInterceptor calls MgbaBridge.init()', () => {
    const idx = gameJs.indexOf('function installRegisterInterceptor(');
    assert.ok(idx !== -1, 'installRegisterInterceptor must exist');
    const body = gameJs.substring(idx, idx + 1200);
    assert.ok(
      body.includes('MgbaBridge') && body.includes('.init('),
      'installRegisterInterceptor must call window.MgbaBridge.init()'
    );
  });

  it('installRegisterInterceptor wires MgbaBridge to PeerLinkCable', () => {
    const idx = gameJs.indexOf('function installRegisterInterceptor(');
    assert.ok(idx !== -1);
    const body = gameJs.substring(idx, idx + 1200);
    assert.ok(
      body.includes('MgbaBridge') && body.includes('connectPeer'),
      'installRegisterInterceptor must call MgbaBridge.connectPeer(PeerLinkCable)'
    );
  });
});

// ─── game.html integration ────────────────────────────────────────────────
describe('game.html – MgbaBridge integration', () => {
  const gameHtml = fs.readFileSync(
    path.join(__dirname, '../public/game.html'),
    'utf8'
  );

  it('includes mgbaBridge.js', () => {
    assert.ok(
      gameHtml.includes('mgbaBridge.js'),
      'game.html must include mgbaBridge.js'
    );
  });

  it('includes mgbaBridge.js after peerLinkCable.js', () => {
    const peerLcIdx = gameHtml.indexOf('peerLinkCable.js');
    const bridgeIdx = gameHtml.indexOf('mgbaBridge.js');
    assert.ok(peerLcIdx !== -1 && bridgeIdx !== -1);
    assert.ok(
      peerLcIdx < bridgeIdx,
      'peerLinkCable.js must be included before mgbaBridge.js'
    );
  });

  it('includes mgbaBridge.js before game.js', () => {
    const bridgeIdx = gameHtml.indexOf('mgbaBridge.js');
    const gameJsIdx = gameHtml.indexOf('game.js');
    assert.ok(bridgeIdx !== -1 && gameJsIdx !== -1);
    assert.ok(
      bridgeIdx < gameJsIdx,
      'mgbaBridge.js must be included before game.js'
    );
  });
});

// ─── RFU Wireless Adapter – source file structure ────────────────────────────
describe('mgbaBridge.js – RFU Wireless Adapter constants', () => {
  it('defines RFU_MAGIC = 0x9966', () => {
    assert.ok(
      bridgeSrc.includes('RFU_MAGIC') && bridgeSrc.includes('0x9966'),
      'mgbaBridge.js must define RFU_MAGIC = 0x9966'
    );
  });

  it('defines RFU_CMD object with key commands', () => {
    assert.ok(bridgeSrc.includes('RFU_CMD'), 'must define RFU_CMD');
    assert.ok(bridgeSrc.includes('SET_BROADCAST_DATA'), 'must define SET_BROADCAST_DATA (0x16)');
    assert.ok(bridgeSrc.includes('START_BROADCAST'),    'must define START_BROADCAST (0x17)');
    assert.ok(bridgeSrc.includes('GET_BROADCAST_DATA'), 'must define GET_BROADCAST_DATA (0x18)');
    assert.ok(bridgeSrc.includes('ACCEPT_CONNECTIONS'), 'must define ACCEPT_CONNECTIONS (0x1A)');
    assert.ok(bridgeSrc.includes('SEND_DATA'),          'must define SEND_DATA (0x1C)');
    assert.ok(bridgeSrc.includes('RECEIVE_DATA'),       'must define RECEIVE_DATA (0x1D)');
  });

  it('defines RFU_STATE machine states', () => {
    assert.ok(bridgeSrc.includes('RFU_STATE'), 'must define RFU_STATE');
    assert.ok(bridgeSrc.includes('IDLE'),      'must define IDLE state');
    assert.ok(bridgeSrc.includes('READING_DATA'), 'must define READING_DATA state');
    assert.ok(bridgeSrc.includes('PROCESSING'),   'must define PROCESSING state');
    assert.ok(bridgeSrc.includes('SENDING_RESPONSE'), 'must define SENDING_RESPONSE state');
  });

  it('defines setRfuSocket() public method', () => {
    assert.ok(
      bridgeSrc.includes('setRfuSocket('),
      'mgbaBridge.js must define setRfuSocket() to wire the /rfu namespace'
    );
  });

  it('defines rfuActive getter', () => {
    assert.ok(
      bridgeSrc.includes('get rfuActive()'),
      'mgbaBridge.js must expose rfuActive getter'
    );
  });

  it('defines rfuGames getter', () => {
    assert.ok(
      bridgeSrc.includes('get rfuGames()'),
      'mgbaBridge.js must expose rfuGames getter for discovered wireless games'
    );
  });
});

// ─── RFU Wireless Adapter – _rfuPollCycle ─────────────────────────────────────
describe('mgbaBridge.js – RFU poll cycle', () => {
  it('_pollCycle checks NORMAL_32BIT mode (modeBits === 0x01) and delegates to _rfuPollCycle', () => {
    assert.ok(
      bridgeSrc.includes('_rfuPollCycle'),
      'mgbaBridge.js must call _rfuPollCycle for NORMAL_32BIT SIO mode'
    );
    assert.ok(
      bridgeSrc.includes('modeBits === 0x01'),
      '_pollCycle must branch on modeBits === 0x01 (NORMAL_32BIT mode)'
    );
  });

  it('_rfuPollCycle detects RFU magic in high word of SIODATA32', () => {
    assert.ok(
      bridgeSrc.includes('RFU_MAGIC'),
      '_rfuPollCycle must check RFU_MAGIC in the SIODATA32 high word'
    );
  });

  it('_rfuPollCycle detects START bit rising edge on SIOCNT', () => {
    assert.ok(
      bridgeSrc.includes('startEdge') && bridgeSrc.includes('0x0080'),
      '_rfuPollCycle must detect START bit rising edge (SIOCNT bit 7)'
    );
  });

  it('_rfuPollCycle fires SIO IRQ after each adapter response', () => {
    assert.ok(
      bridgeSrc.includes('_rfuFireIrq'),
      '_rfuPollCycle must call _rfuFireIrq to trigger the GBA SIO interrupt'
    );
  });

  it('_rfuFireIrq sets IF bit 7 and IE bit 7', () => {
    // Find the method definition (class method, two-space indent)
    const fnDefIdx = bridgeSrc.indexOf('  _rfuFireIrq(');
    assert.ok(fnDefIdx !== -1, '_rfuFireIrq must be defined as a class method');
    const fnBody = bridgeSrc.substring(fnDefIdx, fnDefIdx + 400);
    assert.ok(fnBody.includes('0x202'), '_rfuFireIrq must reference IF register at IO+0x202');
    assert.ok(fnBody.includes('0x200'), '_rfuFireIrq must reference IE register at IO+0x200');
    assert.ok(
      fnBody.includes('1 << 7') || fnBody.includes('(1 << 7)'),
      '_rfuFireIrq must set bit 7 (SIO IRQ)'
    );
  });

  it('_rfuWriteAck writes 0x80CC in high word of SIODATA32', () => {
    assert.ok(
      bridgeSrc.includes('_rfuWriteAck'),
      'mgbaBridge.js must define _rfuWriteAck'
    );
    // After the RFU_ACK_HIGH_BYTE refactor the code uses the named constant
    assert.ok(
      bridgeSrc.includes('RFU_ACK_HIGH_BYTE << 8') || bridgeSrc.includes('0x80 << 8'),
      '_rfuWriteAck must write the 0x80CC ACK pattern (RFU_ACK_HIGH_BYTE << 8)'
    );
  });
});

// ─── RFU Wireless Adapter – command processing ────────────────────────────────
describe('mgbaBridge.js – RFU command processing', () => {
  it('_processRfuCommand handles System Reset (0x10)', () => {
    assert.ok(
      bridgeSrc.includes('SYSTEM_RESET') && bridgeSrc.includes('_rfuBroadcast'),
      'RFU System Reset must clear broadcast data and receive buffer'
    );
  });

  it('SetBroadcastData (0x16) stores broadcast data and emits rfu:host', () => {
    // Search for the case statement, not the constant definition
    const idx = bridgeSrc.indexOf('case RFU_CMD.SET_BROADCAST_DATA');
    assert.ok(idx !== -1, 'case RFU_CMD.SET_BROADCAST_DATA must exist in _processRfuCommand');
    const body = bridgeSrc.substring(idx, idx + 600);
    assert.ok(body.includes('_rfuBroadcast'), 'must store broadcast data in _rfuBroadcast');
    assert.ok(body.includes("'rfu:host'"),    'must emit rfu:host to the /rfu socket');
  });

  it('StartBroadcast (0x17) creates a PeerJS room and emits rfu:host with peerId', () => {
    const idx = bridgeSrc.indexOf('case RFU_CMD.START_BROADCAST');
    assert.ok(idx !== -1, 'case RFU_CMD.START_BROADCAST must exist in _processRfuCommand');
    const body = bridgeSrc.substring(idx, idx + 600);
    assert.ok(body.includes('createRoom'),  'StartBroadcast must call PeerLinkCable.createRoom()');
    assert.ok(body.includes("'rfu:host'"),  'StartBroadcast must emit rfu:host with the peerId');
    assert.ok(body.includes('peerId'),      'StartBroadcast must include peerId in rfu:host payload');
  });

  it('GetBroadcastData (0x18) returns cached games list and triggers async refresh', () => {
    const idx = bridgeSrc.indexOf('case RFU_CMD.GET_BROADCAST_DATA');
    assert.ok(idx !== -1, 'case RFU_CMD.GET_BROADCAST_DATA must exist in _processRfuCommand');
    const body = bridgeSrc.substring(idx, idx + 800);
    assert.ok(body.includes('_rfuGames'),        'GetBroadcastData must read from _rfuGames cache');
    assert.ok(body.includes('_rfuRefreshGames'), 'GetBroadcastData must trigger async refresh');
  });

  it('AcceptConnections (0x1A) joins the host PeerJS room using peerId from discovery', () => {
    const idx = bridgeSrc.indexOf('case RFU_CMD.ACCEPT_CONNECTIONS');
    assert.ok(idx !== -1, 'case RFU_CMD.ACCEPT_CONNECTIONS must exist in _processRfuCommand');
    const body = bridgeSrc.substring(idx, idx + 600);
    assert.ok(body.includes('joinRoom'),  'AcceptConnections must call PeerLinkCable.joinRoom()');
    assert.ok(body.includes('peerId'),    'AcceptConnections must use peerId from _rfuGames entry');
    assert.ok(body.includes('_rfuGames'), 'AcceptConnections must look up game from _rfuGames');
  });

  it('SendData (0x1C) uses exchangeRfuPacket for P2P transfer when peer is connected', () => {
    const idx = bridgeSrc.indexOf('case RFU_CMD.SEND_DATA');
    assert.ok(idx !== -1, 'case RFU_CMD.SEND_DATA must exist in _processRfuCommand');
    const body = bridgeSrc.substring(idx, idx + 400);
    assert.ok(body.includes('exchangeRfuPacket'), 'SendData must call exchangeRfuPacket');
  });

  it('SendData (0x1C) falls back to Socket.io rfu:data relay when PeerJS unavailable', () => {
    const idx = bridgeSrc.indexOf('case RFU_CMD.SEND_DATA');
    assert.ok(idx !== -1, 'case RFU_CMD.SEND_DATA must exist');
    const body = bridgeSrc.substring(idx, idx + 1200);
    assert.ok(body.includes("'rfu:data'"), 'SendData must have a Socket.io relay fallback');
  });

  it('RecvData (0x1D) returns _rfuRecvBuf contents and clears the buffer', () => {
    const idx = bridgeSrc.indexOf('case RFU_CMD.RECEIVE_DATA');
    assert.ok(idx !== -1, 'case RFU_CMD.RECEIVE_DATA must exist in _processRfuCommand');
    const body = bridgeSrc.substring(idx, idx + 400);
    assert.ok(body.includes('_rfuRecvBuf'), 'RecvData must read from _rfuRecvBuf');
    assert.ok(
      body.includes("_rfuRecvBuf   = []") || body.includes("_rfuRecvBuf = []"),
      'RecvData must clear _rfuRecvBuf after delivering data'
    );
  });
});

// ─── RFU Wireless Adapter – runtime behaviour ─────────────────────────────────
describe('mgbaBridge.js – RFU runtime (instantiated bridge)', () => {
  let win, bridge;

  beforeEach(() => {
    win    = makeBrowserShim();
    bridge = loadBridge(win);
  });

  it('bridge exposes rfuActive = false before any RFU traffic', () => {
    assert.equal(bridge.rfuActive, false);
  });

  it('bridge exposes empty rfuGames array initially', () => {
    assert.ok(Array.isArray(bridge.rfuGames));
    assert.equal(bridge.rfuGames.length, 0);
  });

  it('setRfuSocket() accepts a socket object without throwing', () => {
    const fakeSocket = {
      connected: true,
      on: () => {},
      emit: () => {},
    };
    assert.doesNotThrow(() => bridge.setRfuSocket(fakeSocket));
    assert.doesNotThrow(() => bridge.setRfuSocket(null));
  });

  it('_rfuOnPeerData() populates _rfuRecvBuf', () => {
    bridge._rfuOnPeerData({ cmd: 0x1C, data: [0xDEAD, 0xBEEF] });
    assert.deepEqual(bridge._rfuRecvBuf, [0xDEAD, 0xBEEF]);
  });

  it('_rfuOnPeerData() ignores null packet', () => {
    bridge._rfuRecvBuf = [0x1234];
    bridge._rfuOnPeerData(null);
    assert.deepEqual(bridge._rfuRecvBuf, [0x1234], 'null packet must not clear buffer');
  });

  it('_rfuOnPeerData() ignores empty data array', () => {
    bridge._rfuRecvBuf = [0x1234];
    bridge._rfuOnPeerData({ cmd: 0x1C, data: [] });
    assert.deepEqual(bridge._rfuRecvBuf, [0x1234], 'empty data array must not clear buffer');
  });

  it('in NORMAL_32BIT mode the bridge sets rfuActive=true after RFU magic', () => {
    const mod = makeFakeModule(4096);
    const IO  = 512;
    bridge.init(mod, IO);

    const siocntIdx = (IO + 0x128) >>> 1;
    const multi0Idx = (IO + 0x120) >>> 1;

    // SIOCNT: mode bits 12-13 = 01 (NORMAL_32BIT), START bit set
    mod.HEAPU16[siocntIdx] = (0x01 << 12) | 0x0080;
    // SIODATA32: RFU_MAGIC (0x9966) in high word, System Reset cmd (0x1000) in low
    mod.HEAPU16[multi0Idx]     = 0x1000;
    mod.HEAPU16[multi0Idx + 1] = 0x9966;

    bridge.startPolling();
    win._flushRaf();

    assert.equal(bridge.rfuActive, true,
      'bridge must set rfuActive=true after detecting 0x9966 magic in NORMAL_32BIT mode');
  });
});

// ─── RFU Wireless Adapter – discovery (_rfuRefreshGames) ─────────────────────
describe('mgbaBridge.js – RFU discovery via Socket.io', () => {
  it('_rfuRefreshGames emits rfu:search and populates _rfuGames', () => {
    const win    = makeBrowserShim();
    const bridge = loadBridge(win);

    let emitted = null;
    const fakeSocket = {
      connected: true,
      on:   () => {},
      emit: (event, data, cb) => {
        emitted = { event, data };
        if (cb) cb({ games: [{ hostId: 'u1', peerId: 'p1', gameInfo: [1, 2] }] });
      },
    };

    win._rfuLobbyId = 'lobby-test';
    bridge.setRfuSocket(fakeSocket);
    bridge._rfuRefreshGames();

    assert.equal(emitted?.event, 'rfu:search');
    assert.equal(emitted?.data?.lobbyId, 'lobby-test');
    assert.equal(bridge.rfuGames.length, 1);
    assert.equal(bridge.rfuGames[0].peerId, 'p1');
  });

  it('_rfuRefreshGames is a no-op when socket is disconnected', () => {
    const win    = makeBrowserShim();
    const bridge = loadBridge(win);

    let emitCalled = false;
    bridge.setRfuSocket({
      connected: false,
      on: () => {},
      emit: () => { emitCalled = true; },
    });
    win._rfuLobbyId = 'lobby-test';
    bridge._rfuRefreshGames();

    assert.equal(emitCalled, false);
  });
});

// ─── Frame-level lock-step stall ──────────────────────────────────────────────
describe('mgbaBridge.js – frame-level lock-step stall', () => {
  let win, bridge;

  beforeEach(() => {
    win    = makeBrowserShim();
    bridge = loadBridge(win);
  });

  it('frameStalled getter returns false initially', () => {
    assert.strictEqual(bridge.frameStalled, false);
  });

  it('retroRun() returns false when _frameStalled is true', () => {
    const mod = makeFakeModule(4096);
    bridge.init(mod, 0x0);
    bridge._frameStalled = true;
    const result = bridge.retroRun();
    assert.strictEqual(result, false, 'retroRun must return false while stalled');
    assert.strictEqual(mod._retroRunCallCount(), 0, 'underlying retro_run must NOT be called while stalled');
  });

  it('retroRun() calls retro_run normally when not stalled', () => {
    const mod = makeFakeModule(4096);
    bridge.init(mod, 0x0);
    bridge._frameStalled = false;
    const result = bridge.retroRun();
    assert.strictEqual(result, true);
    assert.strictEqual(mod._retroRunCallCount(), 1);
  });

  it('SEND_DATA sets _frameStalled when peer is connected', async () => {
    const mod    = makeFakeModule(4096);
    const IO     = 512;
    bridge.init(mod, IO);

    let resolveExchange;
    const fakePeer = {
      connected: true,
      exchangeRfuPacket: () => new Promise((res) => { resolveExchange = res; }),
    };
    bridge.connectPeer(fakePeer);

    // Simulate _processRfuCommand for SEND_DATA
    bridge._rfuCmd  = 0x1C; // RFU_CMD.SEND_DATA
    bridge._rfuData = [0xABCD];
    const siocntIdx = (IO + 0x128) >>> 1;
    bridge._processRfuCommand(mod.HEAPU16, siocntIdx, IO);

    assert.strictEqual(bridge.frameStalled, true,
      '_frameStalled must be true while waiting for peer packet');

    // Resolve the exchange and allow microtasks to run
    resolveExchange({ data: [0x1234] });
    await new Promise(r => setTimeout(r, 0));

    assert.strictEqual(bridge.frameStalled, false,
      '_frameStalled must be cleared after peer data arrives');
  });

  it('SEND_DATA clears _frameStalled on exchange rejection', async () => {
    const mod = makeFakeModule(4096);
    const IO  = 512;
    bridge.init(mod, IO);

    let rejectExchange;
    const fakePeer = {
      connected: true,
      exchangeRfuPacket: () => new Promise((_, rej) => { rejectExchange = rej; }),
    };
    bridge.connectPeer(fakePeer);

    bridge._rfuCmd  = 0x1C;
    bridge._rfuData = [];
    const siocntIdx = (IO + 0x128) >>> 1;
    bridge._processRfuCommand(mod.HEAPU16, siocntIdx, IO);

    assert.strictEqual(bridge.frameStalled, true);

    rejectExchange(new Error('network timeout'));
    await new Promise(r => setTimeout(r, 0));

    assert.strictEqual(bridge.frameStalled, false,
      '_frameStalled must be cleared even after a rejected exchange');
  });

  it('source code contains _frameStalled flag', () => {
    assert.ok(
      bridgeSrc.includes('_frameStalled'),
      'mgbaBridge.js must define _frameStalled for frame-level stall'
    );
  });
});

// ─── SharedArrayBuffer SIO register mirror ────────────────────────────────────
describe('mgbaBridge.js – SharedArrayBuffer SIO register mirror', () => {
  it('source code defines SIO_SAB_SLOTS and SIO_SAB_BYTES constants with correct values', () => {
    assert.ok(bridgeSrc.includes('SIO_SAB_SLOTS'), 'must define SIO_SAB_SLOTS');
    assert.ok(bridgeSrc.includes('SIO_SAB_BYTES'), 'must define SIO_SAB_BYTES');
    // Validate the numeric values: 8 slots × 4 bytes = 32 bytes
    assert.ok(
      bridgeSrc.includes('SIO_SAB_SLOTS = 8'),
      'SIO_SAB_SLOTS must equal 8 (one Int32 per SIO register)'
    );
    assert.ok(
      bridgeSrc.includes('SIO_SAB_SLOTS * 4') || bridgeSrc.includes('SIO_SAB_BYTES = 32'),
      'SIO_SAB_BYTES must be SIO_SAB_SLOTS * 4 = 32 bytes'
    );
  });

  it('source code uses Atomics.store for SAB updates', () => {
    assert.ok(
      bridgeSrc.includes('Atomics.store'),
      'must use Atomics.store() to write SIO register values into the SAB'
    );
  });

  it('exposes sioSharedBuffer getter', () => {
    assert.ok(
      bridgeSrc.includes('get sioSharedBuffer()'),
      'must expose sioSharedBuffer getter for cross-thread access'
    );
  });

  it('init() creates a SharedArrayBuffer-backed Int32Array when SAB is available', () => {
    const win    = makeBrowserShim();
    const bridge = loadBridge(win);
    const mod    = makeFakeModule(4096);
    bridge.init(mod, 0x0);

    assert.ok(
      bridge._sioSab instanceof SharedArrayBuffer,
      '_sioSab must be a SharedArrayBuffer after init()'
    );
    assert.ok(
      bridge._sioSabView instanceof Int32Array,
      '_sioSabView must be an Int32Array view over the SAB'
    );
    assert.strictEqual(
      bridge._sioSabView.buffer, bridge._sioSab,
      '_sioSabView.buffer must be the same SharedArrayBuffer as _sioSab'
    );
  });

  it('sioSharedBuffer getter returns the SharedArrayBuffer', () => {
    const win    = makeBrowserShim();
    const bridge = loadBridge(win);
    const mod    = makeFakeModule(4096);
    bridge.init(mod, 0x0);
    assert.ok(bridge.sioSharedBuffer instanceof SharedArrayBuffer);
  });

  it('injectSioData() mirrors SIOMULTI values to SAB via Atomics', () => {
    const win    = makeBrowserShim();
    const bridge = loadBridge(win);
    const mod    = makeFakeModule(8192);
    const IO     = 0x0400;
    bridge.init(mod, IO);

    bridge.injectSioData([0x1111, 0x2222, 0x3333, 0x4444]);

    assert.ok(bridge._sioSabView, 'SAB view must be initialised');
    assert.strictEqual(Atomics.load(bridge._sioSabView, 0), 0x1111, 'SAB[0] must mirror SIOMULTI0');
    assert.strictEqual(Atomics.load(bridge._sioSabView, 1), 0x2222, 'SAB[1] must mirror SIOMULTI1');
    assert.strictEqual(Atomics.load(bridge._sioSabView, 2), 0x3333, 'SAB[2] must mirror SIOMULTI2');
    assert.strictEqual(Atomics.load(bridge._sioSabView, 3), 0x4444, 'SAB[3] must mirror SIOMULTI3');
  });

  it('readSioRegisters() syncs all 8 SIO fields to the SAB', () => {
    const win    = makeBrowserShim();
    const bridge = loadBridge(win);
    const mod    = makeFakeModule(8192);
    const IO     = 0x0400;
    bridge.init(mod, IO);

    heap16Write(mod, IO + 0x120, 0xAAAA); // SIOMULTI0
    heap16Write(mod, IO + 0x122, 0xBBBB); // SIOMULTI1
    heap16Write(mod, IO + 0x124, 0xCCCC); // SIOMULTI2
    heap16Write(mod, IO + 0x126, 0xDDDD); // SIOMULTI3
    heap16Write(mod, IO + 0x128, 0x1080); // SIOCNT
    heap16Write(mod, IO + 0x12A, 0x0042); // SIODATA8
    heap16Write(mod, IO + 0x200, 0x0080); // IE
    heap16Write(mod, IO + 0x202, 0x0080); // IF

    bridge.readSioRegisters();

    assert.ok(bridge._sioSabView, 'SAB view must be present');
    assert.strictEqual(Atomics.load(bridge._sioSabView, 0), 0xAAAA, 'slot 0 = SIOMULTI0');
    assert.strictEqual(Atomics.load(bridge._sioSabView, 1), 0xBBBB, 'slot 1 = SIOMULTI1');
    assert.strictEqual(Atomics.load(bridge._sioSabView, 2), 0xCCCC, 'slot 2 = SIOMULTI2');
    assert.strictEqual(Atomics.load(bridge._sioSabView, 3), 0xDDDD, 'slot 3 = SIOMULTI3');
    assert.strictEqual(Atomics.load(bridge._sioSabView, 4), 0x1080, 'slot 4 = SIOCNT');
    assert.strictEqual(Atomics.load(bridge._sioSabView, 5), 0x0042, 'slot 5 = SIODATA8');
    assert.strictEqual(Atomics.load(bridge._sioSabView, 6), 0x0080, 'slot 6 = IE');
    assert.strictEqual(Atomics.load(bridge._sioSabView, 7), 0x0080, 'slot 7 = IF');
  });
});

// ─── RFU command 0x11 (SET_CONFIG) handshake prioritisation ──────────────────
describe('mgbaBridge.js – SET_CONFIG (0x11) Wireless Adapter handshake', () => {
  it('source code defines RFU_ADAPTER_HW_ID constant', () => {
    assert.ok(
      bridgeSrc.includes('RFU_ADAPTER_HW_ID'),
      'mgbaBridge.js must define RFU_ADAPTER_HW_ID for Wireless Adapter identification'
    );
    assert.ok(
      bridgeSrc.includes('0x0027'),
      'RFU_ADAPTER_HW_ID must equal 0x0027 (Wireless Adapter hardware ID)'
    );
  });

  it('SET_CONFIG (0x11) sets rfuEnabled immediately', () => {
    const win    = makeBrowserShim();
    const bridge = loadBridge(win);
    const mod    = makeFakeModule(4096);
    const IO     = 512;
    bridge.init(mod, IO);

    // Manually invoke _processRfuCommand with cmd=0x11 (SET_CONFIG)
    bridge._rfuCmd  = 0x11;
    bridge._rfuData = [0x00000001];
    const siocntIdx = (IO + 0x128) >>> 1;
    bridge._processRfuCommand(mod.HEAPU16, siocntIdx, IO);

    assert.strictEqual(bridge._rfuEnabled, true,
      'SET_CONFIG must set _rfuEnabled=true so the adapter is detected immediately');
  });

  it('SET_CONFIG (0x11) response includes wireless adapter hardware ID 0x0027', () => {
    const win    = makeBrowserShim();
    const bridge = loadBridge(win);
    const mod    = makeFakeModule(4096);
    const IO     = 512;
    bridge.init(mod, IO);

    bridge._rfuCmd  = 0x11;
    bridge._rfuData = [];
    const siocntIdx = (IO + 0x128) >>> 1;
    bridge._processRfuCommand(mod.HEAPU16, siocntIdx, IO);

    // _rfuRespQueue: first word was already written to SIODATA32 by _processRfuCommand;
    // the second word (hw ID) should be in the queue waiting to be drained.
    assert.ok(bridge._rfuRespQueue.length >= 1,
      'SET_CONFIG must queue the hardware ID response word');
    const hwIdWord = bridge._rfuRespQueue[0];
    assert.strictEqual((hwIdWord >>> 16) & 0xFFFF, 0x0027,
      'response high word must contain the Wireless Adapter hardware ID 0x0027');
  });

  it('SET_CONFIG is separate from CONFIG_STATUS in source', () => {
    // Verify they are no longer combined as a fall-through case.
    // SET_CONFIG (0x11) must appear before CONFIG_STATUS (0x15) and
    // a break statement must terminate the SET_CONFIG case body.
    const src = bridgeSrc;
    const idxSetConfig    = src.indexOf('case RFU_CMD.SET_CONFIG:');
    const idxConfigStatus = src.indexOf('case RFU_CMD.CONFIG_STATUS:');
    assert.ok(idxSetConfig    !== -1, 'SET_CONFIG case must exist');
    assert.ok(idxConfigStatus !== -1, 'CONFIG_STATUS case must exist');
    // SET_CONFIG must appear before CONFIG_STATUS in the switch
    assert.ok(
      idxSetConfig < idxConfigStatus,
      'SET_CONFIG (0x11) must appear before CONFIG_STATUS (0x15) in the switch'
    );
    // The body between SET_CONFIG and CONFIG_STATUS must contain a break
    const caseBody = src.substring(idxSetConfig, idxConfigStatus);
    assert.ok(
      caseBody.includes('break'),
      'SET_CONFIG case body must end with break (not fall-through to CONFIG_STATUS)'
    );
  });
});
