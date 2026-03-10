'use strict';
/**
 * rfuRelay.js – Socket.io /rfu namespace for GBA Wireless Adapter (RFU) discovery
 *
 * This is the lobby-discovery layer for the RFU wireless adapter emulation.
 * It handles three concerns:
 *
 *   1. Host registration  – When a GBA game calls SetBroadcastData (0x16) +
 *      StartBroadcast (0x17), the client emits `rfu:host` here with:
 *        { lobbyId, gameInfo: number[], peerId: string }
 *      The server stores the entry in the lobby room so other players can
 *      find it.  `peerId` is the PeerJS room ID for direct P2P connection.
 *
 *   2. Search / discovery – When a GBA game calls GetBroadcastData (0x18),
 *      the client emits `rfu:search` with { lobbyId }.  The server responds
 *      with the list of all hosts currently registered in that lobby:
 *        { games: [{ hostId, userName, gameInfo, peerId }] }
 *      The client (mgbaBridge.js) caches this list and returns it to the
 *      GBA inside the RFU command-response cycle.
 *
 *   3. Data relay fallback – If PeerJS / WebRTC fails or is unavailable,
 *      clients can relay RFU data packets through the server by emitting
 *      `rfu:data` with { lobbyId, targetUserId, packet: number[] }.
 *      The server forwards it as `rfu:data` to the target socket.
 *
 * P2P connection flow (after discovery):
 *   Guest calls `rfu:search` → gets host's `peerId`
 *   Guest calls `PeerLinkCable.joinRoom(peerId)` (PeerJS WebRTC)
 *   Host receives the PeerJS connection → DataChannel opened
 *   Subsequent 0x1C/0x1D data goes over PeerJS with no server involvement.
 *
 * A single lobby can support up to 4 simultaneous hosts (matching GBA hardware
 * limit of 4 wireless adapter slots).
 */

const lobbyManager = require('./lobbyManager');

/**
 * Maximum number of simultaneous RFU hosts allowed per lobby.
 * Matches the GBA wireless adapter hardware limit of 4 players per game session
 * (slots 0–3 visible in GetBroadcastData / AcceptConnections).
 */
const MAX_HOSTS_PER_LOBBY = 4;

module.exports = function setupRfuRelaySocket(io) {
  const rfuNS = io.of('/rfu');

  rfuNS.on('connection', (socket) => {
    const user = socket.request.user;
    if (!user) { socket.disconnect(true); return; }

    /** @type {string|null} Lobby this socket is currently joined to */
    let currentLobbyId = null;

    // ── Host registration ─────────────────────────────────────────────────────
    // Emitted by mgbaBridge.js when the GBA calls StartBroadcast (0x17).
    // Stores the PeerJS peerId alongside the game info so clients can connect
    // directly without going through the server for data transfer.
    socket.on('rfu:host', (data, ack) => {
      const { lobbyId, gameInfo, peerId } = data || {};

      const lobby = lobbyManager.getLobby(lobbyId);
      if (!lobby) return ack?.({ error: 'Lobby not found' });

      const player = lobby.findPlayer(user._id);
      if (!player) return ack?.({ error: 'Not a player in this lobby' });

      // Count active hosts in the lobby (cap at hardware limit)
      const room = rfuNS.adapter.rooms.get(lobbyId);
      let hostCount = 0;
      if (room) {
        for (const sid of room) {
          const s = rfuNS.sockets.get(sid);
          if (s?._rfuHosting) hostCount++;
        }
      }
      if (hostCount >= MAX_HOSTS_PER_LOBBY) {
        return ack?.({ error: 'Too many wireless hosts in this lobby' });
      }

      currentLobbyId       = lobbyId;
      socket._rfuHosting   = true;
      socket._rfuPeerId    = typeof peerId === 'string' ? peerId : null;
      socket._rfuGameInfo  = Array.isArray(gameInfo) ? gameInfo : [];
      socket._rfuUserId    = user._id;
      socket._rfuUserName  = user.displayName;

      socket.join(lobbyId);

      ack?.({ success: true });

      // Notify all lobby members that a new wireless host is available
      rfuNS.to(lobbyId).emit('rfu:host-available', {
        hostId:   user._id,
        userName: user.displayName,
        peerId:   socket._rfuPeerId,
      });

      console.log(`[RFU] ${user.displayName} hosting in lobby ${lobbyId} (peerId=${socket._rfuPeerId})`);
    });

    // ── Discovery search ──────────────────────────────────────────────────────
    // Returns the list of active hosts in a lobby.  Emitted by mgbaBridge.js
    // when the GBA calls GetBroadcastData (0x18) to search for games.
    socket.on('rfu:search', (data, ack) => {
      const { lobbyId } = data || {};

      const lobby = lobbyManager.getLobby(lobbyId);
      if (!lobby) return ack?.({ error: 'Lobby not found' });

      const player = lobby.findPlayer(user._id);
      if (!player) return ack?.({ error: 'Not a player in this lobby' });

      // Ensure this socket is also in the lobby room for future broadcasts
      if (!currentLobbyId) {
        currentLobbyId = lobbyId;
        socket.join(lobbyId);
      }

      const games = [];
      const room  = rfuNS.adapter.rooms.get(lobbyId);
      if (room) {
        for (const sid of room) {
          const s = rfuNS.sockets.get(sid);
          if (s?._rfuHosting && s._rfuUserId !== user._id) {
            games.push({
              hostId:   s._rfuUserId,
              userName: s._rfuUserName,
              gameInfo: s._rfuGameInfo ?? [],
              peerId:   s._rfuPeerId   ?? null,
            });
          }
        }
      }

      ack?.({ games });

      console.log(`[RFU] ${user.displayName} searched lobby ${lobbyId}: ${games.length} game(s) found`);
    });

    // ── Data relay fallback ───────────────────────────────────────────────────
    // Used when PeerJS / WebRTC is unavailable.  Forwards an RFU data packet
    // (array of 32-bit numbers) to a specific target user in the same lobby.
    // This path is not used once PeerJS DataChannels are open.
    socket.on('rfu:data', (data, ack) => {
      const { lobbyId, targetUserId, packet } = data || {};

      if (!lobbyId || !Array.isArray(packet)) return ack?.({ error: 'Invalid payload' });

      const lobby = lobbyManager.getLobby(lobbyId);
      if (!lobby) return ack?.({ error: 'Lobby not found' });

      const player = lobby.findPlayer(user._id);
      if (!player) return ack?.({ error: 'Not a player in this lobby' });

      // Find the target player's socket and forward the packet
      const room = rfuNS.adapter.rooms.get(lobbyId);
      let delivered = false;
      if (room && targetUserId) {
        for (const sid of room) {
          const s = rfuNS.sockets.get(sid);
          if (s?._rfuUserId === targetUserId) {
            s.emit('rfu:data', {
              fromUserId: user._id,
              userName:   user.displayName,
              packet,
            });
            delivered = true;
            break;
          }
        }
      } else if (room) {
        // No target specified – broadcast to all others in the lobby
        for (const sid of room) {
          const s = rfuNS.sockets.get(sid);
          if (s && s.id !== socket.id) {
            s.emit('rfu:data', {
              fromUserId: user._id,
              userName:   user.displayName,
              packet,
            });
            delivered = true;
          }
        }
      }

      ack?.({ success: true, delivered });
    });

    // ── Leave / clean up ──────────────────────────────────────────────────────
    socket.on('rfu:leave', () => {
      _clearHosting();
    });

    socket.on('disconnect', () => {
      _clearHosting();
    });

    function _clearHosting() {
      if (socket._rfuHosting && currentLobbyId) {
        socket._rfuHosting = false;
        rfuNS.to(currentLobbyId).emit('rfu:host-left', {
          hostId:   user._id,
          userName: user.displayName,
        });
        console.log(`[RFU] ${user.displayName} stopped hosting in lobby ${currentLobbyId}`);
      }
    }
  });
};
