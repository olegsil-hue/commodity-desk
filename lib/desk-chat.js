const fs = require("fs");
const path = require("path");

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || "077ddbf61620b74bddee1cfebb57e043";
const NAMESPACE = process.env.CLOUDFLARE_KV_NAMESPACE_ID || "ceacfcad67db427193fa57eb23af489c";

function token() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  try {
    const file = path.join(process.env.APPDATA || "", "xdg.config", ".wrangler", "config", "default.toml");
    const text = fs.readFileSync(file, "utf8");
    return (text.match(/oauth_token = "([^"]+)"/) || [])[1] || "";
  } catch {
    return "";
  }
}

function url(key) {
  return `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces/${NAMESPACE}/values/${key}`;
}

async function getKey(key) {
  const auth = token();
  if (!auth) return null;
  const response = await fetch(url(key), { headers: { Authorization: `Bearer ${auth}` } });
  if (response.status === 404) return null;
  if (!response.ok) return null;
  return response.text();
}

async function putKey(key, value) {
  const auth = token();
  if (!auth) return false;
  const response = await fetch(url(key), {
    method: "PUT",
    headers: { Authorization: `Bearer ${auth}`, "Content-Type": "text/plain" },
    body: value,
  });
  return response.ok;
}

async function readChat() {
  try {
    return JSON.parse(await getKey("chat") || "[]");
  } catch {
    return [];
  }
}

async function writeChat(list) {
  await putKey("chat", JSON.stringify(list.slice(-40)));
}

async function enqueue(text) {
  const chat = await readChat();
  const inbox = JSON.parse(await getKey("inbox") || "[]");
  const at = new Date().toISOString();
  chat.push({ at, role: "user", text });
  inbox.push({ at, text });
  await writeChat(chat);
  await putKey("inbox", JSON.stringify(inbox.slice(-20)));
  return chat;
}

async function takeInbox() {
  const raw = await getKey("inbox");
  const inbox = raw ? JSON.parse(raw) : [];
  if (!inbox.length) return [];
  await putKey("inbox", "[]");
  return inbox;
}

async function reply(text) {
  const chat = await readChat();
  chat.push({ at: new Date().toISOString(), role: "desk", text });
  await writeChat(chat);
}

module.exports = { readChat, enqueue, takeInbox, reply };
