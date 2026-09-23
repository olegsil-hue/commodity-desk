const fs = require("fs");
const path = require("path");

const BOOK = path.join(__dirname, "..", "data", "watch-book.json");
const OVERRIDES = path.join(__dirname, "..", "data", "overrides.json");
const CHECKS = path.join(__dirname, "..", "data", "checkpoints.json");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function loadOverrides() {
  return readJson(OVERRIDES, { pauseSlots: false, marks: {}, legs: {} });
}

function saveOverrides(patch) {
  const next = { ...loadOverrides(), ...patch };
  writeJson(OVERRIDES, next);
  return next;
}

function dayPct(quote) {
  if (!quote?.last || !quote?.prev) return null;
  return quote.last / quote.prev - 1;
}

function buildWatch(quotes) {
  const book = readJson(BOOK, { positions: [] });
  const overrides = loadOverrides();
  const usd = quotes.USD000UTSTOM?.last || 85;
  const rows = book.positions.map((position) => {
    const quote = quotes[position.id] || {};
    const broker = Number(overrides.marks?.[position.key]);
    const mark = broker > 0 ? broker : quote.last;
    const pnl = mark > 0 ? (position.entry - mark) * position.lot * usd * position.qty : null;
    const fromEntry = mark > 0 ? mark / position.entry - 1 : null;
    const gap = mark > 0 ? (mark - position.target) / position.entry : null;
    return {
      ...position,
      exchange: quote.last || null,
      prev: quote.prev || null,
      dayPct: dayPct(quote),
      broker: broker > 0 ? broker : null,
      mark: mark || null,
      fromEntry,
      gap,
      hit: mark > 0 && mark <= position.target,
      pnl,
    };
  });
  const notional = rows.reduce((sum, row) => sum + row.entry * row.lot * usd * row.qty, 0);
  const pnl = rows.reduce((sum, row) => sum + (row.pnl || 0), 0);
  const brDay = dayPct(quotes.BRV6);
  const rosnDay = dayPct(quotes.ROSN);
  const dropRosn = brDay != null && rosnDay != null && rosnDay > 0 && brDay < 0.002;
  return {
    rows,
    notional,
    pnl,
    usd,
    brDay,
    rosnDay,
    dropIds: dropRosn ? ["ROSN"] : [],
    asOf: new Date().toISOString(),
    exchangeTime: quotes.BRV6?.time || null,
    overrides,
    checkpoints: readJson(CHECKS, []),
  };
}

function saveMarks(marks) {
  const overrides = loadOverrides();
  overrides.marks = { ...(overrides.marks || {}), ...marks };
  writeJson(OVERRIDES, overrides);
  return overrides;
}

function saveLegs(legs, pauseSlots) {
  const overrides = loadOverrides();
  overrides.legs = legs || overrides.legs;
  if (typeof pauseSlots === "boolean") overrides.pauseSlots = pauseSlots;
  writeJson(OVERRIDES, overrides);
  return overrides;
}

function checkpoint(watch) {
  const list = readJson(CHECKS, []);
  list.unshift({
    at: watch.asOf,
    pnl: watch.pnl,
    brDay: watch.brDay,
    rosnDay: watch.rosnDay,
    rows: watch.rows.map((row) => ({
      key: row.key,
      mark: row.mark,
      exchange: row.exchange,
      hit: row.hit,
      pnl: row.pnl,
    })),
  });
  writeJson(CHECKS, list.slice(0, 24));
  return list.slice(0, 24);
}

function applyOverrides(plan, overrides) {
  const legs = overrides?.legs || {};
  const orders = [];
  for (const order of plan.orders) {
    const patch = legs[order.id] || {};
    if (patch.skip) continue;
    const next = { ...order };
    if (patch.qty > 0) {
      next.qty = Math.floor(Number(patch.qty));
      next.filled = next.qty * next.price;
      next.weight = plan.notional > 0 ? next.filled / plan.notional : next.weight;
      next.pnlOnShock = next.filled * next.expectedOnShock;
      next.edited = true;
    }
    orders.push(next);
  }
  const shock = plan.shock;
  const shortPnl = -shock * plan.notional;
  const longPnl = orders.reduce((sum, order) => sum + order.pnlOnShock, 0);
  const bounceShock = -shock;
  const bounceShort = -bounceShock * plan.notional;
  const bounceLong = orders.reduce((sum, order) => sum + order.filled * order.beta20 * bounceShock, 0);
  return {
    ...plan,
    orders,
    cashRequired: orders.reduce((sum, order) => sum + order.filled, 0),
    scenarios: [
      { label: plan.scenarios[0].label, short: shortPnl, longs: longPnl, total: shortPnl + longPnl },
      { label: plan.scenarios[1].label, short: bounceShort, longs: bounceLong, total: bounceShort + bounceLong },
    ],
  };
}

module.exports = { buildWatch, loadOverrides, saveOverrides, saveMarks, saveLegs, checkpoint, applyOverrides };
