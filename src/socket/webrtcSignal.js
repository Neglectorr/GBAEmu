'use strict';
/**
 * WebRTC Signaling Server
 *
 * Relays WebRTC offer/answer/ICE-candidate messages between players in the
 * same lobby so they can establish direct peer-to-peer (P2P) connections for
 * low-latency GBA link cable emulation.
 *
 * Once the P2P link is established via RTCDataChannel, link cable bytes flow
 * directly between clients without touching the server relay, eliminating the
 * server round-trip that causes desync in the Socket.IO-relay fallback path.
 *
 * Architecture:
 *   - Master (P0) creates one RTCPeerConnection to each slave (star topology).
 *   - Master creates a DataChannel ('link-cable') on each peer connection.
 *   - SDP offers/answers and ICE candidates are relayed through this namespace.
 *   - Each signaling message carries { from: playerIndex, to: playerIndex } so
 *     clients can filter messages intended for them.
 *   - If WebRTC is unavailable or ICE fails, the client falls back to the
 *     existing Socket.IO relay via /lualink (luaLink.js).
 */

const lobbyManager = require('./lobbyManager');

module.exports = function setupWebRtcSignaling(io) {
  const ns = io.of('/webrtc-signal');

  ns.on('connection', (socket) => {
    const user = socket.request.user;
    if (!user) { socket.disconnect(true); return; }

    let currentLobbyId = null;
    let myPlayerIndex = -1;

    // ── Join a lobby's WebRTC signaling room ────────────────────────────────
    socket.on('webrtc:join', (data, ack) => {
      const { lobbyId } = data || {};
      const lobby = lobbyManager.getLobby(lobbyId);
      if (!lobby) return ack?.({ error: 'Lobby not found' });

      const player = lobby.findPlayer(user._id);
      if (!player) return ack?.({ error: 'Not a player in this lobby' });
      if (lobby.status !== 'playing') return ack?.({ error: 'Game not started' });

      currentLobbyId = lobbyId;
      myPlayerIndex = player.playerIndex;
      socket.join(lobbyId);

      ack?.({ success: true, playerIndex: player.playerIndex });
      console.log(`[WebRTC Signal] P${player.playerIndex} joined signaling in lobby ${lobbyId}`);
    });

    // ── Relay SDP offer from master to a slave ──────────────────────────────
    // data: { to: playerIndex, sdp: RTCSessionDescriptionInit }
    socket.on('webrtc:offer', (data) => {
      if (!currentLobbyId) return;
      socket.to(currentLobbyId).emit('webrtc:offer', {
        ...data,
        from: myPlayerIndex,
      });
    });

    // ── Relay SDP answer from slave to master ───────────────────────────────
    // data: { to: playerIndex, sdp: RTCSessionDescriptionInit }
    socket.on('webrtc:answer', (data) => {
      if (!currentLobbyId) return;
      socket.to(currentLobbyId).emit('webrtc:answer', {
        ...data,
        from: myPlayerIndex,
      });
    });

    // ── Relay ICE candidates between peers ──────────────────────────────────
    // data: { to: playerIndex, candidate: RTCIceCandidateInit }
    socket.on('webrtc:ice-candidate', (data) => {
      if (!currentLobbyId) return;
      socket.to(currentLobbyId).emit('webrtc:ice-candidate', {
        ...data,
        from: myPlayerIndex,
      });
    });

    // ── Notify peers when a player leaves ───────────────────────────────────
    socket.on('disconnect', () => {
      if (currentLobbyId) {
        socket.to(currentLobbyId).emit('webrtc:peer-left', {
          from: myPlayerIndex,
        });
        console.log(`[WebRTC Signal] P${myPlayerIndex} left signaling in lobby ${currentLobbyId}`);
      }
    });
  });
};
