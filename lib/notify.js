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
  };
}

async function send(text) {
  const { token, chatId } = config();
  const message = String(text || "").trim();
  if (!token || !chatId || !message) return false;
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message.slice(0, 3500) }),
      signal: AbortSignal.timeout(12000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function report(notes) {
  const rows = (notes || []).filter((note) => /^(Купил|Продал|Закрыл) /.test(String(note)));
  for (const row of rows) await send(row);
  return rows.length;
}

module.exports = { send, report };
