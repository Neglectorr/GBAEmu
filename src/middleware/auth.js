'use strict';

exports.requireAuth = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  res.redirect('/');
};

exports.requireAdmin = (req, res, next) => {
  if (req.isAuthenticated() && req.user.isAdmin) return next();
  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  res.status(403).send('Forbidden');
};
