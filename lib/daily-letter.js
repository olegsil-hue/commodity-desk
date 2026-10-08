const fs = require("fs");
const path = require("path");
const notify = require("./notify");

const DAYS = path.join(__dirname, "..", "data", "sandbox-days.json");
const BRAIN = path.join(__dirname, "..", "data", "brain.json");
const STAMP = path.join(__dirname, "..", "data", "daily-letter.json");
const TO = "olegsil@gmail.com";
const money = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function moscowDay(value = new Date()) {
  return new Date(new Date(value).getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function previousDay(day) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function rub(value) {
  const number = Math.round(Number(value) || 0);
  const sign = number > 0 ? "+" : number < 0 ? "−" : "";
  return `${sign}${money.format(Math.abs(number))} ₽`;
}

function plain(value) {
  return money.format(Math.round(Number(value) || 0)) + " ₽";
}

function stamps() {
  const saved = readJson(STAMP, { dates: [] });
  saved.dates = Array.isArray(saved.dates) ? saved.dates : [];
  return saved;
}

function mark(day) {
  const saved = stamps();
  if (!saved.dates.includes(day)) saved.dates.push(day);
  saved.dates = saved.dates.slice(-40);
  fs.mkdirSync(path.dirname(STAMP), { recursive: true });
  fs.writeFileSync(STAMP, JSON.stringify(saved, null, 2));
}

function compose(day) {
  const days = readJson(DAYS, []);
  const row = Array.isArray(days) ? days.find((item) => item.date === day) : null;
  const rule = readJson(BRAIN, {}).rule?.text || "";
  const learned = rule.trim() || "За этот день новое правило не собралось. Смотрю свои сделки, чужие сделки и новости.";
  const date = new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${day}T12:00:00Z`));
  if (!row) return null;
  const earned = Number.isFinite(Number(row.pnl)) ? Number(row.pnl) : Number(row.end) - Number(row.start);
  const text = [
    `Стол. Песочница. ${date}.`,
    "",
    "Чему научился",
    learned,
    "",
    "Динамика песочницы",
    `Было: ${plain(row.start)}`,
    `Стало: ${plain(row.end)}`,
    `Заработано: ${rub(earned)}`,
  ].join("\n");
  return { day, subject: `Стол, песочница, ${date}`, text };
}

async function sendEmail(letter) {
  const response = await fetch(`https://formsubmit.co/ajax/${TO}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      name: "Стол",
      email: TO,
      subject: letter.subject,
      message: letter.text,
      _captcha: "false",
      _template: "box",
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`письмо ${response.status}`);
  return true;
}

async function deliver(day) {
  const saved = stamps();
  if (saved.dates.includes(day)) return false;
  const letter = compose(day);
  if (!letter) {
    console.log(new Date().toISOString(), "письмо не собралось, дня в книге нет", day);
    return false;
  }
  const telegram = await notify.send(letter.text);
  let email = false;
  try {
    email = await sendEmail(letter);
  } catch (err) {
    console.log(new Date().toISOString(), "email не ушёл:", err.message);
  }
  if (telegram || email) {
    mark(day);
    console.log(new Date().toISOString(), "письмо за день", day, "telegram", Boolean(telegram), "email", email);
    return true;
  }
  console.log(new Date().toISOString(), "письмо не доставлено", day);
  return false;
}

module.exports = { deliver, compose, moscowDay, previousDay };
