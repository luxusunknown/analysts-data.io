// Cloudflare Worker entry point.
//
// Routes handled here (all under /api/* per wrangler.json run_worker_first):
//   POST /api/login      — admin login (session cookie)
//   GET  /api/session    — check if logged in
//   POST /api/logout     — clear session
//   POST /api/publish    — admin: commit merged data.json to GitHub
//   POST /api/ingest     — Discord bot: push new trades directly (INGEST_SECRET auth)
//
// Everything else (index.html, style.css, app.js, parser.js, data.json)
// is served straight from the assets binding.

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
    if (url.pathname === '/api/publish' && request.method === 'POST') {
      return handlePublish(request, env);
    }
    // ← THE FIX: Discord bot pushes recap data here after each new message
    if (url.pathname === '/api/ingest' && request.method === 'POST') {
      return handleIngest(request, env);
    }

    // Unknown /api/* route
    if (url.pathname.startsWith('/api/')) {
      return jsonResponse({ ok: false, error: 'Not found.' }, 404);
    }

    // Fall back to static assets (shouldn't normally reach here)
    return env.ASSETS.fetch(request);
  }
};

// ---------------------------------------------------------------------------
// POST /api/ingest
// Called by the Discord bot every time a new recap message lands in #recaps.
// Auth: Authorization: Bearer <INGEST_SECRET>  (set as a Worker env var)
// Body: { trades, dailySummaries, rawText?, htmlTranscript?, channelId?, timestamp? }
// Returns: { ok: true, newTradesCount: N, totalTradesCount: N }
// ---------------------------------------------------------------------------
async function handleIngest(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const secret = env.INGEST_SECRET || '';
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Bad request body.' }, 400);
  }
  if (!body || !Array.isArray(body.trades)) {
    return jsonResponse({ ok: false, error: 'Missing trades array in request body.' }, 400);
  }

  const ghToken = env.GITHUB_TOKEN || '';
  const ghRepo  = env.GITHUB_REPO  || ''; // "owner/repo"
  const ghBranch = env.GITHUB_BRANCH    || 'main';
  const ghPath   = env.GITHUB_DATA_PATH || 'data.json';
  if (!ghToken || !ghRepo) {
    return jsonResponse(
      { ok: false, error: 'Server missing GITHUB_TOKEN / GITHUB_REPO env vars. Set them in this Worker\'s Settings → Variables and secrets.' },
      500
    );
  }

  const apiUrl = `https://api.github.com/repos/${ghRepo}/contents/${encodeURIComponent(ghPath)}`;
  const ghHeaders = {
    Authorization: `Bearer ${ghToken}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'mordy-tracker-worker',
    'X-GitHub-Api-Version': '2022-11-28'
  };

  // ---- Read existing data.json from GitHub --------------------------------
  let existingTrades = [], existingDailySummaries = [], sha;
  try {
    const getRes = await fetch(`${apiUrl}?ref=${encodeURIComponent(ghBranch)}`, { headers: ghHeaders });
    if (getRes.status === 200) {
      const j = await getRes.json();
      sha = j.sha;
      // GitHub returns base64-encoded content (may have newlines)
      const rawJson = atob(j.content.replace(/[\r\n]/g, ''));
      const parsed = JSON.parse(rawJson);
      existingTrades = parsed.trades || [];
      existingDailySummaries = parsed.dailySummaries || [];
    } else if (getRes.status !== 404) {
      const errText = await getRes.text();
      return jsonResponse({ ok: false, error: `GitHub API error reading data.json (${getRes.status}): ${errText}` }, 502);
    }
    // 404 just means no data.json yet — we'll create it
  } catch (e) {
    return jsonResponse({ ok: false, error: 'Could not read data.json from GitHub: ' + e.message }, 502);
  }

  // ---- Dedupe-merge incoming trades into existing data --------------------
  const existingKeys = new Set(existingTrades.map(ingestDedupeKey));
  const newTrades = body.trades.filter(t => !existingKeys.has(ingestDedupeKey(t)));
  const mergedTrades = existingTrades.concat(newTrades);

  // Merge dailySummaries (one entry per date, no duplicates)
  const existingDates = new Set(existingDailySummaries.map(d => d.date));
  const newSummaries  = (body.dailySummaries || []).filter(d => !existingDates.has(d.date));
  const mergedSummaries = existingDailySummaries.concat(newSummaries);

  // ---- Commit merged data back to GitHub ----------------------------------
  const payloadStr = JSON.stringify({ trades: mergedTrades, dailySummaries: mergedSummaries }, null, 1);
  const contentB64 = toBase64Utf8(payloadStr);

  try {
    const putRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Auto-ingest: +${newTrades.length} trade${newTrades.length === 1 ? '' : 's'} via Discord bot (${new Date().toISOString()})`,
        content: contentB64,
        branch: ghBranch,
        ...(sha ? { sha } : {})
      })
    });
    const putJson = await putRes.json().catch(() => ({}));
    if (putRes.status !== 200 && putRes.status !== 201) {
      return jsonResponse(
        { ok: false, error: `GitHub API error committing (${putRes.status}): ${putJson.message || 'unknown error'}` },
        502
      );
    }
    const commitUrl = putJson && putJson.commit && putJson.commit.html_url;
    return jsonResponse({
      ok: true,
      newTradesCount:   newTrades.length,
      totalTradesCount: mergedTrades.length,
      commitUrl:        commitUrl || null
    });
  } catch (e) {
    return jsonResponse({ ok: false, error: 'Could not reach GitHub API: ' + e.message }, 502);
  }
}

// Same key logic as MordyParser.dedupeKey on the client — keeps both sides in sync.
function ingestDedupeKey(t) {
  return `${t.analyst}|${t.date}|${t.ticker}|${String(t.entry ?? '')}`;
}

// ---------------------------------------------------------------------------
// POST /api/login
// ---------------------------------------------------------------------------
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

  const expectedUser = env.ADMIN_USERNAME      || '';
  const expectedHash = env.ADMIN_PASSWORD_HASH || '';
  const secret       = env.SESSION_SECRET      || '';
  if (!expectedUser || !expectedHash || !secret) {
    return jsonResponse(
      { ok: false, error: 'Server missing ADMIN_USERNAME / ADMIN_PASSWORD_HASH / SESSION_SECRET env vars. Set them in this Worker\'s Settings → Variables and secrets.' },
      500
    );
  }

  const gotHash = await sha256Hex(password);
  const userOk  = timingSafeEqual(username, expectedUser);
  const passOk  = timingSafeEqual(gotHash,  expectedHash);
  if (!userOk || !passOk) {
    await new Promise((r) => setTimeout(r, 400)); // slow naive brute-forcing
    return jsonResponse({ ok: false, error: 'Invalid username or password.' }, 401);
  }

  const exp    = Date.now() + SESSION_TTL_MS;
  const sig    = await hmacHex(secret, String(exp));
  const token  = `${exp}.${sig}`;
  const cookie = `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
  return jsonResponse({ ok: true }, 200, { 'Set-Cookie': cookie });
}

// ---------------------------------------------------------------------------
// GET /api/session
// ---------------------------------------------------------------------------
async function handleSession(request, env) {
  const token  = getCookie(request, SESSION_COOKIE);
  const secret = env.SESSION_SECRET || '';
  const ok     = secret ? await verifySessionToken(token, secret) : false;
  return jsonResponse({ loggedIn: ok });
}

// ---------------------------------------------------------------------------
// POST /api/logout
// ---------------------------------------------------------------------------
async function handleLogout() {
  const cookie = `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
  return jsonResponse({ ok: true }, 200, { 'Set-Cookie': cookie });
}

// ---------------------------------------------------------------------------
// POST /api/publish   (admin: manual publish from the web panel)
// ---------------------------------------------------------------------------
async function handlePublish(request, env) {
  const token    = getCookie(request, SESSION_COOKIE);
  const secret   = env.SESSION_SECRET || '';
  const loggedIn = secret ? await verifySessionToken(token, secret) : false;
  if (!loggedIn) {
    return jsonResponse({ ok: false, error: 'Not logged in.' }, 401);
  }

  const ghToken  = env.GITHUB_TOKEN      || '';
  const ghRepo   = env.GITHUB_REPO       || ''; // "owner/repo"
  const ghBranch = env.GITHUB_BRANCH     || 'main';
  const ghPath   = env.GITHUB_DATA_PATH  || 'data.json';
  if (!ghToken || !ghRepo) {
    return jsonResponse(
      { ok: false, error: 'Server missing GITHUB_TOKEN / GITHUB_REPO env vars. Set them in this Worker\'s Settings → Variables and secrets, then redeploy. See README.md.' },
      500
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Bad request body.' }, 400);
  }
  if (!body || !Array.isArray(body.trades)) {
    return jsonResponse({ ok: false, error: 'Missing trades array in request body.' }, 400);
  }

  const payloadStr = JSON.stringify({ trades: body.trades, dailySummaries: body.dailySummaries || [] }, null, 1);
  const contentB64 = toBase64Utf8(payloadStr);

  const apiUrl = `https://api.github.com/repos/${ghRepo}/contents/${encodeURIComponent(ghPath)}`;
  const ghHeaders = {
    Authorization: `Bearer ${ghToken}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'mordy-tracker-worker',
    'X-GitHub-Api-Version': '2022-11-28'
  };

  let sha;
  try {
    const getRes = await fetch(`${apiUrl}?ref=${encodeURIComponent(ghBranch)}`, { headers: ghHeaders });
    if (getRes.status === 200) {
      const j = await getRes.json();
      sha = j.sha;
    } else if (getRes.status !== 404) {
      const errText = await getRes.text();
      return jsonResponse({ ok: false, error: `GitHub API error reading current file (${getRes.status}): ${errText}` }, 502);
    }
  } catch (e) {
    return jsonResponse({ ok: false, error: 'Could not reach GitHub API: ' + e.message }, 502);
  }

  try {
    const putRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Update ${ghPath} via admin panel (${new Date().toISOString()})`,
        content: contentB64,
        branch: ghBranch,
        ...(sha ? { sha } : {})
      })
    });
    const putJson = await putRes.json().catch(() => ({}));
    if (putRes.status !== 200 && putRes.status !== 201) {
      return jsonResponse({ ok: false, error: `GitHub API error committing (${putRes.status}): ${putJson.message || 'unknown error'}` }, 502);
    }
    const commitUrl = putJson && putJson.commit && putJson.commit.html_url;
    return jsonResponse({ ok: true, commitUrl: commitUrl || null });
  } catch (e) {
    return jsonResponse({ ok: false, error: 'Could not reach GitHub API: ' + e.message }, 502);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
