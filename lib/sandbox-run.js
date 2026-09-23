const fs = require("fs");
const path = require("path");
const broker = require("./broker");
const journal = require("./journal");
const deskChat = require("./desk-chat");
const learn = require("./learn");
const { loadQuotes, loadBoard } = require("./quotes");
const BOOK = path.join(__dirname, "..", "data", "moex-book.json");

const FILE = path.join(__dirname, "..", "data", "sandbox-auto.json");
const FUTURE = /^[A-Z]{2,4}[FGHJKMNQUVXZ]\d$/;
const RELIABLE = new Set(["SBER", "LKOH", "ROSN", "GAZP", "NVTK", "GMKN", "TATN", "SNGS", "PLZL", "CHMF", "NLMK", "MGNT", "YDEX", "MOEX", "ALRS", "PHOR", "X5", "IRAO", "MTSS"]);
let running = false;
let cache = null;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {
      enabled: true,
      entries: { rise: 1, drop: 0 },
      cooldownUntil: 0,
      lastDecision: "Жду первую проверку.",
      lastRun: null,
    };
  }
}

function saveState(state) {
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  return state;
}

function mskHour(now = new Date()) {
  const shifted = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  return { hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() };
}

function sessionOpen(now) {
  const { hour, minute } = mskHour(now);
  const afterOpen = hour > 9 || (hour === 9 && minute >= 0);
  const beforeClose = hour < 18 || (hour === 18 && minute < 40);
  return afterOpen && beforeClose;
}

function moneyOf(positions, ticker) {
  return positions.find((position) => position.ticker === ticker && position.type !== "currency");
}

const LIVE_CAPITAL = 40_000;

async function picture() {
  const link = broker.status().live;
  if (!link?.connected || !link.accountId) {
    return { ready: false, text: "Боевой счёт не подключён." };
  }
  const [book, quotes, ops] = await Promise.all([
    broker.portfolio(link.accountId, "live"),
    loadQuotes(),
    broker.operations(link.accountId, "live"),
  ]);
  const usd = quotes.USD000UTSTOM?.last || 85;
  const deposited = LIVE_CAPITAL;
  const lines = book.positions
    .filter((position) => position.type !== "currency" && position.qty)
    .map((position) => {
      const moex = quotes[position.ticker]?.last || null;
      const quote = position.current || moex;
      const source = position.current ? "Т-Банк" : "MOEX";
      const future = FUTURE.test(position.ticker) || position.type === "futures";
      const cost = future ? null : position.avg * position.qty;
      const value = future ? null : quote * position.qty;
      const pnl = future ? Number(position.yield) || 0 : value - cost;
      return {
        ticker: position.ticker,
        type: position.type,
        qty: position.qty,
        avg: position.avg,
        current: quote,
        cost,
        value,
        pnl,
        future,
        source,
        moex,
      };
    });
  const fees = ops.filter((item) => item.type === "OPERATION_TYPE_BROKER_FEE").reduce((sum, item) => sum + item.payment, 0);
  const stockSpent = lines.filter((line) => !line.future).reduce((sum, line) => sum + (line.cost || 0), 0);
  const stockValue = lines.filter((line) => !line.future).reduce((sum, line) => sum + line.value, 0);
  const futQty = lines.filter((line) => line.future).reduce((sum, line) => sum + line.qty, 0);
  const booked = accruedVariation(ops);
  const futures = futuresResult(ops, book.futuresValue, futQty);
  const equity = book.cash + stockValue + futures.total;
  const futureLine = lines.find((line) => line.future);
  if (futureLine) futureLine.pnl = futures.openPnl;
  reconcileJournal(ops);
  const state = loadState();
  const brentDay = quotes.BRV6?.last && quotes.BRV6?.prev ? quotes.BRV6.last / quotes.BRV6.prev - 1 : null;
  const oilLast = lines.find((line) => line.ticker === "BRV6")?.current || quotes.BRV6?.last;
  const plan = buildPlan({
    brentDay,
    cash: book.cash,
    lines,
    roles: state.roles,
    prev: quotes.BRV6?.prev,
    oilLast,
    book: state.book,
    allowOilShort: state.allowOilShort,
    enabled: state.enabled !== false,
  });
  const free = Math.round(book.cash).toLocaleString("ru-RU");
  return {
    ready: true,
    deposited,
    cash: book.cash,
    available: book.cash,
    spent: stockSpent,
    stockValue,
    fees,
    equity,
    pnl: equity - deposited,
    futuresPnl: futQty ? futures.total : booked,
    futuresSettled: !futQty && booked !== 0,
    futuresOpen: futures.openPnl,
    lines,
    plan,
    brent: quotes.BRV6 || null,
    priceNote: oilLast
      ? `Боевой счёт. Свободно ${free} ₽. Доход считаю от стартовых 40 000 ₽. BR-10.26 ${Number(oilLast).toFixed(2)} — цена Т-Банка.`
      : `Боевой счёт. Свободно ${free} ₽. Доход считаю от стартовых 40 000 ₽.`,
    usd,
    logic: buildLogic({
      count: 42,
      brentDay: quotes.BRV6?.last && quotes.BRV6?.prev ? quotes.BRV6.last / quotes.BRV6.prev - 1 : null,
      oilLast: lines.find((line) => line.ticker === "BRV6")?.current || quotes.BRV6?.last,
      held: Object.fromEntries(lines.map((line) => [line.ticker, line])),
      ranked: [],
      rebound: { skipped: [] },
    }),
  };
}

function isVariation(item) {
  return item.type === "OPERATION_TYPE_ACCRUING_VARMARGIN" || item.type === "OPERATION_TYPE_WRITING_OFF_VARMARGIN";
}

function accruedVariation(ops) {
  return ops.filter(isVariation).reduce((sum, item) => sum + (Number(item.payment) || 0), 0);
}

function futuresResult(ops, futuresValue, futQty) {
  const settledAt = ops.filter(isVariation).reduce((max, item) => (!max || item.date > max ? item.date : max), "");
  const rows = ops
    .filter((item) => (item.type === "OPERATION_TYPE_BUY" || item.type === "OPERATION_TYPE_SELL") && FUTURE.test(item.ticker || "") && (!settledAt || item.date > settledAt))
    .slice()
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  const open = [];
  let realized = 0;
  for (const row of rows) {
    const payment = Number(row.payment) || 0;
    if (row.type === "OPERATION_TYPE_BUY") {
      if (open.length && open[open.length - 1] > 0) {
        realized += payment + open.pop();
      } else {
        open.push(payment);
      }
    } else if (open.length && open[open.length - 1] < 0) {
      realized += payment + open.pop();
    } else {
      open.push(payment);
    }
  }
  const openCost = open.reduce((sum, payment) => sum + payment, 0);
  const value = !futQty ? 0 : futQty < 0 ? -Math.abs(futuresValue || 0) : Math.abs(futuresValue || 0);
  const openPnl = value + openCost;
  return { realized, openPnl, total: realized + openPnl };
}

function heldPreview(shot) {
  return shot.lines?.find((line) => line.ticker === "BRV6")?.current || null;
}

async function deal(ticker, classCode, kind, lots, side, reason, quote) {
  const status = broker.status();
  const inst = await broker.instrumentByTicker(ticker, classCode, kind, "live");
  const fill = await broker.liveMarketOrder({
    accountId: status.live.accountId,
    instrumentId: inst.uid,
    lots,
    side,
  });
  journal.add({
    venue: "live",
    side,
    ticker,
    name: inst.name,
    lots,
    lotSize: inst.lot,
    price: quote || fill.price,
    amount: fill.amount,
    orderId: fill.orderId,
    status: fill.status,
    lotsExecuted: fill.lotsExecuted,
    reason,
    message: fill.message,
  });
  return fill;
}

function tradableBook() {
  const book = JSON.parse(fs.readFileSync(BOOK, "utf8")).book;
  const rows = book.rows.filter((row) => !["Индекс", "Валюта", "Облигации"].includes(row.group));
  if (!rows.some((row) => row.id === "BRV6")) {
    rows.push({ id: "BRV6", name: "BR-10.26", group: "Фьючерс", beta20: 1 });
  }
  return rows;
}

function rankBook(rows, board, brentDay, held, cool) {
  const list = [];
  for (const row of rows) {
    if (held[row.id] || (cool[row.id] || 0) > Date.now()) continue;
    const live = board[row.id];
    if (!live?.last || live.day == null) continue;
    const future = row.group === "Фьючерс";
    let role = null;
    if (brentDay >= 0.0025 && row.beta20 >= 0.3 && live.day >= 0.003) role = "rise";
    else if (brentDay <= -0.0025 && row.beta20 <= -0.2 && live.day >= -0.001) role = "drop";
    else if (Math.abs(brentDay) < 0.0025 && live.day >= 0.01) role = "mover";
    if (!role) continue;
    const why = role === "rise"
      ? `нефть растёт, бета ${row.beta20.toFixed(2)}, ${row.name} сегодня ${(live.day * 100).toFixed(1)}%`
      : role === "drop"
        ? `нефть падает, бета ${row.beta20.toFixed(2)}, ${row.name} не падает вместе с ней`
        : `${row.name} даёт ход дня ${(live.day * 100).toFixed(1)}%`;
    list.push({ id: row.id, name: row.name, day: live.day, last: live.last, future, role, why });
  }
  return list.sort((a, b) => Math.abs(b.day) - Math.abs(a.day));
}

async function closeLine(line, why) {
  const future = line.future || FUTURE.test(line.ticker);
  let lots = Math.round(Math.abs(line.qty));
  if (!future) {
    const inst = await broker.instrumentByTicker(line.ticker, "TQBR", "share");
    lots = Math.floor(Math.abs(line.qty) / inst.lot);
  }
  if (lots < 1) return false;
  const side = line.qty < 0 ? "buy" : "sell";
  await deal(line.ticker, future ? "SPBFUT" : "TQBR", future ? "future" : "share", lots, side, why, line.current);
  return true;
}

async function buyPick(pick, budget = 25000) {
  if (pick.future) {
    await deal(pick.id, "SPBFUT", "future", 1, "buy", pick.why, pick.last);
    return true;
  }
  const inst = await broker.instrumentByTicker(pick.id, "TQBR", "share");
  const lots = Math.floor(budget / (pick.last * inst.lot));
  if (lots < 1) return false;
  await deal(pick.id, "TQBR", "share", lots, "buy", pick.why, pick.last);
  return true;
}

function reboundPicks(rows, board, brentDay, held, cool, oilIds) {
  const buys = [];
  const skipped = [];
  for (const row of rows) {
    if (!RELIABLE.has(row.id) || row.beta20 == null) continue;
    const live = board[row.id];
    if (!live?.last || live.day == null) continue;
    const expected = row.beta20 * brentDay;
    const residual = live.day - expected;
    const crash = live.day <= -0.02 && residual <= -0.012;
    const spike = live.day >= 0.02 && residual >= 0.012;
    if (!crash && !spike) continue;
    const withOil = (brentDay <= -0.0025 && row.beta20 >= 0.3 && live.day < 0)
      || (brentDay >= 0.0025 && row.beta20 >= 0.3 && live.day > 0)
      || (brentDay <= -0.0025 && row.beta20 <= -0.2 && live.day > 0)
      || (brentDay >= 0.0025 && row.beta20 <= -0.2 && live.day < 0);
    const move = `${row.id} ${(live.day * 100).toFixed(1)}%`;
    if (withOil || oilIds.has(row.id)) {
      skipped.push(`${move}: ход совпадает со стратегией по нефти, отскок не беру`);
      continue;
    }
    if (held[row.id] || (cool[row.id] || 0) > Date.now()) continue;
    if (spike) {
      skipped.push(`${move}: взлёт без нефти, шорт акции не открываю`);
      continue;
    }
    buys.push({
      id: row.id,
      name: row.name,
      day: live.day,
      last: live.last,
      future: false,
      role: "bounce",
      why: `${row.name} упала на ${(live.day * 100).toFixed(1)}% без нефти, ожидание по бете было ${(expected * 100).toFixed(1)}%. Беру отскок.`,
    });
  }
  buys.sort((a, b) => a.day - b.day);
  return { buys, skipped };
}

async function scanAndTrade(shot, state, notes) {
  const rows = tradableBook();
  const board = await loadBoard(rows.map((row) => row.id));
  const brentLive = board.BRV6;
  const brent = heldPreview(shot) || brentLive?.last;
  const prev = brentLive?.prev || shot.brent?.prev;
  const brentDay = brent && prev ? brent / prev - 1 : 0;
  const held = Object.fromEntries(shot.lines.map((line) => [line.ticker, line]));
  state.roles = state.roles || { BRV6: "rise", ROSN: "rise" };
  state.cool = state.cool || {};
  if (brent) {
    for (const line of [...shot.lines]) {
      const role = state.roles[line.ticker] || "mover";
      const raw = line.avg > 0 ? line.current / line.avg - 1 : 0;
      const gain = line.qty < 0 ? -raw : raw;
      const row = rows.find((item) => item.id === line.ticker);
      const live = board[line.ticker];
      if (row && live?.day != null && row.beta20 != null && RELIABLE.has(line.ticker) && gain > 0) {
        const residual = live.day - row.beta20 * brentDay;
        const spike = live.day >= 0.02 && residual >= 0.012;
        const withOil = (brentDay >= 0.0025 && row.beta20 >= 0.3 && live.day > 0)
          || (brentDay <= -0.0025 && row.beta20 <= -0.2 && live.day > 0);
        if (spike && !withOil) {
          try {
            if (await closeLine(line, `${line.ticker}: неожиданный взлёт без нефти, фиксирую до отката.`)) {
              notes.push(`Продал ${line.ticker}: взлёт ${(live.day * 100).toFixed(1)}% без нефти, жду откат.`);
              delete held[line.ticker];
            }
          } catch (err) {
            notes.push(`${line.ticker} не продался: ${err.message}`);
          }
          continue;
        }
      }
      const limit = role === "bounce" ? 0.006 : 0.01;
      const thesisBreak = role === "bounce"
        ? false
        : role === "short"
          ? Boolean(prev && brent > prev)
          : (role === "rise" && prev && brent <= prev) || (role === "drop" && brentDay > 0.003);
      if (gain < limit && gain > -limit && !thesisBreak) continue;
      const from = px(line.avg);
      const nowPx = px(line.current);
      const moved = pp(gain);
      const covering = line.qty < 0;
      const why = gain >= limit
        ? (role === "bounce"
          ? `отскок от входа ${from} дал ${moved} до ${nowPx}, фиксирую`
          : covering
            ? `шорт от ${from} дал ${moved} до ${nowPx}, это цель, выкупаю`
            : `лонг от ${from} вырос на ${moved} до ${nowPx}, это цель, продаю`)
        : gain <= -limit
          ? (role === "bounce"
            ? `отскок не вышел: от входа ${from} уже ${moved} до ${nowPx}, стоп`
            : covering
              ? `стоп шорта: от входа ${from} уже ${moved} до ${nowPx}, выкупаю`
              : `стоп: от входа ${from} уже ${moved} до ${nowPx}, продаю`)
          : `нефть вернулась к вчерашнему закрытию, позицию от ${from} закрываю по ${nowPx}`;
      try {
        if (await closeLine(line, `${line.ticker}: ${why}.`)) {
          notes.push(`Продал ${line.ticker}: ${why}.`);
          delete held[line.ticker];
        }
      } catch (err) {
        notes.push(`${line.ticker} не продался: ${err.message}`);
      }
    }
  }
  await learn.ensure();
  const learnedIds = learn.candidates().map((item) => item.ticker).filter((id) => !board[id]);
  if (learnedIds.length) Object.assign(board, await loadBoard(learnedIds));
  const ranked = rankBook(rows, board, brentDay, held, state.cool);
  for (const idea of learn.candidates()) {
    if (held[idea.ticker] || ranked.some((pick) => pick.id === idea.ticker)) continue;
    if ((state.cool[idea.ticker] || 0) > Date.now()) continue;
    const live = board[idea.ticker];
    if (!live?.last || live.day == null || live.day < -0.005) continue;
    ranked.push({
      id: idea.ticker,
      name: idea.ticker,
      day: live.day,
      last: live.last,
      future: FUTURE.test(idea.ticker),
      role: "learned",
      why: `у счетов от 10 млн ₽ с доходом выше 20% годовых ${idea.ticker} в плюсе около ${idea.avg.toFixed(1)}% от их входа, карточек ${idea.n}`,
    });
  }
  let bought = 0;
  const room = Math.max(0, 6 - Object.keys(held).length);
  const front = board.BRV6 ? "BRV6" : null;
  const ideas = ranked.map((pick) => ({ ...pick, side: "buy", score: Math.abs(pick.day || 0) * 100 + learn.boost(pick.id) }));
  if (front && !held[front] && brentDay <= -0.0025 && (board[front].day || 0) <= -0.003 && (state.cool[front] || 0) <= Date.now()) {
    ideas.push({
      id: front,
      name: "BR-10.26",
      day: board[front].day,
      last: board[front].last,
      future: true,
      role: "short",
      side: "sell",
      score: Math.abs(brentDay) * 100,
      why: `нефть падает ${(brentDay * 100).toFixed(1)}%, контракт тоже в минусе, шорт только если это сильнее других идей`,
    });
  }
  const oilIds = new Set(ranked.map((pick) => pick.id));
  const rebound = reboundPicks(rows, board, brentDay, held, state.cool, oilIds);
  if (state.book !== "oil") {
    for (const pick of rebound.buys) {
      ideas.push({ ...pick, side: "buy", score: Math.abs(pick.day || 0) * 100 + learn.boost(pick.id) });
    }
  }
  ideas.sort((a, b) => b.score - a.score);
  if (sessionOpen() && room > 0) {
    for (const pick of ideas) {
      if (bought >= 3 || bought >= room) break;
      if (held[pick.id] || (state.book === "oil" && !pick.future)) continue;
      if (pick.side === "sell" && state.allowOilShort === false) continue;
      try {
        if (pick.future) {
          if (shot.cash < 20000) continue;
          if (pick.side === "sell") {
            await deal(pick.id, "SPBFUT", "future", 1, "sell", pick.why, pick.last);
            held[pick.id] = { ticker: pick.id, qty: -1, future: true };
          } else if (!(await buyPick(pick))) continue;
          else held[pick.id] = { ticker: pick.id, qty: 1, future: true };
          shot.cash -= 20000;
        } else {
          const spendable = Math.max(0, shot.cash - 5000);
          const clip = Math.min(Math.max(15000, spendable / 2), spendable);
          if (clip < 3000 || !(await buyPick(pick, clip))) continue;
          shot.cash -= clip;
        }
        state.roles[pick.id] = pick.role;
        state.cool[pick.id] = Date.now() + 20 * 60 * 1000;
        notes.push(`${pick.side === "sell" ? "Продал" : "Купил"} ${pick.id}: ${pick.why}.`);
        bought += 1;
      } catch (err) {
        state.cool[pick.id] = Date.now() + 20 * 60 * 1000;
        notes.push(`${pick.id} не прошёл: ${err.message}`);
      }
    }
  }
  if (rebound.skipped.length) notes.push(rebound.skipped.slice(0, 2).join(". ") + ".");
  if (!bought) {
    const watch = ranked.slice(0, 4).map((pick) => `${pick.id} ${(pick.day * 100).toFixed(1)}%`).join(", ");
    const bounce = rebound.buys.slice(0, 2).map((pick) => `${pick.id} ${(pick.day * 100).toFixed(1)}%`).join(", ");
    notes.push(watch
      ? `Смотрю ${rows.length} бумаг. Нефть ${(brentDay * 100).toFixed(1)}%. Ближайшие: ${watch}.`
      : `Смотрю ${rows.length} бумаг. Нефть ${(brentDay * 100).toFixed(1)}%. Подходящего хода по нефти нет.`);
    if (bounce) notes.push(`На отскок смотрю: ${bounce}.`);
  }
  state.logic = buildLogic({
    count: rows.length,
    brentDay,
    oilLast: brent,
    held,
    ranked,
    rebound,
  });
  return ranked.slice(0, 5).map((pick) => ({ id: pick.id, day: pick.day, role: pick.role }));
}

function px(value) {
  return Number(value).toFixed(2).replace(".", ",");
}

function pp(gain) {
  return `${gain >= 0 ? "+" : "−"}${Math.abs(gain * 100).toFixed(1).replace(".", ",")}%`;
}

function rub0(value) {
  return `${Math.round(Number(value) || 0).toLocaleString("ru-RU")} ₽`;
}

function positionPlan(line, role, prev) {
  const entry = Number(line.avg);
  const limit = role === "bounce" ? 0.006 : 0.01;
  const up = entry * (1 + limit);
  const down = entry * (1 - limit);
  const band = role === "bounce" ? "0,6" : "1";
  if (!(entry > 0)) return `${line.ticker}: цена входа ещё не пришла, план посчитаю на следующей сверке.`;
  if (line.qty < 0) {
    return `${line.ticker}: шорт от ${px(entry)}. Выкуплю около ${px(down)}, если падение от входа наберёт около ${band}%. Стоп — выкуп около ${px(up)}, если цена пойдёт против на те же ${band}%. Если нефть вернётся выше вчерашнего закрытия, шорт тоже закрою.`;
  }
  const thesis = role === "rise" && prev
    ? ` Ещё продам, если Brent вернётся к вчерашним ${px(prev)}, даже если плюс ${band}% не набрался.`
    : role === "drop"
      ? " Ещё продам, если нефть перестанет падать и день уйдёт в плюс больше чем на 0,3%."
      : "";
  return `${line.ticker}: лонг от ${px(entry)}. Продам около ${px(up)} — плюс около ${band}% от входа. Стоп около ${px(down)} — минус около ${band}% от входа.${thesis}`;
}

function buildPlan({ brentDay, cash, lines, roles, prev, oilLast, book, allowOilShort, enabled }) {
  const pct = brentDay == null ? null : brentDay * 100;
  const move = pct == null
    ? "Ход нефти за день ещё не посчитан"
    : `Нефть за день ${pct >= 0 ? "+" : ""}${pct.toFixed(1).replace(".", ",")} %`;
  const last = oilLast ? `, последняя ${px(oilLast)}` : "";
  let action;
  if (!enabled) {
    action = "Автоторговля на паузе. Новые заявки не ставлю. Уже открытое всё равно закрываю по цели и по стопу.";
  } else if (book === "oil") {
    action = "По команде беру только нефть, акции не покупаю.";
  } else if (pct == null) {
    action = "Жду цену нефти, чтобы выбрать лонг, шорт или тихий день.";
  } else if (pct >= 0.25) {
    action = "День растущий. Нефть не обязательна: контракт беру, только если он сильнее других идей. Иначе беру акцию, которая идёт вместе с нефтью, или бумагу, которая у крупных счетов уже в заметном плюсе.";
  } else if (pct <= -0.25) {
    action = allowOilShort === false
      ? "День падающий. Шорт нефти выключен командой. Беру самую сильную идею среди бумаг, которые не падают вместе с нефтью. Шорт акций не делаю."
      : "День падающий. Шорт нефти — один из вариантов, не обязанность. Если акция или другая идея сильнее, беру её. Шорт акций не делаю.";
  } else {
    action = "Нефть почти без хода, контракт из-за этого не обязателен. Беру бумагу с собственным ходом около +1% или ту, что лучше выглядит по учёбе на чужих счетах.";
  }
  const oilRoom = cash >= 20000
    ? "На один контракт свободных денег хватает."
    : "На гарантию контракта свободных денег сейчас не хватает.";
  const balanced = cash >= 70000
    ? `Свободно ${rub0(cash)} — хватает на нефть, бумагу по нефти, бумагу против нефти и ещё одну на отскок.`
    : cash >= 55000
      ? `Свободно ${rub0(cash)} — хватает на нефть и две акции. Запас на четвёртую бумагу появится около 70 000 ₽.`
      : `Свободно ${rub0(cash)}. Этого хватает на нефть и одну акцию. Для сбалансированной тройки — нефть, акция по нефти и акция против нефти — нужно около 55 000 ₽ свободных. С запасом на отскок — около 70 000 ₽. Увеличивать сумму не обязательно: стол торгует и так, просто книга остаётся короткой.`;
  const positions = (lines || []).map((line) => positionPlan(line, (roles || {})[line.ticker] || (line.future ? "rise" : "mover"), prev));
  if (!positions.length) {
    positions.push("Открытых позиций нет, продавать и докупать нечего. Новый вход только в основную сессию, с 09:00 до 18:40 мск, и только по правилу дня выше.");
  }
  return {
    day: `${move}${last}. ${action} ${learn.summary()} Рабочая сумма — свободные деньги на счёте, не закреплённые 40 000. 40 000 остаются точкой отсчёта дохода. ${oilRoom} ${balanced}`,
    positions,
  };
}

function reconcileJournal(ops) {
  const live = journal.load().filter((row) => row.venue === "live");
  const missing = [];
  for (const op of ops) {
    if (op.type !== "OPERATION_TYPE_BUY" && op.type !== "OPERATION_TYPE_SELL") continue;
    if (!op.ticker) continue;
    const side = op.type === "OPERATION_TYPE_BUY" ? "buy" : "sell";
    const amount = Math.abs(Number(op.payment) || 0);
    if (!(amount > 0)) continue;
    const known = live.some((row) => row.brokerOp === op.id || (
      row.ticker === op.ticker
      && row.side === side
      && Math.abs(Math.abs(Number(row.amount)) - amount) < 1
    ));
    if (!known) missing.push({ op, side, amount });
  }
  missing.sort((a, b) => new Date(a.op.date) - new Date(b.op.date));
  for (const item of missing) {
    const future = FUTURE.test(item.op.ticker);
    const lots = Math.round(Math.abs(item.op.qty) || (future ? 1 : 0));
    if (lots < 1) continue;
    journal.add({
      at: item.op.date,
      venue: "live",
      side: item.side,
      ticker: item.op.ticker,
      name: item.op.name,
      lots,
      lotSize: 1,
      price: item.op.price,
      amount: item.amount,
      orderId: item.op.id,
      brokerOp: item.op.id,
      status: "EXECUTION_REPORT_STATUS_FILL",
      lotsExecuted: lots,
      reason: "Сделка есть у брокера, в журнале стола её не было.",
    });
  }
}

function buildLogic({ count, brentDay, oilLast, held, ranked, rebound }) {
  const oilPct = brentDay == null ? "ещё не посчитан" : `${brentDay >= 0 ? "+" : ""}${(brentDay * 100).toFixed(1)}%`;
  const near = (ranked || []).slice(0, 4).map((pick) => `${pick.id} ${(pick.day * 100).toFixed(1)}%`).join(", ");
  const open = Object.keys(held || {}).join(", ") || "ничего";
  const skipped = (rebound?.skipped || []).slice(0, 2).join(". ");
  const next = near
    ? `Новые кандидаты по нефти: ${near}.`
    : "Новых кандидатов по нефти нет: подходящие уже открыты или недавно проверялись.";
  return [
    {
      title: "Что смотрел",
      text: `Книгу MOEX, ${count || 42} бумаг, и фьючерс BR-10.26. Нефть за день ${oilPct}${oilLast ? `, последняя цена ${Number(oilLast).toFixed(2)}` : ""}. ${next} Сейчас открыто: ${open}.${skipped ? ` Отскок мимо: ${skipped}.` : ""}`,
    },
    {
      title: "Почему куплен фьючерс на нефть",
      text: "Раньше контракт брался первым, как только день нефти был в плюсе. Теперь так не делается. Нефть сравнивается с остальными идеями и берётся, только если её ход сильнее. Утром 23 сентября она была лучшей идеей, поэтому лонг открывался и закрывался около +1% от своего входа. Если у акции или у бумаги из учёбы оценка выше, стол возьмёт её и нефть пропустит.",
    },
    {
      title: "Почему не продал на 102 и не открыл шорт",
      text: "102 не цель. Лонг закрывается около +1% от своего входа или когда нефть возвращается к вчерашнему закрытию. Новый шорт — один контракт — открывается только если день уже в минусе хотя бы на 0,25% и сам контракт падает хотя бы на 0,3%. Пока день зелёный, 102 для него продолжение роста, а не сигнал перевернуться.",
    },
    {
      title: "Почему нет шорта Магнита по 1625",
      text: "Шорт акций не открывается ни по какой цене, в том числе по Магниту на 1625. Магнит в списке надёжных бумаг: если упадёт больше чем на 2% и это не из-за нефти, можно купить отскок. Если он уже есть в портфеле и взлетел сам по себе, его продают. Уровня 1625 в правилах нет.",
    },
    {
      title: "Почему на тесте бумаг было много, а сейчас две",
      text: "В песочнице было около 300 000 ₽, поэтому набиралось до шести бумаг примерно по 25 000 ₽. На боевом счёте лимит — свободные рубли, не закреплённые 40 000. 40 000 только стартовая сумма для дохода. Контракт нефти занимает около 20 000 ₽ гарантии, акция берётся из оставшихся свободных. Пока свободно около 44 000 ₽, вместе влезают нефть и одна акция. Чтобы держать нефть, бумагу по нефти и бумагу против нефти, нужно около 55 000 ₽ свободных, с запасом на отскок — около 70 000 ₽.",
    },
    {
      title: "Стоп от резкого падения",
      text: "Есть, проверка примерно раз в минуту. Нефть и обычный лонг закрываются около −1% от входа. Нефтяной лонг, открытый на росте, ещё закрывается, если Brent возвращается к вчерашнему закрытию. Отскок закрывается около −0,6%. Отдельного стопа «выйти в ту же секунду, если цена рванула вниз» нет: выход будет на следующей проверке, когда убыток дойдёт до порога.",
    },
  ];
}

const NAMES = {
  НЕФТЬ: "BRV6",
  НЕФТИ: "BRV6",
  БРЕНТ: "BRV6",
  РОСНЕФТЬ: "ROSN",
  РОСНЕФТИ: "ROSN",
  МАГНИТ: "MGNT",
  МАГНИТА: "MGNT",
  ЛУКОЙЛ: "LKOH",
};

function parseCommand(text) {
  const lower = text.trim().toLowerCase().replaceAll("ё", "е");
  if (lower === "пауза" || lower === "стоп") return { type: "pause" };
  if (lower === "продолжи" || lower === "продолжить" || lower === "работай") return { type: "resume" };
  if (lower.includes("только нефт")) return { type: "book", book: "oil" };
  if (lower.includes("вся книг") || lower.includes("все бумаг")) return { type: "book", book: "all" };
  if (lower.includes("не шорт")) return { type: "oilShort", on: false };
  if (lower.includes("шорт") && lower.includes("нефт")) return { type: "oilShort", on: true };
  if (/закр(ой|ыть)\s+вс/.test(lower)) return { type: "closeAll" };
  const match = lower.match(/(?:закр(?:ой|ыть)|продай)\s+([a-zа-я0-9.-]+)/);
  if (match) return { type: "close", name: match[1].toUpperCase() };
  return { type: "unknown" };
}

function lineFor(shot, name) {
  const id = NAMES[name] || name;
  return (shot.lines || []).find((line) => line.ticker.toUpperCase() === id);
}

async function applyInbox(state, shot) {
  const notes = [];
  let items = [];
  try {
    items = await deskChat.takeInbox();
  } catch {
    return notes;
  }
  for (const item of items) {
    const before = notes.length;
    const command = parseCommand(item.text || "");
    if (command.type === "pause") {
      state.enabled = false;
      notes.push("Пауза. Новые заявки не ставлю.");
    } else if (command.type === "resume") {
      state.enabled = true;
      notes.push("Снова торгую по правилам.");
    } else if (command.type === "book") {
      state.book = command.book;
      notes.push(command.book === "oil" ? "Дальше беру только нефть." : "Снова смотрю всю книгу.");
    } else if (command.type === "oilShort") {
      state.allowOilShort = command.on;
      notes.push(command.on ? "Шорт нефти снова разрешён." : "Шорт нефти больше не открываю.");
    } else if (command.type === "closeAll" || command.type === "close") {
      const lines = command.type === "closeAll" ? [...(shot.lines || [])] : [lineFor(shot, command.name)].filter(Boolean);
      if (!lines.length) notes.push(`В портфеле нет ${command.name}.`);
      for (const line of lines) {
        try {
          if (await closeLine(line, `${line.ticker}: команда закрыть.`)) notes.push(`Закрыл ${line.ticker}.`);
          else notes.push(`${line.ticker} не закрылся.`);
        } catch (err) {
          notes.push(`${line.ticker} не закрылся: ${err.message}`);
        }
      }
    } else {
      notes.push("Не понял. Можно: закрой BRV6, закрой всё, пауза, продолжи, только нефть, вся книга, не шорти нефть.");
    }
    const fresh = notes.slice(before);
    if (fresh.length) await deskChat.reply(fresh.join(" "));
  }
  return notes;
}

async function step() {
  if (running) return cache;
  running = true;
  const state = loadState();
  try {
    const shot = await picture();
    const heard = shot.ready ? await applyInbox(state, shot) : [];
    if (!shot.ready) {
      cache = { ...shot, enabled: state.enabled, lastDecision: shot.text };
      return cache;
    }
    if (!state.enabled) {
      state.lastDecision = [heard.join(" "), "Автоторговля на паузе. Заявки не выставляю."].filter(Boolean).join(" ");
      state.lastRun = new Date().toISOString();
      saveState(state);
      cache = { ...shot, ...state };
      return cache;
    }
    const notes = heard.slice();
    const radar = await scanAndTrade(shot, state, notes);
    if (!notes.length) {
      notes.push(sessionOpen()
        ? "Книга просмотрена, новой сделки нет. Открытые бумаги держу до +1% или −1% от входа."
        : "Основная сессия закрыта. Новые заявки не ставлю, выход по цели и стопу проверяю.");
    }
    state.radar = radar;
    state.lastDecision = notes.join(" ");
    state.lastRun = new Date().toISOString();
    saveState(state);
    const fresh = notes.some((note) => note.startsWith("Купил") || note.startsWith("Продал"))
      ? await picture()
      : shot;
    cache = { ...fresh, ...state };
    return cache;
  } catch (err) {
    const text = /timeout|aborted|не ответила/i.test(err.message || "")
      ? "Биржа не ответила вовремя. Деньги на экране — последняя удачная сверка, новую заявку из-за этого не ставил."
      : err.message;
    state.lastDecision = text;
    state.lastRun = new Date().toISOString();
    saveState(state);
    cache = cache?.ready
      ? { ...cache, lastDecision: text, lastRun: state.lastRun, enabled: state.enabled, ready: true }
      : { ready: false, text, ...state };
    return cache;
  } finally {
    running = false;
  }
}

function peek() {
  return cache;
}

module.exports = { step, peek, picture };
