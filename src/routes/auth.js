'use strict';
const express = require('express');
const passport = require('passport');
const db = require('../db');
const router = express.Router();

// Initiate Google OAuth – prompt for account selection so users can switch accounts
router.get('/google', passport.authenticate('google', {
  scope: ['profile', 'email'],
  prompt: 'select_account',
}));

// Google OAuth callback
router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => {
    res.redirect('/lobby');
  }
);

// ─── Username-only login (fallback when SSO is unavailable) ──────────────────
router.post('/local', (req, res, next) => {
  const raw = req.body.username;
  if (!raw || typeof raw !== 'string') {
    return res.status(400).json({ error: 'Username is required' });
  }

  const username = raw.trim();

  // Allow alphanumeric, spaces, hyphens, underscores — 2-30 chars
  if (!/^[a-zA-Z0-9 _-]{2,30}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 2-30 characters (letters, numbers, spaces, hyphens, underscores)' });
  }

  db.users.findOne({ username }, (err, existing) => {
    if (err) return res.status(500).json({ error: 'Database error' });

    if (existing) {
      // Existing local user — log them in
      req.login(existing, (loginErr) => {
        if (loginErr) return next(loginErr);
        return res.json({ success: true });
      });
    } else {
      // New local user — first user becomes admin if no users exist yet
      db.users.findOne({}, (findErr, anyUser) => {
        if (findErr) return res.status(500).json({ error: 'Database error' });

        const isAdmin = !anyUser;
        const newUser = {
          username,
          displayName: username,
          avatarUrl: '',
          email: '',
          isAdmin,
          createdAt: new Date(),
        };

        db.users.insert(newUser, (insErr, user) => {
          if (insErr) return res.status(500).json({ error: 'Failed to create user' });
          req.login(user, (loginErr) => {
            if (loginErr) return next(loginErr);
            return res.json({ success: true });
          });
        });
      });
    }
  });
});

// Get current user info
router.get('/me', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const { _id, email, displayName, avatarUrl, isAdmin, createdAt } = req.user;
  res.json({ _id, email, displayName, avatarUrl, isAdmin, createdAt });
});

// Logout
router.post('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.clearCookie('x-csrf-token');
      res.json({ success: true });
    });
  });
});

module.exports = router;
