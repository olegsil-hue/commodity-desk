import { scrypt, timingSafeEqual, createHmac } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const DAY = 12 * 60 * 60 * 1000;

function answerCommand(text) {
  const lower = String(text || "").trim().toLowerCase().replaceAll("ё", "е");
  if (!lower) return "Напишите команду.";
  if (lower === "пауза" || lower === "стоп") return "Пауза. В 9:00 новые заявки не ставлю. Уже открытое закрою по цели или по стопу.";
  if (lower === "продолжи" || lower === "продолжить" || lower === "работай") return "В 9:00 снова торгую. Сравню нефть с бумагами из учёбы и куплю одну самую сильную.";
  if (lower.includes("только нефт")) return "Принял. С 9:00 смотрю только нефть. Куплю контракт, только если день от +0,25% и сам контракт от +0,3%.";
  if (lower.includes("вся книг") || lower.includes("все бумаг")) return "Принял. С 9:00 снова сравниваю всю книгу и беру самую сильную идею, не обязательно нефть.";
  if (lower.includes("не шорт")) return "Принял. Шорт нефти больше не открываю.";
  if (lower.includes("шорт") && lower.includes("нефт")) return "Принял. Шорт нефти снова можно, но только если он сильнее других идей и день уже в минусе.";
  if (/закр(ой|ыть)\s+вс/.test(lower) || /(?:закр(?:ой|ыть)|продай)\s+/.test(lower)) {
    return "Принял. Закрою на следующем шаге бота, он начинается около 8:55. Если сессия ещё закрыта, заявка уйдёт, когда биржа примет её.";
  }
  if (lower.includes("уч")) return "Учусь сам по открытым профилям Пульса: портфель от 10 млн ₽ и доход выше 20% за год. В 9:00 сравню их бумаги с нефтью и куплю ту, что сильнее. Чужую сделку не копирую.";
  return "В 9:00 куплю одну самую сильную бумагу. Нефть беру, только если её ход больше, чем у акций, и свободно не меньше 20 000 ₽. Напишите: пауза, продолжи, закрой BRV6, только нефть, вся книга, не шорти нефть.";
}

function controlPatch(text) {
  const lower = String(text || "").trim().toLowerCase().replaceAll("ё", "е");
  if (lower === "пауза" || lower === "стоп") return { enabled: false };
  if (lower === "продолжи" || lower === "продолжить" || lower === "работай") return { enabled: true };
  if (lower.includes("только нефт")) return { book: "oil" };
  if (lower.includes("вся книг") || lower.includes("все бумаг")) return { book: "all" };
  if (lower.includes("не шорт")) return { allowOilShort: false };
  if (lower.includes("шорт") && lower.includes("нефт")) return { allowOilShort: true };
  return null;
}

function needsExecution(text) {
  const lower = String(text || "").trim().toLowerCase().replaceAll("ё", "е");
  return /закр(ой|ыть)\s+вс/.test(lower) || /(?:закр(?:ой|ыть)|продай)\s+/.test(lower);
}

function cookies(request) {
  const out = {};
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key) out[key] = rest.join("=");
  }
  return out;
}

async function passwordOk(env, password) {
  if (!env.ADMIN_SALT || !env.ADMIN_HASH || !password) return false;
  const got = await scryptAsync(String(password), env.ADMIN_SALT, 32);
  const expect = Buffer.from(env.ADMIN_HASH, "hex");
  if (got.length !== expect.length) return false;
  return timingSafeEqual(got, expect);
}

function sessionOk(env, request) {
  const token = cookies(request).desk || "";
  const dot = token.lastIndexOf(".");
  if (dot < 1 || !env.SESSION_SECRET) return false;
  const exp = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expect = createHmac("sha256", env.SESSION_SECRET).update(exp).digest("hex");
  const left = Buffer.from(mac);
  const right = Buffer.from(expect);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return false;
  return Number(exp) > Date.now();
}

function setCookie(token) {
  return `desk=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`;
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

async function chatList(env) {
  try {
    return JSON.parse(await env.SNAPSHOT.get("chat") || "[]");
  } catch {
    return [];
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const authed = sessionOk(env, request);

    if (url.pathname === "/api/session") {
      return json({ admin: authed, needsSetup: false });
    }
    if (url.pathname === "/api/login" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (!(await passwordOk(env, body.password))) {
        return json({ error: "Пароль не подошёл." }, 401);
      }
      const exp = Date.now() + DAY;
      const mac = createHmac("sha256", env.SESSION_SECRET).update(String(exp)).digest("hex");
      return json({ ok: true }, 200, { "Set-Cookie": setCookie(`${exp}.${mac}`) });
    }
    if (url.pathname === "/api/logout" && request.method === "POST") {
      return json({ ok: true }, 200, { "Set-Cookie": "desk=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0" });
    }
    if (!authed && (url.pathname.startsWith("/api/"))) {
      return json({ error: "Нужен вход." }, 401);
    }
    if (url.pathname === "/api/sandbox") {
      const raw = await env.SNAPSHOT.get("live");
      const body = raw || JSON.stringify({ ready: false, text: "Жду первую публикацию с GitHub." });
      return new Response(body, {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/api/broker") {
      const raw = await env.SNAPSHOT.get("live");
      const box = raw ? JSON.parse(raw) : {};
      const tail = box.tail || "";
      return json({
        connected: true,
        mode: "live",
        tail,
        live: { connected: Boolean(tail), tail },
      });
    }
    if (url.pathname === "/api/chat" && request.method === "GET") {
      return json({ messages: await chatList(env) });
    }
    if (url.pathname === "/api/chat" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const text = String(body.text || "").trim().slice(0, 400);
      if (!text) return json({ error: "Напишите команду." }, 400);
      const messages = await chatList(env);
      const inbox = JSON.parse(await env.SNAPSHOT.get("inbox") || "[]");
      const at = new Date().toISOString();
      messages.push({ at, role: "user", text });
      messages.push({ at, role: "desk", text: answerCommand(text) });
      const patch = controlPatch(text);
      if (patch) {
        const current = JSON.parse(await env.SNAPSHOT.get("control") || "{}");
        await env.SNAPSHOT.put("control", JSON.stringify({ ...current, ...patch }));
      }
      if (needsExecution(text) || patch) inbox.push({ at, text });
      await env.SNAPSHOT.put("chat", JSON.stringify(messages.slice(-40)));
      await env.SNAPSHOT.put("inbox", JSON.stringify(inbox.slice(-20)));
      return json({ messages: messages.slice(-40) });
    }
    return env.ASSETS.fetch(request);
  },
};
