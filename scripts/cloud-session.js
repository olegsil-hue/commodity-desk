const fs = require("fs");
const path = require("path");
const journal = require("../lib/journal");
const studyDb = require("../lib/study-db");
const { step, picture } = require("../lib/sandbox-run");

function remembered() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "sandbox-auto.json"), "utf8"));
  } catch {
    return {};
  }
}

function mskMinutes(now = new Date()) {
  const shifted = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

function publicView(box) {
  const rows = journal.load().filter((row) => row.venue === "live").slice(0, 40);
  return {
    ready: Boolean(box?.ready),
    text: box?.text || "",
    deposited: box?.deposited,
    cash: box?.cash,
    stockValue: box?.stockValue,
    futuresPnl: box?.futuresPnl,
    futuresSettled: Boolean(box?.futuresSettled),
    available: box?.available ?? box?.cash,
    pnl: box?.pnl,
    lines: box?.lines || [],
    plan: box?.plan || null,
    days: box?.days || [],
    study: box?.study || studyDb.latest(),
    priceNote: box?.priceNote || "",
    lastDecision: box?.lastDecision || "",
    logic: box?.logic || [],
    journal: rows,
    enabled: box?.enabled !== false,
    tail: process.env.TBANK_TOKEN ? String(process.env.TBANK_TOKEN).slice(-4) : "",
    cloud: true,
    updatedAt: new Date().toISOString(),
  };
}

async function putKv(key, value) {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const namespaceId = process.env.CLOUDFLARE_KV_NAMESPACE_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !namespaceId || !token) throw new Error("Нет ключей Cloudflare");
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${namespaceId}/values/${key}`;
  const response = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });
  if (!response.ok) throw new Error(`Cloudflare ${response.status}`);
}

async function publish(box) {
  try {
    await putKv("live", JSON.stringify(publicView(box)));
    console.log(new Date().toISOString(), "экран обновлён");
  } catch (err) {
    console.log(new Date().toISOString(), "экран не обновился:", err.message);
  }
}

function sessionEnd() {
  if (process.env.SESSION_SLOT === "morning") return 14 * 60 + 25;
  if (process.env.SESSION_SLOT === "afternoon") return 18 * 60 + 50;
  return 18 * 60 + 50;
}

async function main() {
  if (!process.env.TBANK_TOKEN || !process.env.TBANK_ACCOUNT_ID) {
    throw new Error("Нет TBANK_TOKEN или TBANK_ACCOUNT_ID");
  }
  if (process.env.PUBLISH_ONLY === "1") {
    await publish({ ...(await picture()), ...remembered() });
    return;
  }
  if (process.env.SESSION_SLOT === "tick") {
    await publish(await step());
    return;
  }
  const end = sessionEnd();
  while (mskMinutes() < end) {
    try {
      await publish(await step());
    } catch (err) {
      console.log(new Date().toISOString(), "шаг не прошёл:", err.message);
    }
    const left = (end - mskMinutes()) * 60 * 1000;
    if (left <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, left)));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { publicView };
