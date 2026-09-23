const fs = require("fs");
const path = require("path");
const broker = require("./broker");
const journal = require("./journal");
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
  const futures = futuresResult(ops, book.futuresValue, futQty);
  const equity = book.cash + stockValue + futures.total;
  const futureLine = lines.find((line) => line.future);
  if (futureLine) futureLine.pnl = futures.openPnl;
  return {
    ready: true,
    deposited,
    cash: book.cash,
    spent: stockSpent,
    stockValue,
    fees,
    equity,
    pnl: equity - deposited,
    futuresPnl: futures.total,
    futuresOpen: futures.openPnl,
    lines,
    brent: quotes.BRV6 || null,
    priceNote: lines.find((line) => line.ticker === "BRV6")
      ? `Боевой счёт, лимит 40 000 ₽. BR-10.26 ${lines.find((line) => line.ticker === "BRV6").current.toFixed(2)} — цена Т-Банка.`
      : "Боевой счёт, лимит 40 000 ₽. Виртуальные заявки песочницы сюда не переносятся.",
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

function futuresResult(ops, futuresValue, futQty) {
  const rows = ops
    .filter((item) => (item.type === "OPERATION_TYPE_BUY" || item.type === "OPERATION_TYPE_SELL") && FUTURE.test(item.ticker || ""))
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
      const why = gain >= limit ? "отскок или цель от входа" : gain <= -limit ? "минус от входа, отскок не случился" : "нефть развернулась";
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
  const ranked = rankBook(rows, board, brentDay, held, state.cool);
  let bought = 0;
  const room = Math.max(0, 6 - Object.keys(held).length);
  const oil = ranked.find((pick) => pick.future && /^BR/.test(pick.id));
  if (sessionOpen() && oil && !held[oil.id] && shot.cash >= 20000 && room > 0) {
    try {
      if (await buyPick(oil)) {
        state.roles[oil.id] = oil.role;
        state.cool[oil.id] = Date.now() + 20 * 60 * 1000;
        notes.push(`Купил ${oil.id}: ${oil.why}.`);
        bought += 1;
        shot.cash -= 20000;
        held[oil.id] = { ticker: oil.id, qty: 1, future: true };
      }
    } catch (err) {
      state.cool[oil.id] = Date.now() + 20 * 60 * 1000;
      notes.push(`${oil.id} не купился: ${err.message}`);
    }
  }
  const front = board.BRV6 ? "BRV6" : null;
  if (sessionOpen() && front && !oil && !held[front] && brentDay <= -0.0025 && (board[front].day || 0) <= -0.003 && shot.cash >= 20000 && (state.cool[front] || 0) <= Date.now()) {
    try {
      await deal(front, "SPBFUT", "future", 1, "sell", `нефть падает ${(brentDay * 100).toFixed(1)}%, продаю один контракт`, board[front].last);
      state.roles[front] = "short";
      state.cool[front] = Date.now() + 20 * 60 * 1000;
      notes.push(`Продал ${front}: нефть падает ${(brentDay * 100).toFixed(1)}%, один контракт.`);
      shot.cash -= 20000;
      held[front] = { ticker: front, qty: -1, future: true };
    } catch (err) {
      state.cool[front] = Date.now() + 20 * 60 * 1000;
      notes.push(`${front} не продался: ${err.message}`);
    }
  }
  if (sessionOpen() && shot.cash > 20000) {
    for (const pick of ranked) {
      if (bought >= 2 || bought >= room) break;
      if (pick.future) continue;
      const clip = Math.min(15000, shot.cash - 5000);
      if (clip < 3000) continue;
      try {
        if (!(await buyPick(pick, clip))) continue;
        state.roles[pick.id] = pick.role;
        state.cool[pick.id] = Date.now() + 20 * 60 * 1000;
        notes.push(`Купил ${pick.id}: ${pick.why}.`);
        bought += 1;
        shot.cash -= clip;
      } catch (err) {
        state.cool[pick.id] = Date.now() + 20 * 60 * 1000;
        notes.push(`${pick.id} не купился: ${err.message}`);
      }
    }
  }
  const oilIds = new Set(ranked.map((pick) => pick.id));
  const rebound = reboundPicks(rows, board, brentDay, held, state.cool, oilIds);
  if (sessionOpen() && shot.cash > 15000 && Object.keys(held).length + bought < 6 && rebound.buys[0]) {
    const pick = rebound.buys[0];
    const bounceClip = Math.min(12000, shot.cash - 5000);
    try {
      if (bounceClip >= 3000 && await buyPick(pick, bounceClip)) {
        state.roles[pick.id] = "bounce";
        state.cool[pick.id] = Date.now() + 20 * 60 * 1000;
        notes.push(`Купил ${pick.id}: ${pick.why}`);
        bought += 1;
      }
    } catch (err) {
      state.cool[pick.id] = Date.now() + 20 * 60 * 1000;
      notes.push(`${pick.id} на отскок не купился: ${err.message}`);
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
      text: "У контракта бета к нефти равна 1. Если день нефтяной в плюсе хотя бы на 0,25% и сам контракт вырос хотя бы на 0,3%, берётся один лонг. Утром нефть была около +0,9%, поэтому куплен 1 контракт. Дальше лонг закрывался около +1% от цены именно того входа (круги около 100,3 и 101,5) и открывался снова, потому что день оставался растущим.",
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
      text: "В песочнице было около 300 000 ₽, поэтому набиралось до шести бумаг примерно по 25 000 ₽. На боевом счёте лимит 40 000 ₽. Контракт нефти занимает около 20 000 ₽ гарантии, акция — до 15 000 ₽, поэтому вместе влезают две позиции. Смотрит по-прежнему всю книгу, в заявки проходит только то, на что хватает лимита.",
    },
    {
      title: "Стоп от резкого падения",
      text: "Есть, проверка примерно раз в минуту. Нефть и обычный лонг закрываются около −1% от входа. Нефтяной лонг, открытый на росте, ещё закрывается, если Brent возвращается к вчерашнему закрытию. Отскок закрывается около −0,6%. Отдельного стопа «выйти в ту же секунду, если цена рванула вниз» нет: выход будет на следующей проверке, когда убыток дойдёт до порога.",
    },
  ];
}

async function step() {
  if (running) return cache;
  running = true;
  const state = loadState();
  try {
    const shot = await picture();
    if (!shot.ready) {
      cache = { ...shot, enabled: state.enabled, lastDecision: shot.text };
      return cache;
    }
    if (!state.enabled) {
      state.lastDecision = "Автоторговля на паузе. Заявки не выставляю.";
      state.lastRun = new Date().toISOString();
      saveState(state);
      cache = { ...shot, ...state };
      return cache;
    }
    const notes = [];
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
