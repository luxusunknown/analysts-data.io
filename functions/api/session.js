import { getCookie, jsonResponse, verifySessionToken, SESSION_COOKIE } from '../_utils.js';

// GET /api/session -> { loggedIn: true|false }
// Lets the page check "am I still logged in?" on load (e.g. after a
// refresh) without re-sending a password.
export async function onRequestGet({ request, env }) {
  const token = getCookie(request, SESSION_COOKIE);
  const secret = env.SESSION_SECRET || '';
  const ok = secret ? await verifySessionToken(token, secret) : false;
  return jsonResponse({ loggedIn: ok });
}
