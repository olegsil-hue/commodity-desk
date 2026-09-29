const fs = require("fs");
const path = require("path");
const journal = require("./journal");
const history = require("./history");

const FILE = path.join(__dirname, "..", "data", "experience.json");
const ISS = "https://iss.moex.com";
const ROOTS = ["BR", "GD", "SV", "NG", "PT", "PD"];
const MONTHS = ["H", "M", "U", "Z"];
const FRESH = 24 * 60 * 60 * 1000;

function empty() {
  return { at: null, days: {}, trades: [], market: {}, own: {} };
}

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
    saved.days = saved.days || {};
    saved.trades = saved.trades || [];
    return saved;
  } catch {
    return empty();
  }
}

function save(memory) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(memory));
  return memory;
}

function num(value) {
  return Number(value).toFixed(2).replace(".", ",");
}

function contracts() {
  const list = [];
  for (const root of ROOTS) {
    for (let year = 1; year <= 6; year += 1) {
      for (const month of MONTHS) list.push(`${root}${month}${year}`);
    }
  }
  return list;
}

function rootOf(id) {
  return ROOTS.find((root) => String(id).startsWith(root)) || "";
}

function expiryRank(id) {
  const month = "FGHJKMNQUVXZ".indexOf(id.at(-2));
  const year = Number(id.at(-1));
  return year * 12 + Math.max(month, 0);
}

async function fetchBars(id) {
  const url = `${ISS}/iss/engines/futures/markets/forts/securities/${id}/candles.json?interval=24&from=2020-01-01&iss.meta=off`;
  const response = await fetch(url, { headers: { "User-Agent": "commodity-desk" }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) return [];
  const json = await response.json();
  return (json?.candles?.data || []).map((row) => ({
    date: String(row[6] || "").slice(0, 10),
    close: Number(row[1]),
  })).filter((bar) => bar.date && bar.close > 0);
}

async function marketDays() {
  const series = {};
  const ids = contracts();
  for (let i = 0; i < ids.length; i += 6) {
    const part = ids.slice(i, i + 6);
    const bars = await Promise.all(part.map(async (id) => {
      try {
        return { id, bars: await fetchBars(id) };
      } catch {
        return { id, bars: [] };
      }
    }));
    for (const item of bars) {
      if (item.bars.length < 20) continue;
      series[item.id] = item.bars;
    }
  }
  const byRoot = {};
  for (const [id, bars] of Object.entries(series)) {
    const root = rootOf(id);
    if (!byRoot[root]) byRoot[root] = [];
    const rank = expiryRank(id);
    for (let i = 1; i < bars.length; i += 1) {
      if (!(bars[i - 1].close > 0)) continue;
      byRoot[root].push({
        date: bars[i].date,
        ret: bars[i].close / bars[i - 1].close - 1,
        rank,
      });
    }
  }
  const days = {};
  for (const [root, rows] of Object.entries(byRoot)) {
    const byDate = new Map();
    for (const row of rows) {
      const prev = byDate.get(row.date);
      if (!prev || row.rank < prev.rank) byDate.set(row.date, row);
    }
    const dates = [...byDate.keys()].sort();
    for (let i = 0; i < dates.length - 1; i += 1) {
      const today = byDate.get(dates[i]);
      const next = byDate.get(dates[i + 1]);
      if (Math.abs(today.ret) < 0.003 || Math.abs(today.ret) > 0.012) continue;
      days[`${root}|${dates[i]}`] = {
        root,
        date: dates[i],
        ret: Number(today.ret.toFixed(5)),
        next: Number(next.ret.toFixed(5)),
      };
    }
  }
  return days;
}

function tally(rows) {
  const next = rows.map((row) => row.next);
  const n = next.length;
  const avg = n ? next.reduce((sum, value) => sum + value, 0) / n : 0;
  const wins = next.filter((value) => value > 0).length;
  const first = rows.map((row) => row.date).sort()[0] || "";
  const last = rows.map((row) => row.date).sort().at(-1) || "";
  return { n, avg: Number(avg.toFixed(5)), wins, first, last };
}

function marketStats(days) {
  const rows = Object.values(days);
  return {
    followLong: tally(rows.filter((row) => row.ret > 0)),
    followShort: tally(rows.filter((row) => row.ret < 0)),
  };
}

function setupOf(reason) {
  const text = String(reason || "");
  if (text.includes("страхов")) return "hedge";
  if (text.includes("коротк")) return "followShort";
  if (text.includes("беру один контракт") || text.includes("ход ещё")) return "followLong";
  return "other";
}

function rememberTrades(memory) {
  const seen = new Set(memory.trades.map((row) => row.id));
  const fills = journal.load().filter((row) => row.venue === "live" && row.ticker && row.price > 0).slice().reverse();
  const open = {};
  for (const fill of fills) {
    const ticker = fill.ticker;
    const book = open[ticker];
    if (!book || book.side === fill.side) {
      open[ticker] = { side: fill.side, price: Number(fill.price), reason: fill.reason, at: fill.at };
      continue;
    }
    const id = `${ticker}|${book.at}|${fill.at}`;
    const long = book.side === "buy";
    const pnl = long
      ? Number(fill.price) / book.price - 1
      : book.price / Number(fill.price) - 1;
    if (!seen.has(id)) {
      memory.trades.push({
        id,
        ticker,
        root: rootOf(ticker),
        setup: setupOf(book.reason),
        pnl: Number(pnl.toFixed(5)),
        at: fill.at,
      });
      seen.add(id);
    }
    delete open[ticker];
  }
}

function ownStats(trades) {
  function pack(setup) {
    const rows = trades.filter((row) => row.setup === setup);
    const n = rows.length;
    const avg = n ? rows.reduce((sum, row) => sum + row.pnl, 0) / n : 0;
    return { n, avg: Number(avg.toFixed(5)), wins: rows.filter((row) => row.pnl > 0).length };
  }
  const skipRoots = [];
  for (const root of ROOTS) {
    const rows = trades.filter((row) => row.root === root && row.setup !== "other");
    if (rows.length < 6) continue;
    const avg = rows.reduce((sum, row) => sum + row.pnl, 0) / rows.length;
    if (avg < 0) skipRoots.push(root);
  }
  return {
    followLong: pack("followLong"),
    followShort: pack("followShort"),
    hedge: pack("hedge"),
    skipRoots,
  };
}

function gate(side, market, own, archive) {
  const edge = side === "short" ? -(market.avg || 0) : (market.avg || 0);
  if (market.n >= 40 && edge <= 0) return false;
  if (own.n >= 30 && own.avg < 0) return false;
  if (archive.n >= 30 && archive.avg < 0) return false;
  if (market.n >= 40 && edge > 0) return true;
  if (own.n >= 30 && own.avg > 0) return true;
  return null;
}

function archiveRoots(archive) {
  const skipped = [];
  for (const [root, row] of Object.entries(archive.roots || {})) {
    if (!row || row.n < 6 || !(row.avg < 0)) continue;
    skipped.push(root);
  }
  return skipped;
}

function rule(memory) {
  const market = memory.market || {};
  const own = memory.own || {};
  const archive = history.stats();
  const longMarket = market.followLong || { n: 0, avg: 0 };
  const shortMarket = market.followShort || { n: 0, avg: 0 };
  const longOwn = own.followLong || { n: 0, avg: 0 };
  const shortOwn = own.followShort || { n: 0, avg: 0 };
  const longArchive = archive.followLong || { n: 0, avg: 0, wins: 0 };
  const shortArchive = archive.followShort || { n: 0, avg: 0, wins: 0 };
  const longGate = gate("long", longMarket, longOwn, longArchive);
  const shortGate = gate("short", shortMarket, shortOwn, shortArchive);
  const years = longMarket.first
    ? `${longMarket.first.slice(0, 4)}–${(longMarket.last || "").slice(0, 4)}`
    : "история ещё копится";
  const longEdge = (longMarket.avg || 0) * 100;
  const shortEdge = -(shortMarket.avg || 0) * 100;
  const longBlockedByYou = longArchive.n >= 30 && longArchive.avg < 0;
  const shortBlockedByYou = shortArchive.n >= 30 && shortArchive.avg < 0;
  const longText = longBlockedByYou
    ? `покупку растущего контракта не беру: ваши закрытые покупки фьючерсов с ${archive.from || "2020"} в среднем ${num((longArchive.avg || 0) * 100)}%, сделок ${longArchive.n}`
    : longGate === false
      ? `покупку растущего контракта не беру: за ${years} такой ход на следующий день в среднем ${num(longEdge)}%, случаев ${longMarket.n}`
      : `покупка растущего контракта за ${years} на следующий день в среднем +${num(Math.abs(longEdge))}%, случаев ${longMarket.n}`;
  const shortText = shortBlockedByYou
    ? `короткий контракт на падении не беру: ваши закрытые короткие фьючерсы с ${archive.from || "2020"} в среднем ${num((shortArchive.avg || 0) * 100)}%, сделок ${shortArchive.n}`
    : shortGate === false
      ? `короткий контракт на падении не беру: за ${years} его опыт ${num(shortEdge)}%, случаев ${shortMarket.n}`
      : `короткий контракт на падении за ${years} в среднем даёт +${num(Math.abs(shortEdge))}%, случаев ${shortMarket.n}`;
  const personal = longArchive.n || shortArchive.n
    ? ` ваши фьючерсы с ${archive.from || "2020"}: покупка ${longArchive.n} закрытых, в среднем ${num((longArchive.avg || 0) * 100)}%, из них в плюсе ${longArchive.wins}; короткая ${shortArchive.n} закрытых, в среднем ${num((shortArchive.avg || 0) * 100)}%, из них в плюсе ${shortArchive.wins}.`
    : "";
  const skipRoots = [...new Set([...(own.skipRoots || []), ...archiveRoots(archive)])];
  return {
    allowLong: longGate !== false,
    allowShort: shortGate !== false,
    skipRoots,
    text: `${longText}. ${shortText}.${personal}`,
  };
}

async function ensure() {
  const memory = load();
  rememberTrades(memory);
  try {
    await history.refresh();
  } catch {
    // The order rule still uses the last saved history file.
  }
  const stale = !memory.at || Date.now() - new Date(memory.at).getTime() > FRESH;
  if (stale || !Object.keys(memory.days).length) {
    const freshDays = await marketDays();
    memory.days = { ...memory.days, ...freshDays };
    memory.at = new Date().toISOString();
  }
  memory.market = marketStats(memory.days);
  memory.own = ownStats(memory.trades);
  return save(memory);
}

function verdict(memory) {
  const rows = Object.values(memory.days || {}).sort((a, b) => a.date.localeCompare(b.date));
  const cost = 0.001;
  const scored = rows.map((row) => (row.ret > 0 ? row.next : -row.next) - cost);
  const avg = (list) => (list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : 0);
  const last60 = scored.slice(-60);
  const last20 = scored.slice(-20);
  const ready = last60.length >= 60 && last20.length >= 20 && avg(last60) > 0 && avg(last20) > 0;
  const a60 = avg(last60) * 100;
  const a20 = avg(last20) * 100;
  const text = ready
    ? `Учёба показывает, что правило снова в плюсе после издержек: 60 дней ${num(a60)}%, 20 дней ${num(a20)}%. Торговлю сам не включаю.`
    : `Торговлю остановил и учусь. За последние 60 дней правило после издержек ${num(a60)}%, за 20 дней ${num(a20)}%. Новых сделок нет.`;
  const notice = `Можно снова торговать. За 60 дней правило после издержек ${num(a60)}%, за 20 дней ${num(a20)}%. Сам заявки не открываю — напиши, если возобновлять.`;
  return { ready, text, notice };
}

module.exports = { ensure, rule, load, verdict };
