'use strict';

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const passport = require('passport');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const { doubleCsrf } = require('csrf-csrf');
const { scanRoms } = require('./src/romScanner');

// Ensure upload directories exist
const dirs = ['uploads/roms', 'uploads/saves'];
dirs.forEach(d => {
  const fullPath = path.join(__dirname, d);
  if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
});

// Initialize DB
const db = require('./src/db');

// Setup Google OAuth strategy
require('./src/passport')(passport);

const app = express();
// Trust reverse proxies (e.g. Caddy, nginx) so secure cookies and redirects work
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CLIENT_ORIGIN || '*', credentials: true },
  maxHttpBufferSize: 5e6, // 5MB for frame data
});

// ─── Security & Middleware ───────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "blob:"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'", 'wss:', 'ws:', 'blob:'],
      workerSrc: ["'self'", 'blob:'],
      mediaSrc: ["'self'", 'blob:'],
    },
  },
  // mGBA WASM requires cross-origin isolation
  crossOriginEmbedderPolicy: { policy: 'require-corp' },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
}));

app.use(cors({
  origin: process.env.CLIENT_ORIGIN || true,
  credentials: true,
}));

app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const sessionMiddleware = session({
  store: new MemoryStore({ checkPeriod: 86400000 }),
  secret: process.env.SESSION_SECRET || 'gba-portal-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    sameSite: 'lax',
  },
});
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

// ─── Rate Limiting ────────────────────────────────────────────────────────────
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
}));

// Strict rate limit on OAuth initiation and callback
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth requests, please try again later' },
});
app.use('/auth/', authRateLimit);

// ─── CSRF Protection (double-submit cookie pattern) ──────────────────────────
// Applies to all state-changing methods (POST, PUT, PATCH, DELETE) globally.
// GET, HEAD and OPTIONS are automatically excluded by ignoredMethods.
const { generateCsrfToken, doubleCsrfProtection } = doubleCsrf({
  getSecret: () => process.env.SESSION_SECRET || 'gba-portal-csrf-secret',
  getSessionIdentifier: (req) => req.session?.id || '',
  cookieName: 'x-csrf-token',
  cookieOptions: {
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
  },
  size: 64,
  ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
});

// Expose CSRF token to the client via a GET endpoint (before global CSRF middleware)
app.get('/api/csrf-token', (req, res) => {
  // Touch the session so express-session persists it and sends the cookie.
  // Without this, saveUninitialized:false prevents the session cookie from
  // being set, and the CSRF token becomes invalid on the next request.
  if (!req.session._csrfReady) req.session._csrfReady = true;
  res.json({ csrfToken: generateCsrfToken(req, res) });
});

// Apply CSRF protection globally to all routes that follow
app.use(doubleCsrfProtection);

// ─── Static Files ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Serve mGBA WASM files with required headers
app.use('/emulator', (req, res, next) => {
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
}, express.static(path.join(__dirname, 'node_modules/@thenick775/mgba-wasm/dist')));

// Serve EmulatorJS data files for NDS emulation (DeSmuME core)
app.use('/emulator-nds', (req, res, next) => {
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(path.join(__dirname, 'node_modules/@emulatorjs/emulatorjs/data')));

// Serve DeSmuME WASM core files
app.use('/emulator-nds/cores', (req, res, next) => {
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(path.join(__dirname, 'node_modules/@emulatorjs/core-desmume')));

// Serve EmulatorJS data files for GBA emulation (mGBA core)
app.use('/emulator-gba', (req, res, next) => {
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(path.join(__dirname, 'node_modules/@emulatorjs/emulatorjs/data')));

// Serve mGBA WASM core files
app.use('/emulator-gba/cores', (req, res, next) => {
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(path.join(__dirname, 'node_modules/@emulatorjs/core-mgba')));

// EmulatorJS netplay is disabled – GBA Pokemon multiplayer uses the Lua-style
// link cable emulation only (see /src/socket/luaLink.js).

// ─── Routes ──────────────────────────────────────────────────────────────────
// CSRF protection is applied globally above; all state-changing routes are protected
app.use('/auth', require('./src/routes/auth'));
app.use('/api/roms', require('./src/routes/roms'));
app.use('/api/saves', require('./src/routes/saves'));
app.use('/api/savestates', require('./src/routes/savestates'));
app.use('/api/admin', require('./src/routes/admin'));
app.use('/api/lobbies', require('./src/routes/lobbies'));

// ─── Error Handler (JSON for /api and /auth routes) ─────────────────────────
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Internal server error';
  res.status(status).json({ error: message });
});

// ─── Socket.IO ───────────────────────────────────────────────────────────────
// Share session with socket.io
io.engine.use(sessionMiddleware);
io.engine.use(passport.initialize());
io.engine.use(passport.session());

require('./src/socket/lobby')(io);
require('./src/socket/luaLink')(io);
require('./src/socket/webrtcSignal')(io);
require('./src/socket/ndsLink')(io);
require('./src/socket/presence')(io);
require('./src/socket/rfuRelay')(io);

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`Game Portal running on http://localhost:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);

  // Scan uploads/roms for ROM files not yet tracked in the database
  try {
    const added = await scanRoms();
    if (added > 0) console.log(`ROM scan complete: ${added} new ROM(s) added to database`);
  } catch (err) {
    console.error('ROM scan failed:', err.message);
  }
});

module.exports = { app, server };
