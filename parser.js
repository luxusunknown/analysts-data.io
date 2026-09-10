/*
 * Parser for "Trade With Mordy" #recaps Discord channel exports.
 * Works on the raw HTML you get from saving/exporting the channel
 * (View Source / Save As, or a scraped chat-log export) OR on plain
 * text copy-pasted straight out of Discord.
 *
 * Exposed as window.MordyParser = { parseRecapText, computeStats, dedupeKey }
 */
(function (global) {
  'use strict';

  function decodeEntities(str) {
    return str
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&')
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, ' ');
  }

  function toFlatText(raw) {
    // Strip HTML tags (if any), decode entities, collapse whitespace.
    let text = raw.replace(/<[^>]+>/g, ' ');
    text = decodeEntities(text);
    text = text.replace(/\s+/g, ' ');
    return text;
  }

  const MONTHS = {
    JANUARY: '01', FEBRUARY: '02', MARCH: '03', APRIL: '04', MAY: '05', JUNE: '06',
    JULY: '07', AUGUST: '08', SEPTEMBER: '09', OCTOBER: '10', NOVEMBER: '11', DECEMBER: '12'
  };

  function parseDateLabel(label) {
    // "JULY 6, 2026" -> "2026-07-06"
    const m = label.trim().toUpperCase().match(/^([A-Z]+)\s+(\d+),\s*(\d+)$/);
    if (!m) return null;
    const month = MONTHS[m[1]];
    if (!month) return null;
    const day = String(m[2]).padStart(2, '0');
    const year = m[3];
    return `${year}-${month}-${day}`;
  }

  const DAY_HEADER_RE = /TRADE WITH MORDY DAILY RECAP\s*\|\s*([A-Z]+ \d+,\s*\d+)/g;
  const CALL_HEADER_RE = /([A-Z][A-Z. ]*?) CALLS:/g;
  const TRADE_FULL_RE = /(🟩|🟥)\s*\$([A-Z]+)\s*-?\s*([^\-]*?)@\s*([\d.]+)\s*-->\s*([\d.]+)\s*\|\s*([+-]?[\d,]+\.\d+)%\s*\|\s*(-?\$?[\d,]+\.\d+)/gu;
  const TRADE_NODOLLAR_RE = /(🟩|🟥)\s*\$([A-Z]+)\s*-?\s*([^\-]*?)@\s*([\d.]+)\s*-->\s*([\d.]+)\s*\|\s*([+-]?[\d,]+\.\d+)%/gu;
  const TRADE_BARE_RE = /(🟩|🟥)\s*\$([A-Z]+)\s*[^|🟩🟥]*?\|\s*([+-]?[\d,]+\.\d+)%/gu;
  const FOOTER_RE = /Total Trades:\s*(\d+)\s*Today'?s Winrate:\s*([\d.]+)%\s*Total Gains:\s*([+-][\d,]+\.\d+)%\s*Average Gains Per Call:\s*([+-][\d,]+\.\d+)%\s*Total Profits:\s*\$([\d,]+\.\d+)/;
  const TRUNCATE_MARKERS = [':GIFCryptoRiseUp:', 'PLAY OF THE DAY', 'Total Trades:'];

  function num(str) {
    return parseFloat(String(str).replace(/\$/g, '').replace(/,/g, ''));
  }

  function splitDays(text) {
    const matches = [];
    let m;
    const re = new RegExp(DAY_HEADER_RE);
    while ((m = re.exec(text)) !== null) {
      matches.push({ index: m.index, label: m[1] });
    }
    const days = [];
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].index;
      const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
      days.push({ dateLabel: matches[i].label, chunk: text.slice(start, end) });
    }
    return days;
  }

  function truncateAt(str) {
    let cut = str.length;
    for (const marker of TRUNCATE_MARKERS) {
      const idx = str.indexOf(marker);
      if (idx !== -1 && idx < cut) cut = idx;
    }
    return str.slice(0, cut);
  }

  function markConsumed(consumed, start, end) {
    for (let i = start; i < end; i++) consumed[i] = true;
  }

  function blankConsumed(str, consumed) {
    let out = '';
    for (let i = 0; i < str.length; i++) out += consumed[i] ? ' ' : str[i];
    return out;
  }

  function parseAnalystChunk(sub, dateIso, analyst, trades) {
    const consumed = new Array(sub.length).fill(false);

    let m;
    const fullRe = new RegExp(TRADE_FULL_RE);
    while ((m = fullRe.exec(sub)) !== null) {
      const [, marker, ticker, , entry, exitp, pct, dollar] = m;
      trades.push({
        date: dateIso, analyst, ticker,
        win: marker === '🟩',
        entry: num(entry), exit: num(exitp),
        pct: num(pct), dollar: num(dollar)
      });
      markConsumed(consumed, m.index, m.index + m[0].length);
    }

    let remaining = blankConsumed(sub, consumed);
    const noDollarRe = new RegExp(TRADE_NODOLLAR_RE);
    while ((m = noDollarRe.exec(remaining)) !== null) {
      const [, marker, ticker, , entry, exitp, pct] = m;
      trades.push({
        date: dateIso, analyst, ticker,
        win: marker === '🟩',
        entry: num(entry), exit: num(exitp),
        pct: num(pct), dollar: null
      });
      markConsumed(consumed, m.index, m.index + m[0].length);
    }

    let remaining2 = blankConsumed(sub, consumed);
    const bareRe = new RegExp(TRADE_BARE_RE);
    while ((m = bareRe.exec(remaining2)) !== null) {
      const [, marker, ticker, pct] = m;
      trades.push({
        date: dateIso, analyst, ticker,
        win: marker === '🟩',
        entry: null, exit: null,
        pct: num(pct), dollar: null
      });
    }
  }

  function parseRecapText(rawInput) {
    const text = toFlatText(rawInput);
    const days = splitDays(text);
    const trades = [];
    const dailySummaries = [];

    for (const { dateLabel, chunk } of days) {
      const dateIso = parseDateLabel(dateLabel);
      if (!dateIso) continue;

      const fm = chunk.match(FOOTER_RE);
      if (fm) {
        dailySummaries.push({
          date: dateIso,
          totalTrades: parseInt(fm[1], 10),
          winRate: num(fm[2]),
          totalGainsPct: num(fm[3]),
          avgGainsPct: num(fm[4]),
          totalProfit: num(fm[5])
        });
      }

      const headerMatches = [];
      let hm;
      const headerRe = new RegExp(CALL_HEADER_RE);
      while ((hm = headerRe.exec(chunk)) !== null) {
        headerMatches.push({ index: hm.index, end: headerRe.lastIndex, analyst: hm[1].trim() });
      }
      for (let i = 0; i < headerMatches.length; i++) {
        const start = headerMatches[i].end;
        const end = i + 1 < headerMatches.length ? headerMatches[i + 1].index : chunk.length;
        const sub = truncateAt(chunk.slice(start, end));
        parseAnalystChunk(sub, dateIso, headerMatches[i].analyst, trades);
      }
    }

    return { trades, dailySummaries };
  }

  function dedupeKey(t) {
    return [t.date, t.analyst, t.ticker, t.entry, t.exit, t.pct, t.dollar].join('|');
  }

  const DAY_MS = 24 * 60 * 60 * 1000;
  function dateNum(iso) { return Date.parse(iso + 'T00:00:00Z'); }

  // Collapses raw posted call-lines into logical *positions*, so a single
  // trade that gets trimmed across multiple days' recaps (same analyst,
  // same ticker, same entry price posted again within a short window)
  // counts once instead of once per trim. Without this, an analyst who
  // scales out of a winner over 3 days shows up as "3 wins" instead of
  // "1 winning trade" -- which inflates both trade count and win rate.
  //
  // Matching rule: same analyst + ticker + entry price, where each repeat
  // falls within `maxGapDays` calendar days of the previous one in that
  // chain. A gap bigger than that starts a brand-new position instead of
  // extending the old one -- e.g. reusing a common round entry price weeks
  // later is treated as a fresh, unrelated trade, not a stale trim.
  // Older bare-format lines with no entry price can't be matched this way
  // and are always counted as their own single-trim position.
  function groupPositions(trades, maxGapDays) {
    const gap = maxGapDays == null ? 10 : maxGapDays;
    const byKey = {};
    const singletons = [];

    trades.forEach((t, idx) => {
      if (typeof t.entry !== 'number' || isNaN(t.entry)) {
        singletons.push(t);
        return;
      }
      const key = t.analyst + '|' + t.ticker + '|' + t.entry.toFixed(4);
      (byKey[key] || (byKey[key] = [])).push({ t, idx });
    });

    const chains = [];
    Object.values(byKey).forEach((group) => {
      group.sort((a, b) => (a.t.date < b.t.date ? -1 : a.t.date > b.t.date ? 1 : a.idx - b.idx));
      let current = null;
      let lastDateNum = null;
      group.forEach(({ t }) => {
        const dNum = dateNum(t.date);
        if (current && lastDateNum != null && (dNum - lastDateNum) / DAY_MS <= gap) {
          current.trims.push(t);
        } else {
          current = { analyst: t.analyst, ticker: t.ticker, entry: t.entry, trims: [t] };
          chains.push(current);
        }
        lastDateNum = dNum;
      });
    });
    singletons.forEach((t) => {
      chains.push({ analyst: t.analyst, ticker: t.ticker, entry: t.entry, trims: [t] });
    });

    return chains.map((p) => {
      const trims = p.trims.slice().sort((a, b) => a.date.localeCompare(b.date));
      const dollars = trims.map((t) => t.dollar).filter((d) => typeof d === 'number' && !isNaN(d));
      const netDollar = dollars.length ? dollars.reduce((s, d) => s + d, 0) : null;
      const win = netDollar != null ? netDollar >= 0 : trims.filter((t) => t.win).length >= trims.length / 2;
      return {
        analyst: p.analyst, ticker: p.ticker, entry: p.entry,
        trims, trimCount: trims.length,
        firstDate: trims[0].date, lastDate: trims[trims.length - 1].date,
        netDollar, win
      };
    });
  }

  function computeStats(trades, opts) {
    const maxGapDays = (opts && opts.maxGapDays) != null ? opts.maxGapDays : 10;
    const positions = groupPositions(trades, maxGapDays);
    const byAnalyst = {};
    for (const p of positions) {
      if (!byAnalyst[p.analyst]) {
        byAnalyst[p.analyst] = {
          analyst: p.analyst, trades: 0, wins: 0, losses: 0,
          grossWin: 0, grossLoss: 0, totalProfit: 0,
          pricedTrades: 0, entrySum: 0, entryCount: 0,
          maxWin: -Infinity, maxLoss: Infinity, days: new Set()
        };
      }
      const a = byAnalyst[p.analyst];
      a.trades += 1;
      p.trims.forEach((t) => a.days.add(t.date));
      if (p.win) a.wins += 1; else a.losses += 1;
      if (typeof p.netDollar === 'number' && !isNaN(p.netDollar)) {
        a.totalProfit += p.netDollar;
        a.pricedTrades += 1;
        if (p.netDollar >= 0) a.grossWin += p.netDollar; else a.grossLoss += -p.netDollar;
        if (p.netDollar > a.maxWin) a.maxWin = p.netDollar;
        if (p.netDollar < a.maxLoss) a.maxLoss = p.netDollar;
      }
      if (typeof p.entry === 'number' && !isNaN(p.entry)) {
        a.entrySum += p.entry;
        a.entryCount += 1;
      }
    }
    const out = Object.values(byAnalyst).map((a) => {
      const winRate = a.trades ? (a.wins / a.trades) * 100 : 0;
      const profitFactor = a.grossLoss > 0 ? a.grossWin / a.grossLoss : (a.grossWin > 0 ? Infinity : 0);
      const avgPerTrade = a.pricedTrades ? a.totalProfit / a.pricedTrades : 0;
      const avgEntryCost = a.entryCount ? (a.entrySum / a.entryCount) * 100 : null; // *100 = per-contract cost
      const daysActive = a.days.size;
      return {
        analyst: a.analyst,
        trades: a.trades,
        wins: a.wins,
        losses: a.losses,
        winRate,
        totalProfit: a.totalProfit,
        profitFactor,
        avgPerTrade,
        maxWin: a.maxWin === -Infinity ? null : a.maxWin,
        maxLoss: a.maxLoss === Infinity ? null : a.maxLoss,
        avgEntryCost,
        daysActive,
        avgTradesPerActiveDay: daysActive ? a.trades / daysActive : 0
      };
    });
    return out;
  }

  global.MordyParser = { parseRecapText, computeStats, groupPositions, dedupeKey, toFlatText };
})(typeof window !== 'undefined' ? window : globalThis);
