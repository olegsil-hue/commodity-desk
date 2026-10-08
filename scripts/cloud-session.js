const fs = require("fs");
const path = require("path");
const journal = require("../lib/journal");
let studyDb = { latest() { return null; } };
try {
  studyDb = require("../lib/study-db");
} catch {
  // Файл учёбы может отсутствовать на GitHub. Торговля от этого не зависит.
}
const deskChat = require("../lib/desk-chat");
const broker = require("../lib/broker");
const notify = require("../lib/notify");
const dailyLetter = require("../lib/daily-letter");
const { dispatch } = require("./github-dispatch");
let step;
let picture;
try {
  ({ step, picture } = require("../lib/sandbox-run"));
} catch (err) {
  fail("Смена не загрузилась", err);
}

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
  const venue = box?.venue || "live";
  const rows = journal.load().filter((row) => row.venue === venue).slice(0, 40);
  return {
    ready: Boolean(box?.ready),
    venue,
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
    brain: box?.brain || null,
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

function sessionClose() {
  return 23 * 60 + 50;
}

function sessionOpenMinutes(now = new Date()) {
  const shifted = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const day = shifted.getUTCDay();
  return day === 0 || day === 6 ? 10 * 60 : 9 * 60;
}

function fail(title, err) {
  const text = String(err && err.stack || err && err.message || err);
  console.error(text);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    fs.appendFileSync(summary, `## ${title}\n\n\`\`\`\n${text.slice(0, 4000)}\n\`\`\`\n`);
  }
  process.exit(1);
}

async function main() {
  console.log(new Date().toISOString(), "старт", "токен", Boolean(process.env.TBANK_TOKEN), "счёт", Boolean(process.env.TBANK_ACCOUNT_ID));
  if (!process.env.TBANK_TOKEN || !process.env.TBANK_ACCOUNT_ID) {
    throw new Error("Нет TBANK_TOKEN или TBANK_ACCOUNT_ID");
  }
  if (process.env.PUBLISH_ONLY === "1") {
    await publish({ ...(await picture()), ...remembered() });
    return;
  }
  if (process.env.SESSION_SLOT === "shift") {
    const close = sessionClose();
    let open = sessionOpenMinutes();
    let now = mskMinutes();
    if (now >= close || (now < open && open - now > 90)) {
      console.log(new Date().toISOString(), "биржа закрыта, передаю утро");
      const next = await dispatch("bridge.yml");
      console.log(new Date().toISOString(), next.ok ? "утренний запуск передан" : `утренний запуск не передан: ${next.status}`);
      return;
    }
    if (now < open) {
      console.log(new Date().toISOString(), "жду открытия, минут", open - now);
      await new Promise((resolve) => setTimeout(resolve, (open - now) * 60 * 1000));
    }
    const deadline = Date.now() + 5 * 60 * 60 * 1000;
    console.log(new Date().toISOString(), "смена GitHub, песочница", broker.venue() === "sandbox");
    await notify.commands();
    await dailyLetter.deliver(dailyLetter.previousDay(dailyLetter.moscowDay())).catch((err) => {
      console.log(new Date().toISOString(), "вчерашнее письмо не ушло:", err.message);
    });
    await notify.send(broker.venue() === "sandbox"
      ? "Стол запущен и работает в песочнице. Боевой счёт не трогаю."
      : "Стол запущен и работает.");
    let lastStatus = Date.now();
    try {
      while (mskMinutes() < close && Date.now() < deadline) {
        try {
          await notify.pull().catch(() => {});
          const awake = await deskChat.localAwake().catch(() => "unknown");
          let traded = false;
          if (awake === true) {
            console.log(new Date().toISOString(), "локальный стол жив, заявку с GitHub не ставлю");
          } else {
            const box = await step();
            traded = /(?:Купил|Продал|Закрыл) /.test(box?.lastDecision || "");
            await publish(box);
          }
          if (traded) lastStatus = Date.now();
          else if (Date.now() - lastStatus >= 55 * 60 * 1000) {
            await notify.send(broker.venue() === "sandbox"
              ? "Стол работает в песочнице. Новых сделок нет. Боевой счёт не трогаю."
              : "Стол работает. Новых сделок нет.").catch(() => {});
            lastStatus = Date.now();
          }
        } catch (err) {
          console.log(new Date().toISOString(), "шаг не прошёл:", err.message);
        }
        const left = (close - mskMinutes()) * 60 * 1000;
        if (left <= 0 || Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, left)));
      }
    } finally {
      if (mskMinutes() >= close) {
        await dailyLetter.deliver(dailyLetter.moscowDay()).catch((err) => {
          console.log(new Date().toISOString(), "письмо не ушло:", err.message);
        });
        await notify.send("Стол остановился. Завтра запустится сам.").catch(() => {});
        const next = await dispatch("bridge.yml");
        console.log(new Date().toISOString(), next.ok ? "утренний запуск передан" : `утренний запуск не передан: ${next.status}`);
      } else {
        const next = await dispatch("session.yml");
        console.log(new Date().toISOString(), next.ok ? "следующая смена передана" : `следующая смена не передана: ${next.status}`);
      }
    }
    return;
  }
  if (process.env.SESSION_SLOT === "tick") {
    if (await deskChat.localAwake() === true) {
      console.log(new Date().toISOString(), "локальный стол жив, заявку с GitHub не ставлю");
      return;
    }
    await publish(await step());
    return;
  }
  const end = sessionClose();
  while (mskMinutes() < end) {
    try {
      if (await deskChat.localAwake() === true) {
        console.log(new Date().toISOString(), "локальный стол жив, заявку с GitHub не ставлю");
      } else {
        await publish(await step());
      }
    } catch (err) {
      console.log(new Date().toISOString(), "шаг не прошёл:", err.message);
    }
    const left = (end - mskMinutes()) * 60 * 1000;
    if (left <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, left)));
  }
}

if (require.main === module) {
  main().catch((err) => fail("Смена упала", err));
}

module.exports = { publicView };
