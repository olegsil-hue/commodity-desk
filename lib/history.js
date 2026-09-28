const fs = require("fs");
const path = require("path");
const broker = require("./broker");

const TRADES = path.join(__dirname, "..", "data", "history-trades.json");
const STATS = path.join(__dirname, "..", "data", "history-stats.json");
const OPERATIONS = path.join(__dirname, "..", "data", "history-operations.json");
const DESK_ACCOUNT = "2052368016";
const FRESH = 24 * 60 * 60 * 1000;

function emptyStats() {
  return {
    at: null,
    from: "",
    to: "",
    followLong: { n: 0, avg: 0, wins: 0 },
    followShort: { n: 0, avg: 0, wins: 0 },
    roots: {},
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function pack(rows) {
  const n = rows.length;
  const avg = n ? rows.reduce((sum, row) => sum + row.pnl, 0) / n : 0;
  return {
    n,
    avg: Number(avg.toFixed(5)),
    wins: rows.filter((row) => row.pnl > 0).length,
  };
}

function closedRounds(rows) {
  const futures = rows.filter((row) => row.kind === "INSTRUMENT_TYPE_FUTURES" && row.price > 0 && row.qty > 0);
  const byTicker = {};
  for (const row of futures) {
    if (!byTicker[row.ticker]) byTicker[row.ticker] = [];
    byTicker[row.ticker].push(row);
  }
  const rounds = [];
  for (const [ticker, fills] of Object.entries(byTicker)) {
    fills.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    let side = "";
    let qty = 0;
    let cost = 0;
    let opened = "";
    for (const fill of fills) {
      const fillSide = fill.type === "OPERATION_TYPE_SELL" ? "sell" : "buy";
      if (!side || side === fillSide) {
        const next = qty + fill.qty;
        cost = next ? (cost * qty + fill.price * fill.qty) / next : fill.price;
        qty = next;
        side = fillSide;
        if (!opened) opened = fill.date;
        continue;
      }
      const closeQty = Math.min(qty, fill.qty);
      const pnl = side === "buy" ? fill.price / cost - 1 : cost / fill.price - 1;
      rounds.push({
        id: `hist|${ticker}|${opened}|${fill.date}`,
        ticker,
        root: String(ticker).slice(0, 2),
        side,
        qty: closeQty,
        pnl: Number(pnl.toFixed(5)),
        openAt: opened,
        at: fill.date,
      });
      qty -= closeQty;
      const left = fill.qty - closeQty;
      if (qty <= 1e-9) {
        side = "";
        qty = 0;
        cost = 0;
        opened = "";
      }
      if (left > 1e-9) {
        side = fillSide;
        qty = left;
        cost = fill.price;
        opened = fill.date;
      }
    }
  }
  return rounds;
}

function summarize(rounds) {
  const dates = rounds.flatMap((row) => [row.openAt, row.at]).filter(Boolean).sort();
  const roots = {};
  for (const row of rounds) {
    if (!roots[row.root]) roots[row.root] = [];
    roots[row.root].push(row);
  }
  const rootStats = {};
  for (const [root, list] of Object.entries(roots)) rootStats[root] = pack(list);
  return {
    at: new Date().toISOString(),
    from: dates[0] ? dates[0].slice(0, 10) : "",
    to: dates.at(-1) ? dates.at(-1).slice(0, 10) : "",
    followLong: pack(rounds.filter((row) => row.side === "buy")),
    followShort: pack(rounds.filter((row) => row.side === "sell")),
    roots: rootStats,
  };
}

function writeBooks(rounds) {
  fs.mkdirSync(path.dirname(TRADES), { recursive: true });
  fs.writeFileSync(TRADES, JSON.stringify({ at: new Date().toISOString(), rounds }));
  const stats = summarize(rounds);
  fs.writeFileSync(STATS, JSON.stringify(stats));
  return stats;
}

function stats() {
  return readJson(STATS, emptyStats());
}

async function refresh() {
  const saved = stats();
  const fresh = saved.at && Date.now() - new Date(saved.at).getTime() < FRESH;
  if (fresh && saved.followLong) return saved;
  let accounts = [];
  try {
    accounts = await broker.historyAccounts();
  } catch {
    return saved;
  }
  const account = accounts.find((item) => item.id && item.id !== DESK_ACCOUNT);
  if (!account) return saved;
  const rows = await broker.historyOperations(account.id);
  fs.writeFileSync(OPERATIONS, JSON.stringify(rows));
  return writeBooks(closedRounds(rows));
}

function rebuildFromOperations() {
  const rows = readJson(OPERATIONS, []);
  return writeBooks(closedRounds(rows));
}

module.exports = { stats, refresh, rebuildFromOperations, closedRounds };
