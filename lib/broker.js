const fs = require("fs");
const https = require("https");
const path = require("path");
const crypto = require("crypto");
const tls = require("tls");

const FILE = path.join(__dirname, "..", "data", "broker.json");
const ROOT_CA = path.join(__dirname, "..", "certs", "russian-trusted-root-ca.pem");
const SANDBOX = "tinkoff.public.invest.api.contract.v1.SandboxService/";
const PAYIN_LIMIT = 30_000_000;
const ca = [...tls.rootCertificates, fs.readFileSync(ROOT_CA, "utf8")];

function read() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return null;
  }
}

function slots() {
  const raw = read();
  let all;
  if (!raw) all = { sandbox: null, live: null };
  else if (raw.sandbox || raw.live) all = { sandbox: raw.sandbox || null, live: raw.live || null };
  else if (!raw.token) all = { sandbox: null, live: null };
  else {
    const slot = { token: raw.token, accountId: raw.accountId || "" };
    all = raw.mode === "live" ? { sandbox: null, live: slot } : { sandbox: slot, live: null };
  }
  if (process.env.TBANK_TOKEN) {
    all.live = {
      token: process.env.TBANK_TOKEN,
      accountId: process.env.TBANK_ACCOUNT_ID || all.live?.accountId || "",
    };
  }
  return all;
}

function writeSlots(next) {
  fs.writeFileSync(FILE, JSON.stringify({ sandbox: next.sandbox || null, live: next.live || null }));
}

function brief(slot) {
  if (!slot?.token) return { connected: false, tail: "", accountId: "" };
  return { connected: true, tail: String(slot.token).slice(-4), accountId: slot.accountId || "" };
}

function status() {
  const all = slots();
  const sandbox = brief(all.sandbox);
  const live = brief(all.live);
  return {
    connected: sandbox.connected || live.connected,
    mode: live.connected ? "live" : "sandbox",
    tail: live.tail || sandbox.tail,
    accountId: sandbox.accountId,
    sandbox,
    live,
  };
}

function save({ token, mode }) {
  if (typeof token !== "string" || token.trim().length < 20) {
    const error = new Error("Токен слишком короткий. Вставьте его в поле, не в чат.");
    error.status = 400;
    throw error;
  }
  const slotName = mode === "live" ? "live" : "sandbox";
  const all = slots();
  const prev = all[slotName] || {};
  all[slotName] = { token: token.trim(), accountId: prev.accountId || "" };
  writeSlots(all);
  return status();
}

function clear() {
  if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
  return status();
}

function host(mode) {
  return mode === "live"
    ? "https://invest-public-api.tbank.ru/rest/"
    : "https://sandbox-invest-public-api.tbank.ru/rest/";
}

function isSandbox() {
  return Boolean(slots().sandbox?.token);
}

function rememberAccount(accountId, mode = "sandbox") {
  const all = slots();
  const slotName = mode === "live" ? "live" : "sandbox";
  if (!all[slotName] || !accountId) return;
  all[slotName].accountId = accountId;
  writeSlots(all);
}

function rubMoney(amount) {
  const value = Number(amount);
  if (!(value > 0)) {
    const error = new Error("Пополнить песочницу можно только на положительную сумму в рублях.");
    error.status = 400;
    throw error;
  }
  if (value > PAYIN_LIMIT) {
    const error = new Error("Лимит пополнения песочницы — 30 000 000 ₽. Уменьшить баланс через API нельзя.");
    error.status = 400;
    throw error;
  }
  const units = Math.trunc(value);
  const nano = Math.round((value - units) * 1e9);
  return { currency: "rub", units: String(units), nano };
}

function postJson(url, token, body) {
  const payload = JSON.stringify(body || {});
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: target.hostname,
        path: target.pathname,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        ca,
        servername: target.hostname,
        timeout: 20000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("Таймаут песочницы Т-Банка")));
    req.on("error", reject);
    req.end(payload);
  });
}

async function call(method, body, mode = "sandbox") {
  const slotName = mode === "live" ? "live" : "sandbox";
  const slot = slots()[slotName];
  if (!slot?.token) {
    const error = new Error(slotName === "live"
      ? "Боевой токен не сохранён. Вставьте его в поле стола, не в чат."
      : "Токен песочницы не сохранён.");
    error.status = 400;
    throw error;
  }
  const response = await postJson(host(slotName) + method, slot.token, body);
  const text = response.text;
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { message: text.slice(0, 180) };
  }
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(json.description || json.message || `Брокер ответил ${response.status}`);
    error.status = response.status === 401 ? 401 : 502;
    throw error;
  }
  return json;
}

function money(value) {
  if (!value) return null;
  return Number(value.units || 0) + Number(value.nano || 0) / 1e9;
}

function mapAccounts(json, mode) {
  return (json.accounts || []).map((account) => ({
    id: account.id,
    name: account.name || (mode === "live" ? "Боевой счёт" : "Счёт песочницы"),
    type: account.type,
  }));
}

async function accounts(mode = "sandbox") {
  const slotName = mode === "live" ? "live" : "sandbox";
  const method = slotName === "live"
    ? "tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts"
    : `${SANDBOX}GetSandboxAccounts`;
  const list = mapAccounts(await call(method, { status: "ACCOUNT_STATUS_OPEN" }, slotName), slotName);
  if (list[0]) rememberAccount(list[0].id, slotName);
  return list;
}

async function openSandboxAccount() {
  if (!isSandbox()) {
    const error = new Error("Счёт песочницы открывается только в режиме песочницы.");
    error.status = 400;
    throw error;
  }
  const json = await call(`${SANDBOX}OpenSandboxAccount`, { name: "Проверка Brent" });
  const accountId = json.accountId || json.account_id;
  rememberAccount(accountId);
  return { accountId, accounts: await accounts() };
}

async function paySandbox(accountId, amount) {
  if (!isSandbox()) {
    const error = new Error("Пополнение через этот стол только для песочницы. Боевой счёт так не пополняется.");
    error.status = 400;
    throw error;
  }
  if (!accountId) {
    const error = new Error("Сначала откройте или выберите счёт песочницы.");
    error.status = 400;
    throw error;
  }
  const json = await call(`${SANDBOX}SandboxPayIn`, {
    accountId,
    amount: rubMoney(amount),
  });
  rememberAccount(accountId);
  return { accountId, balance: money(json.balance) };
}

async function portfolio(accountId, mode = "sandbox") {
  if (!accountId) {
    const error = new Error("Выберите счёт.");
    error.status = 400;
    throw error;
  }
  const slotName = mode === "live" ? "live" : "sandbox";
  const portfolioMethod = slotName === "live"
    ? "tinkoff.public.invest.api.contract.v1.OperationsService/GetPortfolio"
    : `${SANDBOX}GetSandboxPortfolio`;
  const json = await call(portfolioMethod, { accountId, currency: "RUB" }, slotName);
  const positions = (json.positions || []).map((position) => ({
    figi: position.figi,
    ticker: position.ticker || "",
    type: position.instrumentType,
    qty: money(position.quantity),
    avg: money(position.averagePositionPrice),
    current: money(position.currentPrice),
    yield: money(position.expectedYield),
  }));
  const limitsMethod = slotName === "live"
    ? "tinkoff.public.invest.api.contract.v1.OperationsService/GetPositions"
    : `${SANDBOX}GetSandboxPositions`;
  const limits = await call(limitsMethod, { accountId }, slotName);
  const rub = (limits.money || []).find((item) => String(item.currency || "").toLowerCase() === "rub");
  const cash = money(rub);
  rememberAccount(accountId, slotName);
  const total = money(json.totalAmountPortfolio);
  return { positions, cash, equity: total, futuresValue: money(json.totalAmountFutures) };
}

function units(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value) || 0;
  return Number(value.units || 0) + Number(value.nano || 0) / 1e9;
}

async function operations(accountId, mode = "sandbox") {
  const slotName = mode === "live" ? "live" : "sandbox";
  const method = slotName === "live"
    ? "tinkoff.public.invest.api.contract.v1.OperationsService/GetOperationsByCursor"
    : `${SANDBOX}GetSandboxOperationsByCursor`;
  const rows = [];
  let cursor = "";
  for (let page = 0; page < 6; page += 1) {
    const json = await call(method, {
      accountId,
      from: "2026-09-01T00:00:00Z",
      to: new Date().toISOString(),
      limit: 100,
      cursor,
      state: "OPERATION_STATE_EXECUTED",
    }, slotName);
    for (const item of json.items || json.operations || []) {
      const trade = item.tradesInfo?.trades?.[0];
      rows.push({
        id: item.id,
        type: item.type,
        payment: money(item.payment),
        price: money(item.price) || money(trade?.price),
        qty: units(item.quantity) || units(trade?.quantity),
        date: trade?.date || item.date,
        ticker: item.ticker || item.figi || "",
        name: item.name || "",
      });
    }
    if (!json.hasNext || !json.nextCursor) break;
    cursor = json.nextCursor;
  }
  return rows;
}

async function instrumentByTicker(ticker, classCode, kind, mode = "sandbox") {
  const method =
    kind === "future"
      ? "tinkoff.public.invest.api.contract.v1.InstrumentsService/FutureBy"
      : "tinkoff.public.invest.api.contract.v1.InstrumentsService/ShareBy";
  const json = await call(method, {
    idType: "INSTRUMENT_ID_TYPE_TICKER",
    classCode,
    id: ticker,
  }, mode === "live" ? "live" : "sandbox");
  const item = json.instrument || json;
  return {
    ticker: item.ticker || ticker,
    name: item.name || ticker,
    uid: item.uid,
    figi: item.figi,
    lot: Number(item.lot) || 1,
    currency: item.currency,
  };
}

async function marketOrder({ accountId, instrumentId, lots, side }) {
  if (!isSandbox()) {
    const error = new Error("Самостоятельные заявки разрешены только в песочнице.");
    error.status = 400;
    throw error;
  }
  const qty = Math.floor(Number(lots));
  if (!(qty > 0) || !accountId || !instrumentId) {
    const error = new Error("Нужны счёт, инструмент и число лотов.");
    error.status = 400;
    throw error;
  }
  const json = await call(`${SANDBOX}PostSandboxOrder`, {
    quantity: String(qty),
    direction: side === "sell" ? "ORDER_DIRECTION_SELL" : "ORDER_DIRECTION_BUY",
    accountId,
    orderType: "ORDER_TYPE_MARKET",
    orderId: crypto.randomUUID(),
    instrumentId,
  });
  return {
    orderId: json.orderId,
    status: json.executionReportStatus || "отправлено",
    lotsRequested: Number(json.lotsRequested || qty),
    lotsExecuted: Number(json.lotsExecuted || 0),
    price: money(json.executedOrderPrice) || money(json.initialSecurityPrice),
    amount: money(json.totalOrderAmount),
    message: json.message || "",
    figi: json.figi || "",
  };
}

async function liveMarketOrder({ accountId, instrumentId, lots, side }) {
  const qty = Math.floor(Number(lots));
  if (!(qty > 0) || !accountId || !instrumentId) {
    const error = new Error("Нужны боевой счёт, инструмент и число лотов.");
    error.status = 400;
    throw error;
  }
  const json = await call("tinkoff.public.invest.api.contract.v1.OrdersService/PostOrder", {
    quantity: String(qty),
    direction: side === "sell" ? "ORDER_DIRECTION_SELL" : "ORDER_DIRECTION_BUY",
    accountId,
    orderType: "ORDER_TYPE_MARKET",
    orderId: crypto.randomUUID(),
    instrumentId,
  }, "live");
  return {
    orderId: json.orderId,
    status: json.executionReportStatus || "отправлено",
    lotsRequested: Number(json.lotsRequested || qty),
    lotsExecuted: Number(json.lotsExecuted || 0),
    price: money(json.executedOrderPrice) || money(json.initialSecurityPrice),
    amount: money(json.totalOrderAmount),
    message: json.message || "",
    figi: json.figi || "",
  };
}

async function sendOrder(input) {
  if (input.confirm !== "ОТПРАВИТЬ") {
    const error = new Error("Чтобы заявка ушла брокеру, введите слово ОТПРАВИТЬ.");
    error.status = 400;
    throw error;
  }
  const qty = Math.floor(Number(input.qty));
  const price = Number(input.price);
  if (!(qty > 0) || !(price > 0) || !input.accountId || !input.ticker) {
    const error = new Error("Нужны счёт, тикер, количество и цена.");
    error.status = 400;
    throw error;
  }
  const units = Math.trunc(price);
  const nano = Math.round((price - units) * 1e9);
  const direction = input.side === "buy" ? "ORDER_DIRECTION_BUY" : "ORDER_DIRECTION_SELL";
  const method = isSandbox() ? `${SANDBOX}PostSandboxOrder` : "tinkoff.public.invest.api.contract.v1.OrdersService/PostOrder";
  const json = await call(method, {
    quantity: String(qty),
    price: { units: String(units), nano },
    direction,
    accountId: input.accountId,
    orderType: "ORDER_TYPE_LIMIT",
    orderId: crypto.randomUUID(),
    instrumentId: input.ticker,
    timeInForce: "TIME_IN_FORCE_DAY",
  });
  return {
    orderId: json.orderId,
    status: json.executionReportStatus || json.status || "отправлено",
    lots: json.lotsExecuted,
  };
}

module.exports = {
  status,
  save,
  clear,
  accounts,
  portfolio,
  sendOrder,
  openSandboxAccount,
  paySandbox,
  instrumentByTicker,
  marketOrder,
  liveMarketOrder,
  operations,
  rubMoney,
  PAYIN_LIMIT,
};
