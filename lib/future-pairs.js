const fs = require("fs");
const path = require("path");
const { loadFuturesBoard } = require("./quotes");

const FILE = path.join(__dirname, "..", "data", "future-hedges.json");
const ISS = "https://iss.moex.com";
const ROOTS = ["BR", "GD", "SV", "NG", "PT", "PD", "NI", "AL", "CE"];
const NAMES = {
  BR: "нефть",
  GD: "золото",
  SV: "серебро",
  NG: "газ",
  PT: "платина",
  PD: "палладий",
  NI: "никель",
  AL: "алюминий",
  CE: "медь",
};
const FRESH = 6 * 60 * 60 * 1000;

function rootOf(id) {
  return ROOTS.find((root) => id.startsWith(root)) || null;
}

function num(value) {
  return Number(value).toFixed(2).replace(".", ",");
}

function corr(xs, ys) {
  const n = xs.length;
  if (n < 30) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let dot = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    dot += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return dot / Math.sqrt(dx * dy);
}

function returnsOf(bars) {
  const out = [];
  for (let i = 1; i < bars.length; i++) {
    if (!(bars[i].close > 0) || !(bars[i - 1].close > 0)) continue;
    out.push({ date: bars[i].date, ret: bars[i].close / bars[i - 1].close - 1 });
  }
  return out;
}

function align(left, right) {
  const map = new Map(right.map((row) => [row.date, row.ret]));
  const xs = [];
  const ys = [];
  for (const row of left) {
    if (!map.has(row.date)) continue;
    xs.push(row.ret);
    ys.push(map.get(row.date));
  }
  return { xs, ys };
}

async function fetchBars(id) {
  const from = new Date(Date.now() - 160 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const url = `${ISS}/iss/engines/futures/markets/forts/securities/${id}/candles.json?interval=24&from=${from}&iss.meta=off`;
  const response = await fetch(url, { headers: { "User-Agent": "commodity-desk" }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = await response.json();
  return (json?.candles?.data || []).map((row) => ({
    date: String(row[6] || "").slice(0, 10),
    close: Number(row[1]),
  })).filter((bar) => bar.date && bar.close > 0);
}

function fronts(rows, board) {
  const best = {};
  for (const row of rows) {
    const root = rootOf(row.id);
    if (!root || !board[row.id]) continue;
    const value = Number(board[row.id].value) || 0;
    if (!best[root] || value > best[root].value) best[root] = { id: row.id, name: row.name, value };
  }
  return Object.values(best);
}

function describe(left, right, value, days) {
  const together = value >= 0.3;
  const shape = together ? "opposite" : "same";
  const link = `связь ${num(value)} за ${days} дней`;
  const text = together
    ? `${NAMES[left.root]} (${left.id}) и ${NAMES[right.root]} (${right.id}) ходят вместе, ${link}. Страховка: купить одно и продать другое.`
    : `${NAMES[left.root]} (${left.id}) и ${NAMES[right.root]} (${right.id}) ходят в разные стороны, ${link}. Страховка: оба в одну сторону.`;
  return { shape, text };
}

async function study(rows, board) {
  const picked = fronts(rows, board);
  const series = {};
  await Promise.all(picked.map(async (item) => {
    try {
      const bars = await fetchBars(item.id);
      const rets = returnsOf(bars);
      if (rets.length >= 30) series[item.id] = { ...item, root: rootOf(item.id), rets };
    } catch {
      // One quiet contract must not stop the rest.
    }
  }));
  const list = Object.values(series);
  const pairs = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const left = list[i].root === "BR" || (list[j].root !== "BR" && list[i].id < list[j].id) ? list[i] : list[j];
      const right = left === list[i] ? list[j] : list[i];
      const { xs, ys } = align(left.rets, right.rets);
      const value = corr(xs, ys);
      const oilGold = (left.root === "BR" && right.root === "GD") || (left.root === "GD" && right.root === "BR");
      if (value == null || (Math.abs(value) < 0.3 && !oilGold)) continue;
      if (oilGold && Math.abs(value) < 0.3) {
        pairs.push({
          left: left.id,
          right: right.id,
          leftName: NAMES[left.root],
          rightName: NAMES[right.root],
          corr: Number(value.toFixed(2)),
          days: xs.length,
          shape: "weak",
          text: `${NAMES[left.root]} (${left.id}) и ${NAMES[right.root]} (${right.id}) почти не связаны: ${num(value)} за ${xs.length} дней. Покупка нефти вместе с продажей золота сейчас не страховка.`,
        });
        continue;
      }
      const told = describe(left, right, value, xs.length);
      pairs.push({
        left: left.id,
        right: right.id,
        leftName: NAMES[left.root],
        rightName: NAMES[right.root],
        corr: Number(value.toFixed(2)),
        days: xs.length,
        shape: told.shape,
        text: told.text,
      });
    }
  }
  pairs.sort((a, b) => Math.abs(b.corr) - Math.abs(a.corr));
  const oil = pairs.filter((pair) => pair.left.startsWith("BR") || pair.right.startsWith("BR")).slice(0, 3);
  const rest = pairs.filter((pair) => oil.indexOf(pair) < 0).slice(0, 6);
  return oil.concat(rest);
}

function read() {
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(saved.pairs) ? saved.pairs : [];
  } catch {
    return [];
  }
}

async function ensure(rows, board) {
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (saved.pairs?.length && Date.now() - new Date(saved.at).getTime() < FRESH) return saved.pairs;
  } catch {
    // First study.
  }
  if (!rows || !board) {
    const listed = await loadFuturesBoard();
    rows = listed.rows;
    board = listed.quotes;
  }
  const pairs = await study(rows, board);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ at: new Date().toISOString(), pairs }, null, 2));
  return pairs;
}

function inBand(day) {
  return day != null && Math.abs(day) >= 0.003 && Math.abs(day) <= 0.012;
}

function pick(pairs, board, held, cool, banned, cash, room) {
  if (cash < 40000 || room < 2) return null;
  for (const pair of pairs) {
    if (pair.shape !== "opposite" || pair.corr < 0.4) continue;
    const left = board[pair.left];
    const right = board[pair.right];
    if (!inBand(left?.day) || !inBand(right?.day)) continue;
    if (Math.sign(left.day) === Math.sign(right.day)) continue;
    if (held[pair.left] || held[pair.right]) continue;
    if ((cool[pair.left] || 0) > Date.now() || (cool[pair.right] || 0) > Date.now()) continue;
    if (banned(pair.left) || banned(pair.right)) continue;
    const longId = left.day < 0 ? pair.left : pair.right;
    const shortId = longId === pair.left ? pair.right : pair.left;
    const longDay = board[longId].day;
    const shortDay = board[shortId].day;
    return {
      longId,
      shortId,
      why: `${pair.leftName} и ${pair.rightName} ходят вместе (связь ${num(pair.corr)}). Сегодня ${longId} ${(longDay * 100).toFixed(1)}%, ${shortId} +${(shortDay * 100).toFixed(1)}%: покупаю отставший и продаю ушедший, одна сторона страхует другую.`,
    };
  }
  return null;
}

function blurb(pairs) {
  return (pairs || []).slice(0, 2).map((pair) => pair.text).join(" ");
}

module.exports = { ensure, read, pick, blurb };
