const fs = require("fs");
const path = require("path");
const broker = require("./broker");
const journal = require("./journal");
const sandboxRun = require("./sandbox-run");

const BUDGET = 40_000;
const FLAG = path.join(__dirname, "..", "data", "live-mirror.json");

function loadFlag() {
  try {
    return JSON.parse(fs.readFileSync(FLAG, "utf8"));
  } catch {
    return null;
  }
}

function saveFlag(payload) {
  fs.writeFileSync(FLAG, JSON.stringify(payload, null, 2));
  return payload;
}

async function planFromSandbox(cap) {
  const shot = await sandboxRun.picture();
  if (!shot.ready) {
    const error = new Error(shot.text || "Песочница не посчитана, копировать нечего.");
    error.status = 400;
    throw error;
  }
  const stocks = shot.lines.filter((line) => !line.future && line.qty > 0 && line.current > 0);
  const futures = shot.lines.filter((line) => line.future && line.qty);
  const base = stocks.reduce((sum, line) => sum + line.current * Math.abs(line.qty), 0);
  if (!(base > 0)) {
    const error = new Error("В песочнице нет акций, которые можно перенести.");
    error.status = 400;
    throw error;
  }
  const drafts = [];
  for (const line of stocks) {
    const inst = await broker.instrumentByTicker(line.ticker, "TQBR", "share", "live");
    const price = line.current;
    const lotCost = price * inst.lot;
    const target = cap * ((price * Math.abs(line.qty)) / base);
    drafts.push({
      ticker: line.ticker,
      name: inst.name,
      uid: inst.uid,
      lot: inst.lot,
      price,
      lotCost,
      target,
      lots: Math.floor(target / lotCost),
    });
  }
  let spent = drafts.reduce((sum, row) => sum + row.lots * row.lotCost, 0);
  let guard = 0;
  while (spent < cap && guard < 30) {
    guard += 1;
    const next = drafts
      .filter((row) => row.lotCost <= cap - spent)
      .sort((a, b) => (a.lots * a.lotCost) / a.target - (b.lots * b.lotCost) / b.target)[0];
    if (!next) break;
    next.lots += 1;
    spent += next.lotCost;
  }
  return {
    orders: drafts.filter((row) => row.lots > 0),
    spent,
    skippedFutures: futures.map((line) => line.ticker),
  };
}

async function mirror() {
  const existing = loadFlag();
  if (existing?.orders?.length) return { ...existing, already: true };
  const info = broker.status();
  if (!info.live?.connected) {
    const error = new Error("Боевой токен не сохранён. Вставьте его в поле «Боевой счёт» на столе, не в чат.");
    error.status = 400;
    throw error;
  }
  const list = await broker.accounts("live");
  const accountId = list[0]?.id;
  if (!accountId) {
    const error = new Error("Боевой токен не показал открытый счёт.");
    error.status = 400;
    throw error;
  }
  const liveBook = await broker.portfolio(accountId, "live");
  const cash = Number(liveBook.cash || 0);
  const cap = Math.min(BUDGET, cash);
  if (!(cap >= 1000)) {
    const error = new Error(`На боевом счёте свободно ${Math.round(cash)} ₽. Для копий заявок нужно до 40 000 ₽ свободными.`);
    error.status = 400;
    throw error;
  }
  const planned = await planFromSandbox(cap);
  const sent = [];
  for (const order of planned.orders) {
    const fill = await broker.liveMarketOrder({
      accountId,
      instrumentId: order.uid,
      lots: order.lots,
      side: "buy",
    });
    const row = journal.add({
      venue: "live",
      side: "buy",
      ticker: order.ticker,
      name: order.name,
      lots: order.lots,
      lotSize: order.lot,
      price: order.price,
      amount: fill.amount || order.lots * order.lotCost,
      orderId: fill.orderId,
      status: fill.status,
      lotsExecuted: fill.lotsExecuted,
      reason: `Копия песочницы в лимите 40 000 ₽. Оценка ${Math.round(order.lots * order.lotCost)} ₽.`,
      message: fill.message,
    });
    sent.push(row);
  }
  return saveFlag({
    at: new Date().toISOString(),
    accountId,
    budget: BUDGET,
    cash,
    cap,
    spent: Math.round(planned.spent),
    skippedFutures: planned.skippedFutures,
    orders: sent.map((row) => ({
      ticker: row.ticker,
      lots: row.lots,
      lotSize: row.lotSize,
      amount: row.amount,
      orderId: row.orderId,
      status: row.status,
    })),
  });
}

module.exports = { mirror, BUDGET };
