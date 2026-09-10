import { sha256Hex, hmacHex, timingSafeEqual, jsonResponse, SESSION_COOKIE, SESSION_TTL_MS } from '../_utils.js';

// POST /api/login  { username, password }
// Checks against env vars set in the Cloudflare Pages dashboard --
// ADMIN_USERNAME, ADMIN_PASSWORD_HASH (sha256 hex of the password),
// SESSION_SECRET (random string used to sign the session cookie).
// Nothing here is shipped to the browser -- this file only ever runs on
// Cloudflare's server.
export async function onRequestPost({ request, env }) {
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
      { ok: false, error: 'Server missing ADMIN_USERNAME / ADMIN_PASSWORD_HASH / SESSION_SECRET env vars. Set them in Cloudflare Pages -> Settings -> Environment variables.' },
      500
    );
  }

  const gotHash = await sha256Hex(password);
  const userOk = timingSafeEqual(username, expectedUser);
  const passOk = timingSafeEqual(gotHash, expectedHash);
  if (!userOk || !passOk) {
    // Small deliberate delay on a wrong guess -- slows naive brute-forcing.
    // For real protection, also add a Cloudflare rate-limiting rule on
    // /api/login in the dashboard (free tier covers this) -- see README.
    await new Promise((r) => setTimeout(r, 400));
    return jsonResponse({ ok: false, error: 'Invalid username or password.' }, 401);
  }

  const exp = Date.now() + SESSION_TTL_MS;
  const sig = await hmacHex(secret, String(exp));
  const token = `${exp}.${sig}`;
  const cookie = `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;

  return jsonResponse({ ok: true }, 200, { 'Set-Cookie': cookie });
}
