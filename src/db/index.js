'use strict';
const Datastore = require('@seald-io/nedb');
const path = require('path');
const fs = require('fs');

const dbDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const users      = new Datastore({ filename: path.join(dbDir, 'users.db'), autoload: true });
const roms       = new Datastore({ filename: path.join(dbDir, 'roms.db'),  autoload: true });
const saves      = new Datastore({ filename: path.join(dbDir, 'saves.db'), autoload: true });
const savestates = new Datastore({ filename: path.join(dbDir, 'savestates.db'), autoload: true });

// Indexes
users.ensureIndex({ fieldName: 'googleId', unique: true, sparse: true }, () => {});
users.ensureIndex({ fieldName: 'username', unique: true, sparse: true }, () => {});
users.ensureIndex({ fieldName: 'email' }, () => {});
roms.ensureIndex({ fieldName: 'filename' }, () => {});
saves.ensureIndex({ fieldName: 'userId' }, () => {});
saves.ensureIndex({ fieldName: 'romId' }, () => {});
savestates.ensureIndex({ fieldName: 'userId' }, () => {});
savestates.ensureIndex({ fieldName: 'romId' }, () => {});

// Auto-compact saves.db every 60 seconds to prevent bloat from frequent
// upserts (each update appends a new record and soft-deletes the old one).
saves.setAutocompactionInterval(60 * 1000);
savestates.setAutocompactionInterval(60 * 1000);

module.exports = { users, roms, saves, savestates };
