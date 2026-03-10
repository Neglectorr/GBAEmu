'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const gameJsPath  = path.join(__dirname, '../public/js/game.js');
const gameJs      = fs.readFileSync(gameJsPath, 'utf8');
const gameHtml    = fs.readFileSync(path.join(__dirname, '../public/game.html'), 'utf8');
const styleCss    = fs.readFileSync(path.join(__dirname, '../public/css/style.css'), 'utf8');

// ── Spectator image quality ────────────────────────────────────────────────
describe('Spectator image quality improvements', () => {
  it('uses lossless PNG format for frame capture instead of lossy JPEG', () => {
    const fnStart = gameJs.indexOf('function broadcastFrame()');
    assert.ok(fnStart !== -1, 'broadcastFrame function must exist');
    const fnBody = gameJs.substring(fnStart, fnStart + 1500);
    assert.ok(
      fnBody.includes("'image/png'"),
      'broadcastFrame must use image/png for lossless spectator frames'
    );
    assert.ok(
      !fnBody.includes("'image/jpeg'"),
      'broadcastFrame must NOT use image/jpeg'
    );
  });

  it('broadcasts at ~20 fps for a smoother spectator experience', () => {
    assert.ok(
      gameJs.includes('FRAME_EMIT_INTERVAL = 50'),
      'FRAME_EMIT_INTERVAL should be 50 ms (~20 fps)'
    );
  });

  it('updateSpectatorFrame creates blobs with PNG MIME type', () => {
    const fnStart = gameJs.indexOf('function updateSpectatorFrame');
    assert.ok(fnStart !== -1);
    const fnBody = gameJs.substring(fnStart, fnStart + 1000);
    assert.ok(
      fnBody.includes("image/png"),
      'updateSpectatorFrame must use image/png for blob and data URI'
    );
  });
});

// ── Spectator grid miniatures ──────────────────────────────────────────────
describe('Spectator grid – miniature thumbnails', () => {
  it('grid cells use a smaller minmax to produce real miniatures', () => {
    assert.ok(
      styleCss.includes('minmax(120px'),
      'spectator-grid columns should use minmax(120px, …) for thumbnail-sized cells'
    );
    assert.ok(
      !styleCss.includes('minmax(240px'),
      'spectator-grid must NOT use 240px minimum (produces full-size cells)'
    );
  });

  it('grid does not force full height so cells stay compact', () => {
    // The grid should use max-height: 100% (not height: 100%)
    const gridStart = styleCss.indexOf('.spectator-grid');
    assert.ok(gridStart !== -1);
    const gridBlock = styleCss.substring(gridStart, styleCss.indexOf('}', gridStart) + 1);
    assert.ok(
      gridBlock.includes('max-height'),
      'spectator-grid should use max-height instead of height: 100%'
    );
  });
});

// ── Volume control ─────────────────────────────────────────────────────────
describe('Volume control', () => {
  it('game.html contains a volume slider input', () => {
    assert.ok(
      gameHtml.includes('id="volume-slider"'),
      'game.html must contain a volume-slider element'
    );
    assert.ok(
      gameHtml.includes('type="range"'),
      'volume slider must be an <input type="range">'
    );
  });

  it('game.html contains a mute button', () => {
    assert.ok(
      gameHtml.includes('id="mute-btn"'),
      'game.html must contain a mute-btn element'
    );
  });

  it('game.js uses EmulatorJS setVolume for volume control', () => {
    assert.ok(
      gameJs.includes('EJS_emulator') && gameJs.includes('setVolume'),
      'game.js must use EJS_emulator.setVolume for volume control'
    );
  });

  it('volume slider is wired up in game.js', () => {
    assert.ok(
      gameJs.includes("document.getElementById('volume-slider')"),
      'volume slider event listener must be registered'
    );
  });

  it('mute button toggles audio on/off', () => {
    assert.ok(
      gameJs.includes("document.getElementById('mute-btn')"),
      'mute button event listener must be registered'
    );
    assert.ok(
      gameJs.includes('_volumeMuted'),
      'mute toggle must use _volumeMuted state'
    );
  });

  it('style.css contains volume control styling', () => {
    assert.ok(
      styleCss.includes('.volume-control'),
      'style.css must contain .volume-control class'
    );
    assert.ok(
      styleCss.includes('.volume-slider'),
      'style.css must contain .volume-slider class'
    );
  });
});

// ── Canvas resize ──────────────────────────────────────────────────────────
describe('Canvas resize – bounds checking', () => {
  it('onMove clamps width to parent bounds', () => {
    const fnStart = gameJs.indexOf('function initEmulatorResize');
    assert.ok(fnStart !== -1, 'initEmulatorResize must exist');
    const fnBody = gameJs.substring(fnStart, fnStart + 2000);
    assert.ok(
      fnBody.includes('Math.min') && fnBody.includes('Math.max'),
      'onMove must clamp dimensions with Math.min and Math.max'
    );
  });

  it('resize handle is at least 24×24 for easy grabbing', () => {
    assert.ok(
      styleCss.includes('width: 24px') && styleCss.includes('height: 24px'),
      'emulator-resize-handle should be 24×24px'
    );
  });
});

// ── Save / Load reliability ────────────────────────────────────────────────
describe('Save / Load reliability', () => {
  it('persistSave guards against concurrent saves', () => {
    assert.ok(
      gameJs.includes('saveInProgress'),
      'persistSave must use a saveInProgress guard'
    );
  });

  it('auto-save timer is stored so it can be cleared', () => {
    assert.ok(
      gameJs.includes('autoSaveTimer'),
      'auto-save interval reference must be stored in autoSaveTimer'
    );
    assert.ok(
      gameJs.includes('clearInterval(autoSaveTimer)'),
      'startSaveTimer must clear any previous interval before starting a new one'
    );
  });

  it('persistSave propagates errors so the save button can report failures', () => {
    const fnStart = gameJs.indexOf('async function persistSave');
    assert.ok(fnStart !== -1);
    const fnBody = gameJs.substring(fnStart, fnStart + 1200);
    assert.ok(
      fnBody.includes('finally'),
      'persistSave must use finally to reset saveInProgress'
    );
    const catchIdx = fnBody.indexOf('catch');
    const finallyIdx = fnBody.indexOf('finally');
    assert.ok(
      catchIdx === -1 || catchIdx > finallyIdx,
      'persistSave must not have a catch block that swallows API errors before finally'
    );
  });
});
