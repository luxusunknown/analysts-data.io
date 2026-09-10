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

  function computeStats(trades) {
    const byAnalyst = {};
    for (const t of trades) {
      if (!byAnalyst[t.analyst]) {
        byAnalyst[t.analyst] = {
          analyst: t.analyst, trades: 0, wins: 0, losses: 0,
          grossWin: 0, grossLoss: 0, totalProfit: 0,
          pricedTrades: 0, entrySum: 0, entryCount: 0,
          maxWin: -Infinity, maxLoss: Infinity, days: new Set()
        };
      }
      const a = byAnalyst[t.analyst];
      a.trades += 1;
      a.days.add(t.date);
      if (t.win) a.wins += 1; else a.losses += 1;
      if (typeof t.dollar === 'number' && !isNaN(t.dollar)) {
        a.totalProfit += t.dollar;
        a.pricedTrades += 1;
        if (t.dollar >= 0) a.grossWin += t.dollar; else a.grossLoss += -t.dollar;
        if (t.dollar > a.maxWin) a.maxWin = t.dollar;
        if (t.dollar < a.maxLoss) a.maxLoss = t.dollar;
      }
      if (typeof t.entry === 'number' && !isNaN(t.entry)) {
        a.entrySum += t.entry;
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

  global.MordyParser = { parseRecapText, computeStats, dedupeKey, toFlatText };
})(typeof window !== 'undefined' ? window : globalThis);
