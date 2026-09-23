const fs = require("fs");
const https = require("https");
const path = require("path");
const tls = require("tls");

const FILE = path.join(__dirname, "..", "data", "lessons.json");
const ROOT = path.join(__dirname, "..", "certs", "russian-trusted-root-ca.pem");
const ca = [...tls.rootCertificates, fs.readFileSync(ROOT, "utf8")];
const HOUR = 6 * 60 * 60 * 1000;

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.get({
      hostname: target.hostname,
      path: target.pathname + target.search,
      headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html,application/json" },
      timeout: 20000,
      ca,
      servername: target.hostname,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Пульс ответил ${res.statusCode}`));
          return;
        }
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    req.on("timeout", () => req.destroy(new Error("Пульс не ответил вовремя")));
    req.on("error", reject);
  });
}

function leaders(html) {
  const seen = new Set();
  const out = [];
  const re = /"analytics":\{"yearRelativeYield":(-?\d+(?:\.\d+)?),"totalAmountRange":\{"lower":(\d+),"upper":(null|\d+)\}/g;
  let match;
  while ((match = re.exec(html))) {
    const year = Number(match[1]);
    const lower = Number(match[2]);
    const upper = match[3] === "null" ? null : Number(match[3]);
    if (!(lower >= 10_000_000) || !(year > 20)) continue;
    if (upper != null && upper <= 10_000_000) continue;
    const before = html.slice(Math.max(0, match.index - 700), match.index);
    const ids = [...before.matchAll(/"id":"([0-9a-f-]{36})"/g)];
    const nicks = [...before.matchAll(/"nickname":"([^"]+)"/g)];
    const id = ids.at(-1)?.[1];
    const nick = nicks.at(-1)?.[1] || "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, nick, year, lower });
  }
  return out;
}

function entryPrice(price, relativeYield) {
  const ratio = Number(relativeYield) / 100;
  if (!(price > 0) || !Number.isFinite(ratio) || ratio <= -0.9) return null;
  return Number((price / (1 + ratio)).toFixed(2));
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function cards(person) {
  const text = await fetchText(`https://www.tbank.ru/api/invest-gw/social/v1/profile/${person.id}/post?limit=15`);
  const items = JSON.parse(text).payload?.items || [];
  const rows = [];
  for (const item of items) {
    const attached = item.instruments || item.extension?.instrument?.items || [];
    for (const inst of attached) {
      if (!inst.ticker || inst.relativeYield == null || !(inst.price > 0)) continue;
      rows.push({
        nick: person.nick,
        year: person.year,
        ticker: inst.ticker,
        at: item.inserted,
        price: inst.price,
        yield: Number(inst.relativeYield),
        entry: entryPrice(inst.price, inst.relativeYield),
      });
    }
  }
  return rows;
}

function pack(people, rows) {
  const byTicker = new Map();
  for (const row of rows) {
    const slot = byTicker.get(row.ticker) || [];
    slot.push(row);
    byTicker.set(row.ticker, slot);
  }
  const tickers = [...byTicker.entries()].map(([ticker, list]) => {
    const yields = list.map((row) => row.yield);
    return {
      ticker,
      avg: Number(average(yields).toFixed(2)),
      n: list.length,
      wins: yields.filter((value) => value > 0).length,
      samples: list.slice(0, 3).map((row) => ({
        nick: row.nick,
        at: row.at,
        entry: row.entry,
        price: row.price,
        yield: row.yield,
      })),
    };
  }).sort((a, b) => b.avg - a.avg);
  return {
    at: new Date().toISOString(),
    people: people.map((person) => ({ nick: person.nick, year: person.year, from: person.lower })),
    tickers: tickers.slice(0, 40),
  };
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return null;
  }
}

function save(lesson) {
  fs.writeFileSync(FILE, JSON.stringify(lesson, null, 2));
  return lesson;
}

async function study() {
  const html = await fetchText("https://www.tbank.ru/invest/pulse/");
  const found = leaders(html).slice(0, 8);
  const people = [];
  for (const person of found) {
    try {
      const text = await fetchText(`https://www.tbank.ru/api/invest-gw/social/v1/profile/nickname/${encodeURIComponent(person.nick)}`);
      const id = JSON.parse(text).payload?.id;
      if (id) people.push({ ...person, id });
    } catch {
      // Ник без открытого профиля пропускаю.
    }
  }
  const rows = [];
  for (const person of people) {
    try {
      rows.push(...await cards(person));
    } catch {
      // Один закрытый профиль не останавливает разбор остальных.
    }
  }
  return save(pack(people, rows));
}

async function ensure() {
  const current = load();
  if (current && Date.now() - new Date(current.at).getTime() < HOUR) return current;
  try {
    return await study();
  } catch {
    return current;
  }
}

function candidates() {
  return (load()?.tickers || []).filter((item) => item.n >= 2 && item.avg >= 8 && item.wins >= 2);
}

function boost(ticker) {
  const row = (load()?.tickers || []).find((item) => item.ticker === ticker);
  if (!row || row.n < 2 || row.avg <= 0) return 0;
  return Math.min(8, row.avg / 5);
}

function summary() {
  const lesson = load();
  if (!lesson?.people?.length) return "Чужие профили ещё не разобраны.";
  const top = (lesson.tickers || []).filter((item) => item.avg > 0 && item.n >= 2).slice(0, 3);
  const names = top.map((item) => {
    const sample = item.samples?.[0];
    const bought = sample?.entry ? `, вход около ${sample.entry}` : "";
    return `${item.ticker} около +${item.avg.toFixed(1).replace(".", ",")}% от их входа${bought}`;
  }).join("; ");
  return `Учёба: ${lesson.people.length} открытых профилей с портфелем от 10 млн ₽ и доходом выше 20% за год. ${names ? `Чаще в плюсе: ${names}.` : "Повторяющихся плюсовых бумаг пока нет."} Чужую сделку не копирую, если она слабее других идей.`;
}

module.exports = { ensure, study, load, candidates, boost, summary };
