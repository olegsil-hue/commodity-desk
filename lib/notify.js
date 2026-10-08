const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "telegram.json");

function config() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    saved = {};
  }
  return {
    token: process.env.TELEGRAM_BOT_TOKEN || saved.token || "",
    chatId: process.env.TELEGRAM_CHAT_ID || saved.chatId || "",
    offset: Number(saved.offset) || 0,
  };
}

const priceFmt = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

function plain(text) {
  return String(text).replace(/[\u00a0\u202f]/g, " ");
}

function pad(text, width, right) {
  const value = String(text);
  if (value.length >= width) return value;
  const gap = " ".repeat(width - value.length);
  return right ? gap + value : value + gap;
}

function balanceTable(book) {
  const lines = book?.lines || [];
  const header = ["Бумага", "Шт.", "Вход", "Сейчас", "Результат"];
  const rows = lines.map((line) => [
    line.ticker,
    String(line.qty),
    plain(priceFmt.format(line.avg)),
    plain(priceFmt.format(line.current)),
    plain(`${line.pnl >= 0 ? "+" : ""}${money.format(line.pnl)} ₽`),
  ]);
  if (!rows.length) return "Открытых позиций нет.";
  const widths = header.map((name, index) => Math.max(name.length, ...rows.map((row) => row[index].length)));
  const right = [false, true, true, true, true];
  const draw = (cells) => cells.map((cell, index) => pad(cell, widths[index], right[index])).join("  ");
  return [draw(header), ...rows.map(draw)].join("\n");
}

function escapeHtml(text) {
  return String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderStatus(book, mode) {
  const head = mode === "pause"
    ? "Стол на паузе."
    : mode === "off"
      ? "Стол не работает."
      : book?.venue === "sandbox"
        ? "Стол работает в песочнице. Боевой счёт не трогаю."
        : "Стол работает.";
  const cash = Number(book?.cash);
  const pnl = Number(book?.pnl);
  const totals = Number.isFinite(cash)
    ? plain(`Свободно ${money.format(cash)} ₽. Итог ${pnl >= 0 ? "+" : ""}${money.format(pnl || 0)} ₽.`)
    : "";
  return [head, totals, balanceTable(book)].filter(Boolean).join("\n\n");
}

function saveConfig(patch) {
  const current = config();
  const next = {
    token: current.token,
    chatId: patch.chatId || current.chatId || "",
    offset: patch.offset ?? current.offset ?? 0,
  };
  if (!next.token) return;
  fs.writeFileSync(FILE, JSON.stringify(next));
}

async function telegram(method, body) {
  const { token } = config();
  if (!token) return { ok: false };
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(15000),
  });
  return response.json();
}

function isStatus(text) {
  const lower = String(text || "").trim().toLowerCase();
  return lower === "status" || lower === "/status" || lower.startsWith("/status@");
}

async function send(text, options = {}) {
  const { token, chatId } = config();
  const message = String(text || "").trim();
  const target = options.chatId || chatId;
  if (!token || !target || !message) {
    console.log("telegram не ушёл:", !token ? "нет токена" : !target ? "нет чата" : "пустое сообщение");
    return false;
  }
  const payload = { chat_id: target, text: message.slice(0, 3500) };
  if (options.html) payload.parse_mode = "HTML";
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) console.log("telegram не ушёл:", response.status);
    return response.ok;
  } catch (err) {
    console.log("telegram не ушёл:", err.message);
    return false;
  }
}

async function report(notes, book) {
  const rows = (notes || []).filter((note) => /^(Купил|Продал|Закрыл) /.test(String(note)));
  const table = balanceTable(book);
  for (const row of rows) {
    await send(`<pre>${escapeHtml(`${row}\n\n${table}`)}</pre>`, { html: true });
  }
  return rows.length;
}

async function shiftRunning() {
  const { spawnSync } = require("child_process");
  const gh = process.platform === "win32" ? "C:\\Program Files\\GitHub CLI\\gh.exe" : "gh";
  const result = spawnSync(gh, [
    "run", "list",
    "--repo", "olegsil-hue/commodity-desk",
    "--workflow", "session.yml",
    "--limit", "1",
    "--json", "status",
  ], { encoding: "utf8" });
  if (result.status !== 0) return false;
  try {
    const rows = JSON.parse(result.stdout || "[]");
    return rows[0]?.status === "in_progress";
  } catch {
    return false;
  }
}

async function deskMode() {
  let enabled = true;
  try {
    const state = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "sandbox-auto.json"), "utf8"));
    enabled = state.enabled !== false;
  } catch {
    enabled = true;
  }
  if (process.env.SESSION_SLOT === "shift") return enabled ? "on" : "pause";
  const desk = require("./desk-chat");
  try {
    const beat = JSON.parse(await desk.getRaw("heartbeat") || "null");
    const fresh = beat?.at && Date.now() - new Date(beat.at).getTime() < 3 * 60 * 1000;
    if (fresh) return enabled ? "on" : "pause";
  } catch {
    // A missed pulse is not the same as a stopped shift.
  }
  if (await shiftRunning()) return enabled ? "on" : "pause";
  return "off";
}

async function claim(updateId) {
  const desk = require("./desk-chat");
  const key = `tg-seen-${updateId}`;
  const existing = await desk.getRaw(key);
  if (existing) return false;
  const saved = await desk.putRaw(key, "1");
  if (saved) return true;
  return !process.env.SESSION_SLOT;
}

async function pull() {
  const saved = config();
  if (!saved.token) return;
  const json = await telegram("getUpdates", {
    offset: saved.offset || undefined,
    timeout: 0,
    allowed_updates: ["message"],
  });
  if (!json.ok || !json.result?.length) return;
  let offset = saved.offset || 0;
  for (const update of json.result) {
    offset = update.update_id + 1;
    const message = update.message;
    if (!message?.chat) continue;
    if (!saved.chatId) saveConfig({ chatId: String(message.chat.id), offset });
    if (/^\/start\b/.test(String(message.text || ""))) {
      await send("Напиши status — пришлю, работает ли стол, и что на балансе.", { chatId: message.chat.id });
    }
    if (!isStatus(message.text)) continue;
    if (!(await claim(update.update_id))) continue;
    const { picture } = require("./sandbox-run");
    let book = null;
    try {
      book = await picture();
    } catch {
      book = null;
    }
    await sendStatus(book, await deskMode(), message.chat.id);
  }
  saveConfig({ offset });
}

async function sendStatus(book, mode, chatId) {
  return send(`<pre>${escapeHtml(renderStatus(book, mode))}</pre>`, { html: true, chatId });
}

async function commands() {
  try {
    await telegram("setMyCommands", {
      commands: [{ command: "status", description: "Работает ли стол и что на балансе" }],
    });
  } catch (err) {
    console.log("команды telegram не обновились:", err.message);
  }
}

module.exports = { send, report, pull, commands, sendStatus, renderStatus };
