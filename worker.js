// Cloudflare Worker entry point.
//
// Cloudflare's current dashboard flow ("Workers & Pages -> Connect to Git")
// creates a *Worker*, not a classic Pages project -- so the old
// functions/api/*.js "Pages Functions" convention is never picked up, and
// a Worker with no `main` script attached is static-assets-only, which is
// exactly why "Variables cannot be added to a Worker that only has static
// assets" shows up. This file is the fix: it's a real Worker script, wired
// up in wrangler.json as `main`, so the Worker has actual code -- which is
// what unlocks Settings -> Variables and secrets in the dashboard.
//
// Routing: wrangler.json sets `assets.run_worker_first: ["/api/*"]`, so
// everything under /api/* comes here first; everything else (index.html,
// style.css, app.js, parser.js, data.json) is served directly from the
// assets binding without ever running this code.

import { sha256Hex, hmacHex, timingSafeEqual, jsonResponse, getCookie, verifySessionToken, SESSION_COOKIE, SESSION_TTL_MS } from './functions/_utils.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/login' && request.method === 'POST') {
      return handleLogin(request, env);
    }
    if (url.pathname === '/api/session' && request.method === 'GET') {
      return handleSession(request, env);
    }
    if (url.pathname === '/api/logout' && request.method === 'POST') {
      return handleLogout();
    }

    // Anything else under /api/* that doesn't match a known route.
    if (url.pathname.startsWith('/api/')) {
      return jsonResponse({ ok: false, error: 'Not found.' }, 404);
    }

    // Shouldn't normally get here (run_worker_first is scoped to /api/*),
    // but fall back to serving assets just in case.
    return env.ASSETS.fetch(request);
  }
};

async function handleLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Bad request body.' }, 400);
  }

  const username = (body && body.username) || '';
  const password = (body && body.password) || '';
  if (!username || !password) {
    return jsonResponse({ ok: false, error: 'Missing username or password.' }, 400);
  }

  const expectedUser = env.ADMIN_USERNAME || '';
  const expectedHash = env.ADMIN_PASSWORD_HASH || '';
  const secret = env.SESSION_SECRET || '';
  if (!expectedUser || !expectedHash || !secret) {
    return jsonResponse(
      { ok: false, error: 'Server missing ADMIN_USERNAME / ADMIN_PASSWORD_HASH / SESSION_SECRET env vars. Set them in this Worker\'s Settings -> Variables and secrets.' },
      500
    );
  }

  const gotHash = await sha256Hex(password);
  const userOk = timingSafeEqual(username, expectedUser);
  const passOk = timingSafeEqual(gotHash, expectedHash);
  if (!userOk || !passOk) {
    await new Promise((r) => setTimeout(r, 400)); // slow naive brute-forcing
    return jsonResponse({ ok: false, error: 'Invalid username or password.' }, 401);
  }

  const exp = Date.now() + SESSION_TTL_MS;
  const sig = await hmacHex(secret, String(exp));
  const token = `${exp}.${sig}`;
  const cookie = `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
  return jsonResponse({ ok: true }, 200, { 'Set-Cookie': cookie });
}

async function handleSession(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  const secret = env.SESSION_SECRET || '';
  const ok = secret ? await verifySessionToken(token, secret) : false;
  return jsonResponse({ loggedIn: ok });
}

async function handleLogout() {
  const cookie = `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
  return jsonResponse({ ok: true }, 200, { 'Set-Cookie': cookie });
}
