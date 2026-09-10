# Trade With Mordy — Analyst Tracker

A site that tracks every analyst's calls from the "Trade With Mordy" #recaps
Discord channel and computes win rate, profit factor, avg $/trade, worst
loss, and more — per analyst, with a date-range filter and charts.

The dashboard itself is static HTML/CSS/JS. The admin login is **real**
server-side auth — a couple of tiny serverless functions that check your
username/password against environment variables, never against anything
sitting in the page's code. That means plain GitHub Pages isn't enough on
its own (it can't run backend code) — you host this on **Cloudflare Pages**
instead, connected straight to your GitHub repo, so your day-to-day
git workflow doesn't change.

## Files

- `index.html` / `style.css` / `app.js` / `parser.js` — the dashboard
- `data.json` — the actual trade data (this is what changes every day)
- `functions/api/login.js` — checks username+password, issues a signed
  session cookie
- `functions/api/session.js` — lets the page ask "am I still logged in?"
- `functions/api/logout.js` — clears the session
- `functions/_utils.js` — shared crypto helpers for the three functions above

## 1. Push to GitHub

```
git init
git add .
git commit -m "trade with mordy tracker"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

(If you already have the repo created, skip `git init`/`remote add` and just
commit + push.)

## 2. Connect the repo to Cloudflare Pages

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → sign up/log in
   (free).
2. **Workers & Pages → Create → Pages → Connect to Git.**
3. Authorize Cloudflare on GitHub, pick this repo.
4. Build settings: **Framework preset: None**, **Build command:** (leave
   blank), **Build output directory:** `/` (repo root, since there's no
   build step — it's already plain static files).
5. **Save and Deploy.** Cloudflare picks up the `functions/` folder
   automatically — that's the whole convention, no extra config file needed.
6. You'll get a URL like `https://your-project.pages.dev`. Every future
   `git push` to `main` auto-redeploys it.

## 3. Set the real secrets

In the Cloudflare Pages project → **Settings → Environment variables**, add
these three (for the **Production** environment — add them to Preview too
if you want branch previews to also require login):

| Variable | Value |
|---|---|
| `ADMIN_USERNAME` | whatever username you want to log in with |
| `ADMIN_PASSWORD_HASH` | the SHA-256 hash of your password (see below — **not** the plain password) |
| `SESSION_SECRET` | a long random string (this signs the login session — treat it like a password) |

To get the SHA-256 hash of your chosen password, open any browser's dev
console (F12 → Console) and run:

```js
crypto.subtle.digest('SHA-256', new TextEncoder().encode('yourpassword'))
  .then(b => console.log([...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')))
```

Copy the hex string it prints → that's your `ADMIN_PASSWORD_HASH`. For
`SESSION_SECRET`, anything long and random works — e.g. run
`crypto.randomUUID() + crypto.randomUUID()` in that same console and paste
the result.

After adding the three variables, **redeploy** (Cloudflare Pages → your
project → Deployments → "..." → Retry deployment) so the running functions
pick them up.

Mark `ADMIN_PASSWORD_HASH` and `SESSION_SECRET` as **"Encrypt"** when adding
them (Cloudflare's toggle for secret values) — that keeps them hidden even
from your own dashboard view after saving.

### Is this actually secure now?

Yes, meaningfully more than before: the password check happens on
Cloudflare's server, using Web Crypto, and the browser only ever sees a
"yes"/"no" — there's no hash or secret sitting in any file a visitor can
read. A few honest caveats:
- Your password is only as strong as what you pick — this doesn't protect
  a weak/guessable password.
- There's a small built-in delay (400ms) on a wrong guess to slow naive
  brute-forcing, but for real protection also add a **Cloudflare rate
  limiting rule** on `/api/login` (dashboard → Security → WAF → Rate
  limiting rules — the free tier covers this) so repeated wrong guesses
  from one IP get blocked outright.
- The session cookie is HttpOnly + Secure + SameSite=Strict and expires
  after 12 hours, so a login doesn't linger forever.

## 4. Your daily update workflow

Each day, once the new recap posts in Discord:

1. Grab the new recap's HTML or text (View Source on the Discord web app
   and copy the relevant chunk, or just copy-paste the message text
   straight out of Discord — the parser handles both).
2. On the live site, click **Admin**, log in with your real
   username/password.
3. Paste it into the box → **Parse**. You'll get a preview of what it
   found and how many are genuinely new (it automatically skips anything
   already in `data.json`, so it's safe to paste overlapping content if
   you're not sure exactly where you left off).
4. Click **Merge into page** — updates the dashboard you're looking at
   right now, in your browser only.
5. Click **Download data.json** — saves the merged file to your computer.
6. Replace `data.json` in your GitHub repo with the downloaded one and
   commit/push (`git add data.json && git commit -m "update recap" && git
   push`, or drag-and-drop it onto the repo in GitHub's web UI).
7. Cloudflare Pages auto-redeploys in under a minute — the public site now
   shows the new day for everyone.

You can paste multiple days at once (e.g. catching up after a few days
away) — it splits on each day's recap header automatically.

*(Want this last step automated too — admin clicks "Publish" and it commits
straight to GitHub via the API instead of you downloading + pushing by
hand? That's a reasonable next step — a `functions/api/publish.js` using a
GitHub personal access token as another env var — just ask and I'll add
it.)*

## What counts as a "day" in the filters

The 7/14/20/30/60-day filters count the last N days the channel actually
posted a recap, not N calendar days — weekends/off days don't shrink the
window.

## Notes on the data

- Every number is computed straight from the emoji-marked win/loss lines in
  each analyst's `CALLS:` section, not from the channel's own daily "Total
  Trades / Winrate" footer (which blends every analyst together for the
  day). Both exist in `data.json` if you want to cross-check (`trades` vs
  `dailySummaries`).
- "Avg $ / Trade" is total profit ÷ trades that had a dollar figure — wins
  and losses blended, i.e. the expected outcome of one typical call.
- "Avg Contract Cost" is the average entry price × 100 — roughly what one
  contract costs to open, not the average realized loss (most losers get
  cut before the option goes to zero, so realized losses usually run
  smaller than this number).
- A handful of very old-format entries don't include a dollar figure (just
  a % and a win/loss marker) — those count toward win rate but not toward
  profit totals.

This is historical performance data from a Discord alert channel, not a
verified brokerage record. It's for information only, not financial advice
— nothing here accounts for real-world slippage, missed fills, or timing
lag from copy-trading an alert after the fact.
