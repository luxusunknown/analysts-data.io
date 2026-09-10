import { jsonResponse, SESSION_COOKIE } from '../_utils.js';

// POST /api/logout -> clears the session cookie.
export async function onRequestPost() {
  const cookie = `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
  return jsonResponse({ ok: true }, 200, { 'Set-Cookie': cookie });
}
