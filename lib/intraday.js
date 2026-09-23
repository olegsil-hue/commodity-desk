const ISS = "https://iss.moex.com";

const SLOTS = [
  { id: "5m", label: "5 минут", minutes: 5, lookback: 6 },
  { id: "15m", label: "15 минут", minutes: 15, lookback: 4 },
  { id: "30m", label: "30 минут", minutes: 30, lookback: 4 },
  { id: "1h", label: "1 час", minutes: 60, lookback: 4 },
];

let cache = { at: 0, clock: null };

function parseIssBody(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no json");
  return JSON.parse(text.slice(start, end + 1));
}

async function fetchText(url) {
  const headers = { "User-Agent": "commodity-radar" };
  const direct = await fetch(url, { headers, signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (direct && direct.ok) return direct.text();
  const via = await fetch(`https://r.jina.ai/${url}`, {
    headers: { ...headers, Accept: "text/plain" },
    signal: AbortSignal.timeout(12000),
  });
  if (!via.ok) throw new Error(`HTTP ${via.status}`);
  return via.text();
}

function minuteBars(json) {
  const rows = json?.candles?.data || [];
  return rows
    .map((row) => ({
      ts: Date.parse(String(row[6]).replace(" ", "T") + "+03:00"),
      close: Number(row[1]),
    }))
    .filter((bar) => Number.isFinite(bar.ts) && bar.close > 0);
}

async function fetchMinutes(secid, kind, from) {
  const path =
    kind === "stock"
      ? `${ISS}/iss/engines/stock/markets/shares/boards/TQBR/securities/${secid}/candles.json`
      : `${ISS}/iss/engines/futures/markets/forts/securities/${secid}/candles.json`;
  const url = `${path}?interval=1&from=${from}&iss.meta=off`;
  const json = parseIssBody(await fetchText(url));
  return minuteBars(json);
}

function resample(minutes, size) {
  const buckets = new Map();
  for (const bar of minutes) {
    const key = Math.floor(bar.ts / (size * 60 * 1000));
    buckets.set(key, bar.close);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]);
}

function slotFromCloses(spec, closes) {
  const need = spec.lookback + 1;
  if (closes.length < need) {
    return {
      id: spec.id,
      label: spec.label,
      ret: null,
      direction: "wait",
      text: `Мало свечей: ${closes.length} из ${need}`,
    };
  }
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 1 - spec.lookback];
  const ret = last / prev - 1;
  const direction = ret <= -0.001 ? "down" : ret >= 0.001 ? "up" : "flat";
  const word = direction === "down" ? "падение" : direction === "up" ? "рост" : "боковик";
  return {
    id: spec.id,
    label: spec.label,
    ret,
    direction,
    text: `${word} ${(ret * 100).toFixed(2)}% за ${spec.lookback} ${spec.lookback === 1 ? "свечу" : spec.lookback < 5 ? "свечи" : "свечей"}`,
  };
}

function regimeFromSlots(slots) {
  const known = slots.filter((slot) => slot.direction !== "wait");
  const down = known.filter((slot) => slot.direction === "down").length;
  const up = known.filter((slot) => slot.direction === "up").length;
  const five = slots.find((slot) => slot.id === "5m");
  const hour = slots.find((slot) => slot.id === "1h");
  if (known.length < 2) {
    return {
      id: "nodata",
      title: "Внутри дня данных мало, держу базовые доли",
      hedgeScale: 1,
      trendScale: 1,
    };
  }
  if (down >= 3) {
    return {
      id: "press",
      title: "Слоты согласны на падение: режу страховку и увеличиваю бумаги, которые растут при дешёвой нефти",
      hedgeScale: 0.6,
      trendScale: 1.35,
    };
  }
  if (up >= 3) {
    return {
      id: "bounce",
      title: "Слоты согласны на отскок: увеличиваю страховку и срезаю ставку на падение",
      hedgeScale: 1.5,
      trendScale: 0.35,
    };
  }
  if (five && hour && five.direction === "up" && hour.direction === "down") {
    return {
      id: "pullback",
      title: "5 минут растут внутри часового падения: чуть больше страховки, ставку на падение не закрываю",
      hedgeScale: 1.25,
      trendScale: 0.85,
    };
  }
  return {
    id: "mixed",
    title: "Слоты спорят, оставляю базовые доли заработка на падении",
    hedgeScale: 1,
    trendScale: 1,
  };
}

function clockFromMinutes(minutes) {
  const slots = SLOTS.map((spec) => slotFromCloses(spec, resample(minutes, spec.minutes)));
  return { slots, regime: regimeFromSlots(slots), asOf: new Date().toISOString() };
}

async function loadBrentClock(contract) {
  if (cache.clock && Date.now() - cache.at < 45_000) return cache.clock;
  const day = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(day + "T12:00:00Z") - 24 * 3600 * 1000).toISOString().slice(0, 10);
  try {
    const [today, prior] = await Promise.all([
      fetchMinutes(contract, "fut", day),
      fetchMinutes(contract, "fut", yesterday),
    ]);
    const minutes = [...prior, ...today].filter((bar, index, all) => all.findIndex((item) => item.ts === bar.ts) === index);
    const clock = clockFromMinutes(minutes.sort((a, b) => a.ts - b.ts));
    clock.source = `${contract}, минутные свечи MOEX`;
    cache = { at: Date.now(), clock };
    return clock;
  } catch (err) {
    const clock = clockFromMinutes([]);
    clock.source = err.message;
    return clock;
  }
}

module.exports = { SLOTS, clockFromMinutes, loadBrentClock, regimeFromSlots };
