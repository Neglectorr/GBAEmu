'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('NDS visual rendering – canvas visibility & scrollable layout', () => {
  const gameNdsJsPath = path.join(__dirname, '../public/js/game-nds.js');
  const gameNdsHtmlPath = path.join(__dirname, '../public/game-nds.html');
  const gameNdsJs = fs.readFileSync(gameNdsJsPath, 'utf8');
  const gameNdsHtml = fs.readFileSync(gameNdsHtmlPath, 'utf8');

  it('#nds-emulator uses absolute positioning to fill .emulator-wrap', () => {
    // Using position:absolute + inset:0 guarantees the EmulatorJS container
    // fills its parent regardless of flex alignment rules, preventing a
    // zero-height scenario that causes a blank canvas.
    assert.ok(
      /position\s*:\s*absolute/.test(gameNdsHtml),
      '#nds-emulator CSS must use position: absolute'
    );
    assert.ok(
      /inset\s*:\s*0/.test(gameNdsHtml),
      '#nds-emulator CSS must use inset: 0 to fill its parent'
    );
  });

  it('#nds-emulator has z-index so it renders above the background', () => {
    // Without z-index the absolutely-positioned container may sit behind
    // the scanline ::after pseudo-element.
    assert.ok(
      /z-index\s*:\s*1/.test(gameNdsHtml),
      '#nds-emulator CSS must set z-index: 1'
    );
  });

  it('#nds-emulator allows vertical scrolling for the tall NDS dual-screen', () => {
    // The NDS renders two stacked 256×192 screens.  The resulting canvas
    // can be taller than the viewport.  overflow-y: auto lets the user
    // scroll to see the bottom screen.
    // Extract the #nds-emulator CSS block specifically.
    const ndsBlockStart = gameNdsHtml.indexOf('#nds-emulator');
    assert.ok(ndsBlockStart !== -1, '#nds-emulator CSS block must exist');
    const ndsBlock = gameNdsHtml.slice(ndsBlockStart, gameNdsHtml.indexOf('}', ndsBlockStart) + 1);
    assert.ok(
      /overflow-y\s*:\s*auto/.test(ndsBlock),
      '#nds-emulator CSS must set overflow-y: auto'
    );
  });

  it('.emulator-wrap.nds-mode enables vertical scrolling', () => {
    // The wrapper also needs overflow-y: auto to propagate scrollability
    // when the EmulatorJS container overflows.
    const wrapSection = gameNdsHtml.slice(
      gameNdsHtml.indexOf('.emulator-wrap.nds-mode'),
      gameNdsHtml.indexOf('::after')
    );
    assert.ok(
      /overflow-y\s*:\s*auto/.test(wrapSection),
      '.emulator-wrap.nds-mode must set overflow-y: auto'
    );
  });

  it('EJS_onGameStart dispatches a resize event for layout recalculation', () => {
    // After the overlay is hidden and the game canvas takes its final size,
    // we dispatch a window resize event so EmulatorJS / Emscripten can
    // recalculate the rendering viewport.
    assert.ok(
      gameNdsJs.includes("dispatchEvent(new Event('resize'))"),
      'EJS_onGameStart must dispatch a resize event'
    );
  });

  it('EJS_onGameStart ensures #nds-emulator display is block', () => {
    // Belt-and-suspenders: explicitly set display:block after the overlay
    // is hidden, in case a CSS rule or earlier code path left it hidden.
    const onStartIdx = gameNdsJs.indexOf('EJS_onGameStart');
    assert.ok(onStartIdx !== -1, 'EJS_onGameStart callback must exist');
    // Search to the end of the callback (next top-level assignment or EOF)
    const nextAssign = gameNdsJs.indexOf('window.EJS_on', onStartIdx + 15);
    const endIdx = nextAssign !== -1 ? nextAssign : onStartIdx + 800;
    const section = gameNdsJs.slice(onStartIdx, endIdx);
    assert.ok(
      section.includes("nds-emulator") && section.includes("display"),
      'EJS_onGameStart must set #nds-emulator display to block'
    );
  });

  it('EJS_onGameStart operations execute in correct order: hideOverlay → display → resize', () => {
    // The overlay must be hidden first so the container has its final
    // dimensions, then display is asserted, then the resize event fires.
    const onStartIdx = gameNdsJs.indexOf('EJS_onGameStart');
    const nextAssign = gameNdsJs.indexOf('window.EJS_on', onStartIdx + 15);
    const endIdx = nextAssign !== -1 ? nextAssign : onStartIdx + 800;
    const section = gameNdsJs.slice(onStartIdx, endIdx);
    const hideIdx = section.indexOf('hideOverlay()');
    const displayIdx = section.indexOf("style.display = 'block'");
    const resizeIdx = section.indexOf("dispatchEvent(new Event('resize'))");
    assert.ok(hideIdx !== -1, 'hideOverlay() must be called in EJS_onGameStart');
    assert.ok(displayIdx !== -1, 'display block must be set in EJS_onGameStart');
    assert.ok(resizeIdx !== -1, 'resize dispatch must be present in EJS_onGameStart');
    assert.ok(
      hideIdx < displayIdx && displayIdx < resizeIdx,
      'Order must be: hideOverlay → display:block → resize dispatch'
    );
  });
});
