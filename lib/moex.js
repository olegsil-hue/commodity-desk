const ISS = "https://iss.moex.com";

const UNIVERSE = [
  { id: "SBER", name: "Сбербанк", group: "Финансы", kind: "stock" },
  { id: "VTBR", name: "ВТБ", group: "Финансы", kind: "stock" },
  { id: "MOEX", name: "Мосбиржа", group: "Финансы", kind: "stock" },
  { id: "T", name: "Т-Технологии", group: "Финансы", kind: "stock" },
  { id: "CBOM", name: "МКБ", group: "Финансы", kind: "stock" },
  { id: "BSPB", name: "Банк СПб", group: "Финансы", kind: "stock" },
  { id: "LKOH", name: "Лукойл", group: "Нефть", kind: "stock" },
  { id: "ROSN", name: "Роснефть", group: "Нефть", kind: "stock" },
  { id: "TATN", name: "Татнефть", group: "Нефть", kind: "stock" },
  { id: "SNGS", name: "Сургутнефтегаз", group: "Нефть", kind: "stock" },
  { id: "TRNFP", name: "Транснефть ап", group: "Нефть", kind: "stock" },
  { id: "BANE", name: "Башнефть", group: "Нефть", kind: "stock" },
  { id: "RNFT", name: "РуссНефть", group: "Нефть", kind: "stock" },
  { id: "GAZP", name: "Газпром", group: "Газ", kind: "stock" },
  { id: "NVTK", name: "Новатэк", group: "Газ", kind: "stock" },
  { id: "GMKN", name: "Норникель", group: "Металлы", kind: "stock" },
  { id: "PLZL", name: "Полюс", group: "Металлы", kind: "stock" },
  { id: "SELG", name: "Селигдар", group: "Металлы", kind: "stock" },
  { id: "UGLD", name: "ЮГК", group: "Металлы", kind: "stock" },
  { id: "ALRS", name: "Алроса", group: "Металлы", kind: "stock" },
  { id: "CHMF", name: "Северсталь", group: "Металлы", kind: "stock" },
  { id: "NLMK", name: "НЛМК", group: "Металлы", kind: "stock" },
  { id: "MAGN", name: "ММК", group: "Металлы", kind: "stock" },
  { id: "RUAL", name: "Русал", group: "Металлы", kind: "stock" },
  { id: "PHOR", name: "ФосАгро", group: "Сырьё", kind: "stock" },
  { id: "MGNT", name: "Магнит", group: "Потребление", kind: "stock" },
  { id: "X5", name: "X5", group: "Потребление", kind: "stock" },
  { id: "OZON", name: "Озон", group: "Потребление", kind: "stock" },
  { id: "YDEX", name: "Яндекс", group: "Технологии", kind: "stock" },
  { id: "POSI", name: "Позитив", group: "Технологии", kind: "stock" },
  { id: "AFLT", name: "Аэрофлот", group: "Транспорт", kind: "stock" },
  { id: "FLOT", name: "Совкомфлот", group: "Транспорт", kind: "stock" },
  { id: "IRAO", name: "Интер РАО", group: "Электроэнергия", kind: "stock" },
  { id: "HYDR", name: "РусГидро", group: "Электроэнергия", kind: "stock" },
  { id: "MTSS", name: "МТС", group: "Телеком", kind: "stock" },
  { id: "PIKK", name: "ПИК", group: "Недвижимость", kind: "stock" },
  { id: "SMLT", name: "Самолёт", group: "Недвижимость", kind: "stock" },
  { id: "IMOEX", name: "Индекс Мосбиржи", group: "Индекс", kind: "index" },
  { id: "RTSI", name: "Индекс RTS", group: "Индекс", kind: "index" },
  { id: "RGBI", name: "Индекс ОФЗ", group: "Облигации", kind: "index" },
  { id: "MOEXOG", name: "Индекс нефти и газа", group: "Индекс", kind: "index" },
  { id: "MOEXMM", name: "Индекс металлов", group: "Индекс", kind: "index" },
  { id: "MOEXFN", name: "Индекс финансов", group: "Индекс", kind: "index" },
  { id: "USD000UTSTOM", name: "USD/RUB", group: "Валюта", kind: "fx" },
  { id: "CNYRUB_TOM", name: "CNY/RUB", group: "Валюта", kind: "fx" },
  { id: "GDZ6", name: "Золото GOLD-12.26", group: "Фьючерс", kind: "fut" },
  { id: "SVZ6", name: "Серебро SILV-12.26", group: "Фьючерс", kind: "fut" },
  { id: "NGV6", name: "Газ NG-10.26", group: "Фьючерс", kind: "fut" },
  { id: "PTZ6", name: "Платина PLT-12.26", group: "Фьючерс", kind: "fut" },
  { id: "RIZ6", name: "RTS-12.26", group: "Фьючерс", kind: "fut" },
  { id: "MXZ6", name: "MIX-12.26", group: "Фьючерс", kind: "fut" },
  { id: "SiZ6", name: "Si-12.26", group: "Фьючерс", kind: "fut" },
  { id: "CRZ6", name: "CNY-12.26", group: "Фьючерс", kind: "fut" },
];

const BRENT_CONTRACTS = ["BRK6", "BRM6", "BRN6", "BRQ6", "BRU6", "BRV6", "BRX6"];

function candleUrl(spec, from) {
  if (spec.kind === "stock") {
    return `${ISS}/iss/engines/stock/markets/shares/boards/TQBR/securities/${spec.id}/candles.json?interval=24&from=${from}&iss.meta=off`;
  }
  if (spec.kind === "index") {
    return `${ISS}/iss/engines/stock/markets/index/securities/${spec.id}/candles.json?interval=24&from=${from}&iss.meta=off`;
  }
  if (spec.kind === "fx") {
    return `${ISS}/iss/engines/currency/markets/selt/boards/CETS/securities/${spec.id}/candles.json?interval=24&from=${from}&iss.meta=off`;
  }
  return `${ISS}/iss/engines/futures/markets/forts/securities/${spec.id}/candles.json?interval=24&from=${from}&iss.meta=off`;
}

function parseIssBody(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no json");
  return JSON.parse(text.slice(start, end + 1));
}

async function fetchText(url) {
  const direct = await fetch(url, { headers: { "User-Agent": "commodity-radar" } }).catch(() => null);
  if (direct && direct.ok) return direct.text();
  const via = await fetch(`https://r.jina.ai/${url}`, {
    headers: { "User-Agent": "commodity-radar", Accept: "text/plain" },
  });
  if (!via.ok) throw new Error(`HTTP ${via.status} ${url}`);
  return via.text();
}

function barsFromCandles(json) {
  const rows = json?.candles?.data || [];
  const out = [];
  for (const row of rows) {
    const end = String(row[7] || "");
    if (end.slice(11, 13) && end.slice(11, 13) < "18") continue;
    const volume = Number(row[5]) || 0;
    out.push({ date: String(row[6]).slice(0, 10), close: Number(row[1]), volume });
  }
  return out;
}

async function fetchBars(spec, from) {
  const text = await fetchText(candleUrl(spec, from));
  const json = parseIssBody(text);
  return barsFromCandles(json);
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

function stitchFront(seriesById) {
  const byDate = new Map();
  for (const [id, bars] of Object.entries(seriesById)) {
    for (const bar of bars) {
      if (!byDate.has(bar.date)) byDate.set(bar.date, []);
      byDate.get(bar.date).push({ id, ...bar });
    }
  }
  const prev = {};
  for (const id of Object.keys(seriesById)) {
    prev[id] = new Map();
    const bars = seriesById[id];
    for (let i = 0; i < bars.length; i++) {
      if (i > 0) prev[id].set(bars[i].date, bars[i - 1].close);
    }
  }
  const dates = [...byDate.keys()].sort();
  const out = [];
  for (const date of dates) {
    const cands = byDate.get(date).filter((b) => b.volume > 0 && prev[b.id].has(date));
    if (!cands.length) continue;
    cands.sort((a, b) => b.volume - a.volume);
    const pick = cands[0];
    const yClose = prev[pick.id].get(date);
    out.push({
      date,
      close: pick.close,
      ret: pick.close / yClose - 1,
      contract: pick.id,
    });
  }
  return out;
}

function returnsFromBars(bars) {
  const out = [];
  for (let i = 1; i < bars.length; i++) {
    if (!(bars[i].close > 0) || !(bars[i - 1].close > 0)) continue;
    out.push({ date: bars[i].date, close: bars[i].close, ret: bars[i].close / bars[i - 1].close - 1 });
  }
  return out;
}

async function loadMarket(from = "2025-09-01") {
  const brentParts = {};
  const series = {};
  const errors = [];
  const jobs = [
    ...BRENT_CONTRACTS.map((id) => ({ tag: "brent", id })),
    ...UNIVERSE.map((spec) => ({ tag: "name", spec })),
  ];
  await mapPool(jobs, 4, async (job) => {
    try {
      if (job.tag === "brent") {
        brentParts[job.id] = await fetchBars({ id: job.id, kind: "fut" }, from);
      } else {
        const bars = await fetchBars(job.spec, from);
        if (bars.length >= 30) series[job.spec.id] = { ...job.spec, bars };
      }
    } catch (err) {
      errors.push(`${job.id || job.spec.id}: ${err.message}`);
    }
  });
  const brent = stitchFront(brentParts);
  return { brent, series, errors, brentParts };
}

module.exports = { UNIVERSE, BRENT_CONTRACTS, loadMarket, returnsFromBars };
