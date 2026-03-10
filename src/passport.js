'use strict';
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const db = require('./db');

module.exports = function setupPassport(passport) {
  // Serialize / deserialize must always be registered so that both
  // Google OAuth and username-only (local) sessions work.
  passport.serializeUser((user, done) => {
    done(null, user._id);
  });

  passport.deserializeUser((id, done) => {
    db.users.findOne({ _id: id }, (err, user) => done(err, user));
  });

  // Skip Google OAuth strategy if credentials are not configured
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET ||
      process.env.GOOGLE_CLIENT_ID === 'your-google-client-id.apps.googleusercontent.com') {
    console.warn('[Auth] Google OAuth not configured – only username login available. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env for Google sign-in.');
    return;
  }

  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback',
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const googleId = profile.id;
      const email = (profile.emails && profile.emails[0]) ? profile.emails[0].value : '';
      const displayName = profile.displayName || email;
      const avatarUrl = (profile.photos && profile.photos[0]) ? profile.photos[0].value : '';

      // Upsert user
      db.users.findOne({ googleId }, (err, existing) => {
        if (err) return done(err);

        if (existing) {
          // Update last login details
          db.users.update({ googleId }, { $set: { displayName, avatarUrl } }, {}, (e) => {
            if (e) return done(e);
            db.users.findOne({ googleId }, (e2, u) => done(e2, u));
          });
        } else {
          // First user becomes admin
          db.users.count({}, (countErr, count) => {
            const isAdmin = count === 0;
            const newUser = { googleId, email, displayName, avatarUrl, isAdmin, createdAt: new Date() };
            db.users.insert(newUser, (insErr, user) => done(insErr, user));
          });
        }
      });
    } catch (err) {
      done(err);
    }
  }));
};
