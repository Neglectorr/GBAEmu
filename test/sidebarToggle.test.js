'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const gameJsPath = path.join(__dirname, '../public/js/game.js');
const gameJs     = fs.readFileSync(gameJsPath, 'utf8');
const gameHtml   = fs.readFileSync(path.join(__dirname, '../public/game.html'), 'utf8');
const styleCss   = fs.readFileSync(path.join(__dirname, '../public/css/style.css'), 'utf8');

// ── Sidebar toggle – Chat ↔ Watch ─────────────────────────────────────────
describe('Sidebar toggle – Chat / Watch panels', () => {

  // ── HTML structure ─────────────────────────────────────────────────────
  it('game.html has sidebar tab buttons for Chat and Watch', () => {
    assert.ok(
      gameHtml.includes('id="sidebar-tab-chat"'),
      'game.html must have a sidebar-tab-chat button'
    );
    assert.ok(
      gameHtml.includes('id="sidebar-tab-watch"'),
      'game.html must have a sidebar-tab-watch button'
    );
    assert.ok(
      gameHtml.includes('class="sidebar-tabs"'),
      'game.html must have a sidebar-tabs container'
    );
  });

  it('game.html has separate chat and watch panels', () => {
    assert.ok(
      gameHtml.includes('id="sidebar-panel-chat"'),
      'game.html must have a sidebar-panel-chat container'
    );
    assert.ok(
      gameHtml.includes('id="sidebar-panel-watch"'),
      'game.html must have a sidebar-panel-watch container'
    );
  });

  it('game.html has a sidebar spectator grid in the watch panel', () => {
    assert.ok(
      gameHtml.includes('id="sidebar-spectator-grid"'),
      'game.html must have a sidebar-spectator-grid element'
    );
  });

  // ── JavaScript logic ──────────────────────────────────────────────────
  it('game.js declares a sidebarTab state variable', () => {
    assert.ok(
      gameJs.includes("sidebarTab = 'chat'"),
      'game.js must declare sidebarTab state defaulting to chat'
    );
  });

  it('game.js has a switchSidebarTab function that toggles panels', () => {
    const fnStart = gameJs.indexOf('function switchSidebarTab');
    assert.ok(fnStart !== -1, 'switchSidebarTab function must exist');
    const fnBody = gameJs.substring(fnStart, fnStart + 1500);
    assert.ok(
      fnBody.includes('sidebar-panel-chat') && fnBody.includes('sidebar-panel-watch'),
      'switchSidebarTab must reference both chat and watch panels'
    );
    assert.ok(
      fnBody.includes("sidebarTab = tab"),
      'switchSidebarTab must update sidebarTab state'
    );
  });

  it('sidebar tab buttons are wired to switchSidebarTab in initUIEvents', () => {
    assert.ok(
      gameJs.includes("getElementById('sidebar-tab-chat')"),
      'initUIEvents must register click handler for sidebar-tab-chat'
    );
    assert.ok(
      gameJs.includes("getElementById('sidebar-tab-watch')"),
      'initUIEvents must register click handler for sidebar-tab-watch'
    );
    assert.ok(
      gameJs.includes("switchSidebarTab('chat')") && gameJs.includes("switchSidebarTab('watch')"),
      'tab buttons must call switchSidebarTab with the correct tab name'
    );
  });

  it('game.js has buildSidebarSpectatorGrid function', () => {
    const fnStart = gameJs.indexOf('function buildSidebarSpectatorGrid');
    assert.ok(fnStart !== -1, 'buildSidebarSpectatorGrid function must exist');
    const fnBody = gameJs.substring(fnStart, fnStart + 1200);
    assert.ok(
      fnBody.includes('sidebar-spectator-grid'),
      'buildSidebarSpectatorGrid must reference sidebar-spectator-grid element'
    );
    assert.ok(
      fnBody.includes('sidebar-spectator-cell'),
      'buildSidebarSpectatorGrid must create cells with sidebar-spectator-cell class'
    );
  });

  it('buildSidebarSpectatorGrid filters out the current user\'s own game', () => {
    const fnStart = gameJs.indexOf('function buildSidebarSpectatorGrid');
    assert.ok(fnStart !== -1, 'buildSidebarSpectatorGrid function must exist');
    const fnBody = gameJs.substring(fnStart, fnStart + 1200);
    assert.ok(
      fnBody.includes('currentUser') && fnBody.includes('filter'),
      'buildSidebarSpectatorGrid must filter players using currentUser to exclude own game'
    );
    assert.ok(
      fnBody.includes('userId !== currentUser._id'),
      'buildSidebarSpectatorGrid must exclude the player whose userId matches currentUser._id'
    );
  });

  it('game.js has updateSidebarSpectatorFrame function that updates sidebar feeds', () => {
    const fnStart = gameJs.indexOf('function updateSidebarSpectatorFrame');
    assert.ok(fnStart !== -1, 'updateSidebarSpectatorFrame function must exist');
    const fnBody = gameJs.substring(fnStart, fnStart + 1000);
    assert.ok(
      fnBody.includes('sidebar-spec-img-'),
      'updateSidebarSpectatorFrame must target sidebar-spec-img elements'
    );
    assert.ok(
      fnBody.includes('URL.revokeObjectURL'),
      'updateSidebarSpectatorFrame must revoke old blob URLs to prevent memory leaks'
    );
  });

  it('game:frame handler also updates sidebar spectator grid', () => {
    const handlerStart = gameJs.indexOf("lobbySocket.on('game:frame'");
    assert.ok(handlerStart !== -1, 'game:frame handler must exist');
    const handlerBody = gameJs.substring(handlerStart, handlerStart + 500);
    assert.ok(
      handlerBody.includes('updateSidebarSpectatorFrame'),
      'game:frame handler must call updateSidebarSpectatorFrame for sidebar watch panel'
    );
  });

  // ── CSS styling ───────────────────────────────────────────────────────
  it('style.css has sidebar tab styling', () => {
    assert.ok(
      styleCss.includes('.sidebar-tabs'),
      'style.css must contain .sidebar-tabs styling'
    );
    assert.ok(
      styleCss.includes('.sidebar-tab-btn'),
      'style.css must contain .sidebar-tab-btn styling'
    );
    assert.ok(
      styleCss.includes('.sidebar-tab-btn.active'),
      'style.css must contain .sidebar-tab-btn.active styling'
    );
  });

  it('style.css has sidebar spectator grid styling', () => {
    assert.ok(
      styleCss.includes('.sidebar-spectator-grid'),
      'style.css must contain .sidebar-spectator-grid styling'
    );
    assert.ok(
      styleCss.includes('.sidebar-spectator-cell'),
      'style.css must contain .sidebar-spectator-cell styling'
    );
    assert.ok(
      styleCss.includes('.sidebar-spectator-cell-img'),
      'style.css must contain .sidebar-spectator-cell-img styling'
    );
    assert.ok(
      styleCss.includes('.sidebar-spectator-cell-label'),
      'style.css must contain .sidebar-spectator-cell-label styling'
    );
  });
});
