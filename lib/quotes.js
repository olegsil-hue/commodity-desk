const ISS = "https://iss.moex.com";

const SPECS = [
  { id: "BRV6", kind: "fut" },
  { id: "BRX6", kind: "fut" },
  { id: "ROSN", kind: "stock" },
  { id: "RNFT", kind: "stock" },
  { id: "SELG", kind: "stock" },
  { id: "SVZ6", kind: "fut" },
  { id: "USD000UTSTOM", kind: "fx" },
];

function parseIssBody(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no json");
  return JSON.parse(text.slice(start, end + 1));
}

function timeoutError(err) {
  return err?.name === "TimeoutError" || err?.name === "AbortError" || /timeout|aborted/i.test(err?.message || "");
}

async function fetchText(url) {
  const headers = { "User-Agent": "commodity-radar" };
  const direct = await fetch(url, { headers, signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (direct && direct.ok) return direct.text();
  try {
    const via = await fetch(`https://r.jina.ai/${url}`, {
      headers: { ...headers, Accept: "text/plain" },
      signal: AbortSignal.timeout(18000),
    });
    if (!via.ok) throw new Error(`Биржа ответила HTTP ${via.status}`);
    return via.text();
  } catch (err) {
    if (timeoutError(err)) throw new Error("Биржа не ответила вовремя");
    throw err;
  }
}

function quoteUrl(spec) {
  if (spec.kind === "stock") {
    return `${ISS}/iss/engines/stock/markets/shares/boards/TQBR/securities/${spec.id}.json?iss.meta=off&iss.only=marketdata,securities`;
  }
  if (spec.kind === "fx") {
    return `${ISS}/iss/engines/currency/markets/selt/boards/CETS/securities/${spec.id}.json?iss.meta=off&iss.only=marketdata,securities`;
  }
  return `${ISS}/iss/engines/futures/markets/forts/securities/${spec.id}.json?iss.meta=off&iss.only=marketdata,securities`;
}

function pick(block, name) {
  const columns = block?.columns || [];
  const row = (block?.data || [])[0];
  if (!row) return null;
  const index = columns.indexOf(name);
  return index < 0 ? null : row[index];
}

function quoteFrom(json) {
  const last = Number(pick(json.marketdata, "LAST"));
  const prev = Number(pick(json.securities, "PREVPRICE") || pick(json.marketdata, "LAST"));
  const change = Number(pick(json.marketdata, "LASTCHANGEPRCNT"));
  const settle = Number(pick(json.securities, "PREVSETTLEPRICE"));
  return {
    last: last > 0 ? last : null,
    prev: prev > 0 ? prev : null,
    settle: settle > 0 ? settle : null,
    changePct: Number.isFinite(change) ? change : null,
    time: pick(json.marketdata, "UPDATETIME") || pick(json.marketdata, "TIME") || null,
  };
}

async function loadQuote(spec) {
  const json = parseIssBody(await fetchText(quoteUrl(spec)));
  return { id: spec.id, ...quoteFrom(json) };
}

let cache = { at: 0, quotes: null };

async function loadQuotes() {
  if (cache.quotes && Date.now() - cache.at < 20_000) return cache.quotes;
  const rows = [];
  for (const spec of SPECS) {
    try {
      rows.push(await loadQuote(spec));
    } catch (err) {
      rows.push({ id: spec.id, last: null, prev: null, error: err.message });
    }
  }
  const quotes = Object.fromEntries(rows.map((row) => [row.id, row]));
  cache = { at: Date.now(), quotes };
  return quotes;
}

function rowsById(block) {
  const columns = block?.columns || [];
  const key = columns.indexOf("SECID");
  const map = new Map();
  for (const row of block?.data || []) map.set(row[key], row);
  return { columns, map };
}

function cell(pack, id, name) {
  const row = pack.map.get(id);
  if (!row) return null;
  const index = pack.columns.indexOf(name);
  return index < 0 ? null : row[index];
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function loadBoard(ids) {
  const stocks = ids.filter((id) => !/^[A-Z]{2,4}[FGHJKMNQUVXZ]\d$/.test(id));
  const futures = ids.filter((id) => /^[A-Z]{2,4}[FGHJKMNQUVXZ]\d$/.test(id));
  const out = {};
  const pull = async (kind, list) => {
    if (!list.length) return;
    const url = kind === "fut"
      ? `${ISS}/iss/engines/futures/markets/forts/securities.json?securities=${list.join(",")}&iss.meta=off&iss.only=marketdata,securities`
      : `${ISS}/iss/engines/stock/markets/shares/boards/TQBR/securities.json?securities=${list.join(",")}&iss.meta=off&iss.only=marketdata,securities`;
    const json = parseIssBody(await fetchText(url));
    const market = rowsById(json.marketdata);
    const info = rowsById(json.securities);
    for (const id of list) {
      const last = Number(cell(market, id, "LAST"));
      const prev = Number(cell(info, id, "PREVPRICE"));
      if (!(last > 0)) continue;
      out[id] = {
        last,
        prev: prev > 0 ? prev : null,
        day: prev > 0 ? last / prev - 1 : null,
        time: cell(market, id, "UPDATETIME") || cell(market, id, "TIME") || null,
      };
    }
  };
  for (const [kind, list] of [["stock", stocks], ["fut", futures]]) {
    for (const part of chunks(list, 12)) {
      try {
        await pull(kind, part);
      } catch {
        // One quiet batch must not wipe the money panel.
      }
    }
  }
  return out;
}

async function loadShareBoard() {
  const rows = [];
  const quotes = {};
  for (let start = 0; start < 3000; start += 100) {
    const url = `${ISS}/iss/engines/stock/markets/shares/boards/TQBR/securities.json?iss.meta=off&iss.only=securities,marketdata&securities.columns=SECID,SHORTNAME,PREVPRICE&marketdata.columns=SECID,LAST,VALTODAY&start=${start}`;
    const json = parseIssBody(await fetchText(url));
    const info = rowsById(json.securities);
    const market = rowsById(json.marketdata);
    const data = json.securities?.data || [];
    if (!data.length) break;
    let added = 0;
    for (const id of info.map.keys()) {
      if (quotes[id]) continue;
      const last = Number(cell(market, id, "LAST"));
      const prev = Number(cell(info, id, "PREVPRICE"));
      const value = Number(cell(market, id, "VALTODAY"));
      if (!(last > 0) || !(prev > 0)) continue;
      if (Number.isFinite(value) && value <= 0) continue;
      const name = cell(info, id, "SHORTNAME") || id;
      rows.push({ id, name, group: "Акция", kind: "stock", beta20: 0 });
      quotes[id] = { last, prev, day: last / prev - 1, time: null };
      added += 1;
    }
    if (!added || data.length < 100) break;
  }
  return { rows, quotes };
}

const FUTURE_ROOTS = /^(BR|GD|SV|NG|PT|PD|NI|AL|CE|CA|RI|MX|Si|CR|Eu|GL|NA)/;

async function loadFuturesBoard() {
  const rows = [];
  const quotes = {};
  for (let start = 0; start < 3000; start += 100) {
    const url = `${ISS}/iss/engines/futures/markets/forts/securities.json?iss.meta=off&iss.only=securities,marketdata&securities.columns=SECID,SHORTNAME,PREVPRICE,PREVSETTLEPRICE&marketdata.columns=SECID,LAST,VALTODAY&start=${start}`;
    const json = parseIssBody(await fetchText(url));
    const info = rowsById(json.securities);
    const market = rowsById(json.marketdata);
    const data = json.securities?.data || [];
    if (!data.length) break;
    let added = 0;
    for (const id of info.map.keys()) {
      if (quotes[id] || !FUTURE_ROOTS.test(id) || !/^[A-Z]{2}[FGHJKMNQUVXZ]\d$/.test(id)) continue;
      const last = Number(cell(market, id, "LAST"));
      const prev = Number(cell(info, id, "PREVPRICE") || cell(info, id, "PREVSETTLEPRICE"));
      const value = Number(cell(market, id, "VALTODAY"));
      if (!(last > 0) || !(prev > 0)) continue;
      if (Number.isFinite(value) && value <= 0) continue;
      rows.push({ id, name: cell(info, id, "SHORTNAME") || id, group: "Фьючерс", kind: "fut", beta20: 0 });
      quotes[id] = { last, prev, day: last / prev - 1, time: null, value };
      added += 1;
    }
    if (!added || data.length < 100) break;
  }
  return { rows, quotes };
}

module.exports = { loadQuotes, loadBoard, loadShareBoard, loadFuturesBoard };
