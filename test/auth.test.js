'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// Ensure no Google OAuth is configured for these tests
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;

const { app, server } = require('../server');

// ─── Helper: simple HTTP request with cookie jar ─────────────────────────────
function request(method, path, { body, cookies, headers: extraHeaders } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, `http://localhost:${server.address().port}`);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {},
    };
    if (cookies) opts.headers.cookie = cookies;
    if (extraHeaders) Object.assign(opts.headers, extraHeaders);
    if (body) {
      const json = JSON.stringify(body);
      opts.headers['content-type'] = 'application/json';
      opts.headers['content-length'] = Buffer.byteLength(json);
    }

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsed,
          cookies: (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; '),
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Helper to get a CSRF token + cookies in one step
async function getCsrf() {
  const res = await request('GET', '/api/csrf-token');
  return { token: res.body.csrfToken, cookies: res.cookies };
}

// Merge cookie strings, later values override earlier ones for the same name
function mergeCookies(...jars) {
  const map = new Map();
  for (const jar of jars) {
    if (!jar) continue;
    for (const pair of jar.split('; ')) {
      const [name] = pair.split('=');
      if (name) map.set(name, pair);
    }
  }
  return [...map.values()].join('; ');
}

describe('Username (local) login', () => {
  before((_, done) => {
    if (!server.listening) {
      server.listen(0, done);
    } else {
      done();
    }
  });

  after((_, done) => {
    server.close(done);
  });

  it('rejects empty username', async () => {
    const csrf = await getCsrf();
    const res = await request('POST', '/auth/local', {
      body: { username: '' },
      cookies: csrf.cookies,
      headers: { 'x-csrf-token': csrf.token },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  it('rejects username that is too short', async () => {
    const csrf = await getCsrf();
    const res = await request('POST', '/auth/local', {
      body: { username: 'a' },
      cookies: csrf.cookies,
      headers: { 'x-csrf-token': csrf.token },
    });
    assert.equal(res.status, 400);
  });

  it('rejects username with invalid characters', async () => {
    const csrf = await getCsrf();
    const res = await request('POST', '/auth/local', {
      body: { username: '<script>' },
      cookies: csrf.cookies,
      headers: { 'x-csrf-token': csrf.token },
    });
    assert.equal(res.status, 400);
  });

  it('accepts a valid username and creates a session', async () => {
    const csrf = await getCsrf();
    const loginRes = await request('POST', '/auth/local', {
      body: { username: 'TestPlayer' },
      cookies: csrf.cookies,
      headers: { 'x-csrf-token': csrf.token },
    });
    assert.equal(loginRes.status, 200);
    assert.deepEqual(loginRes.body, { success: true });

    // Use the session cookie from the login response to call /auth/me
    const allCookies = mergeCookies(csrf.cookies, loginRes.cookies);
    const meRes = await request('GET', '/auth/me', { cookies: allCookies });
    assert.equal(meRes.status, 200);
    assert.equal(meRes.body.displayName, 'TestPlayer');
  });

  it('same username logs in as the same user', async () => {
    const csrf = await getCsrf();
    const loginRes = await request('POST', '/auth/local', {
      body: { username: 'TestPlayer' },
      cookies: csrf.cookies,
      headers: { 'x-csrf-token': csrf.token },
    });
    assert.equal(loginRes.status, 200);
  });

  it('/auth/me returns 401 when not logged in', async () => {
    const res = await request('GET', '/auth/me');
    assert.equal(res.status, 401);
  });

  it('logout clears session and cookies so /auth/me returns 401', async () => {
    // Login first
    const csrf = await getCsrf();
    const loginRes = await request('POST', '/auth/local', {
      body: { username: 'LogoutTester' },
      cookies: csrf.cookies,
      headers: { 'x-csrf-token': csrf.token },
    });
    assert.equal(loginRes.status, 200);

    const sessionCookies = mergeCookies(csrf.cookies, loginRes.cookies);

    // Verify logged in
    const meRes = await request('GET', '/auth/me', { cookies: sessionCookies });
    assert.equal(meRes.status, 200);
    assert.equal(meRes.body.displayName, 'LogoutTester');

    // Get CSRF token using existing session so it's tied to the right session
    const csrfRes = await request('GET', '/api/csrf-token', { cookies: sessionCookies });
    const logoutCookies = mergeCookies(sessionCookies, csrfRes.cookies);

    // Logout
    const logoutRes = await request('POST', '/auth/logout', {
      cookies: logoutCookies,
      headers: { 'x-csrf-token': csrfRes.body.csrfToken },
    });
    assert.equal(logoutRes.status, 200);
    assert.deepEqual(logoutRes.body, { success: true });

    // Response should clear session cookie
    const setCookieHeaders = logoutRes.headers['set-cookie'] || [];
    const clearsSession = setCookieHeaders.some(c => c.startsWith('connect.sid=') && c.includes('Expires='));
    assert.ok(clearsSession, 'logout response should clear the connect.sid cookie');

    // Using old session cookies should now fail
    const meRes2 = await request('GET', '/auth/me', { cookies: sessionCookies });
    assert.equal(meRes2.status, 401);
  });
});
