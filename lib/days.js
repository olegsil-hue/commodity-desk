const fs = require("fs");
const path = require("path");
const journal = require("./journal");

const FILE = path.join(__dirname, "..", "data", "days.json");
const START = 40_000;

function mskDate(value) {
  const date = new Date(value);
  return new Date(date.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function label(date) {
  const [year, month, day] = date.split("-");
  return `${day}.${month}.${year.slice(2)}`;
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return [];
  }
}

function save(days) {
  fs.writeFileSync(FILE, JSON.stringify(days, null, 2));
  return days;
}

function liveRows(date) {
  return journal.load().filter((row) => row.venue === "live" && mskDate(row.at) === date);
}

function seed() {
  const existing = load();
  if (existing.length) return existing;
  const day = {
    id: "D1",
    date: "2026-09-23",
    label: "23.09.26",
    start: START,
    end: 43670,
    pnl: 3670,
    pct: 9.175,
    strategy: "Старт 40 000 ₽. Стол несколько раз покупал BR-10.26, пока день нефти был в плюсе, и продавал около +1% от своего входа. Также брал Роснефть и X5. К 23:00 последняя нефть закрыта, открытых позиций не осталось. На счёте 43 670 ₽. Доход +3 670 ₽, это +9,18% от старта.",
    journal: liveRows("2026-09-23"),
  };
  return save([day]);
}

function touch({ equity, strategy }) {
  const days = seed();
  const today = mskDate(new Date().toISOString());
  const prev = [...days].reverse().find((day) => day.date < today);
  const start = prev ? prev.end : START;
  let row = days.find((day) => day.date === today);
  if (!row) {
    row = {
      id: `D${days.length + 1}`,
      date: today,
      label: label(today),
      start,
      journal: [],
    };
    days.push(row);
  }
  const end = Math.round(Number(equity) || start);
  row.end = end;
  row.pnl = end - row.start;
  row.pct = row.start ? (row.pnl / row.start) * 100 : 0;
  row.strategy = strategy || row.strategy || "";
  row.journal = liveRows(today);
  return save(days);
}

module.exports = { load: seed, touch, mskDate };
