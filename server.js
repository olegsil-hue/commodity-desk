const http = require("http");
const fs = require("fs");
const path = require("path");
const { planTrade } = require("./lib/planner");
const { loadBrentClock } = require("./lib/intraday");
const { loadQuotes } = require("./lib/quotes");
const paper = require("./lib/paper");
const auth = require("./lib/auth");
const broker = require("./lib/broker");
const watch = require("./lib/watch");
const journal = require("./lib/journal");
const sandboxRun = require("./lib/sandbox-run");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 4173;
const BOOK = path.join(ROOT, "data", "moex-book.json");

function readBook() {
  return JSON.parse(fs.readFileSync(BOOK, "utf8")).book;
}

function send(res, code, body, type, extra) {
  res.writeHead(code, {
    "Content-Type": type || "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(extra || {}),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function cookie(token) {
  return `desk=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`;
}

function requireAdmin(req, res) {
  if (auth.valid(auth.tokenFrom(req))) return true;
  send(res, 401, JSON.stringify({ error: "Нужен вход админа." }));
  return false;
}

async function makePlan(body) {
  const book = readBook();
  const quotes = await loadQuotes();
  const board = watch.buildWatch(quotes);
  const overrides = board.overrides;
  let clock = null;
  try {
    clock = await loadBrentClock(book.brent.contract);
  } catch (err) {
    clock = { regime: { id: "nodata", title: "Слоты не загрузились", hedgeScale: 1, trendScale: 1 }, slots: [], source: err.message };
  }
  if (overrides.pauseSlots && clock?.regime) {
    clock = {
      ...clock,
      regime: {
        id: "paused",
        title: "Автослоты на паузе: доли не двигаю, пока вы сами не включите",
        hedgeScale: 1,
        trendScale: 1,
      },
    };
  }
  const notional = Number(body.notional) > 0 ? Number(body.notional) : board.notional;
  const plan = watch.applyOverrides(
    planTrade(book, {
      ...body,
      notional,
      clock,
      dropIds: body.policy === "example" || body.policy === "beta" ? [] : board.dropIds,
    }),
    overrides,
  );
  return { plan, board };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method === "GET" && url.pathname === "/api/session") {
      send(res, 200, JSON.stringify({ needsSetup: !auth.hasAdmin(), admin: auth.valid(auth.tokenFrom(req)) }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/setup") {
      const body = await readBody(req);
      auth.setup(body.password);
      const token = auth.login(body.password);
      send(res, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8", { "Set-Cookie": cookie(token) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/login") {
      const body = await readBody(req);
      const token = auth.login(body.password);
      send(res, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8", { "Set-Cookie": cookie(token) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/logout") {
      auth.logout(auth.tokenFrom(req));
      send(res, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8", {
        "Set-Cookie": "desk=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
      });
      return;
    }
    if (url.pathname.startsWith("/api/") && !requireAdmin(req, res)) return;

    if (req.method === "GET" && url.pathname === "/api/state") {
      const quotes = await loadQuotes();
      const board = watch.buildWatch(quotes);
      send(res, 200, JSON.stringify({
        book: readBook(),
        account: paper.load(),
        board,
        broker: broker.status(),
        journal: journal.load(),
        sandbox: sandboxRun.peek(),
        mode: "paper",
      }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/plan") {
      const body = await readBody(req);
      const { plan, board } = await makePlan(body);
      send(res, 200, JSON.stringify({ ...plan, board }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/overrides") {
      const body = await readBody(req);
      const saved = watch.saveLegs(body.legs, body.pauseSlots);
      if (body.marks) watch.saveMarks(body.marks);
      send(res, 200, JSON.stringify(saved));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/checkpoint") {
      const quotes = await loadQuotes();
      const board = watch.checkpoint(watch.buildWatch(quotes));
      send(res, 200, JSON.stringify(board));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/execute") {
      const body = await readBody(req);
      if (body.confirm !== true) {
        send(res, 400, JSON.stringify({ error: "Нужно подтверждение бумажной сделки." }));
        return;
      }
      const { plan } = await makePlan(body);
      const account = paper.executePlan(plan);
      send(res, 200, JSON.stringify({ plan, account, venue: "paper" }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/flatten") {
      send(res, 200, JSON.stringify(paper.flatten()));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/sandbox") {
      const shot = sandboxRun.peek() || (await sandboxRun.picture().catch((err) => ({ ready: false, text: err.message })));
      send(res, 200, JSON.stringify({ ...shot, journal: journal.load() }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/sandbox/pause") {
      const body = await readBody(req);
      const state = sandboxRun.peek() || {};
      const fs = require("fs");
      const file = require("path").join(ROOT, "data", "sandbox-auto.json");
      const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { entries: { rise: 1, drop: 0 }, cooldownUntil: 0 };
      saved.enabled = body.enabled !== false;
      saved.lastDecision = saved.enabled ? "Автоторговля снова включена." : "Автоторговля на паузе. Заявки не выставляю.";
      fs.writeFileSync(file, JSON.stringify(saved, null, 2));
      send(res, 200, JSON.stringify({ ...state, enabled: saved.enabled, lastDecision: saved.lastDecision }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/broker") {
      send(res, 200, JSON.stringify(broker.status()));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/broker") {
      const body = await readBody(req);
      if (body.clear) {
        send(res, 200, JSON.stringify(broker.clear()));
        return;
      }
      send(res, 200, JSON.stringify(broker.save(body)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/broker/accounts") {
      const body = await readBody(req);
      const mode = body.mode === "live" ? "live" : "sandbox";
      send(res, 200, JSON.stringify(await broker.accounts(mode)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/broker/sandbox/open") {
      send(res, 200, JSON.stringify(await broker.openSandboxAccount()));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/broker/sandbox/pay") {
      const body = await readBody(req);
      send(res, 200, JSON.stringify(await broker.paySandbox(body.accountId, body.amount)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/broker/portfolio") {
      const body = await readBody(req);
      const mode = body.mode === "live" ? "live" : "sandbox";
      send(res, 200, JSON.stringify(await broker.portfolio(body.accountId, mode)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/broker/order") {
      const body = await readBody(req);
      send(res, 200, JSON.stringify(await broker.sendOrder(body)));
      return;
    }

    const file = url.pathname === "/" ? "/public/index.html" : "/public" + url.pathname;
    const full = path.normalize(path.join(ROOT, file));
    if (!full.startsWith(path.join(ROOT, "public")) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      send(res, 404, JSON.stringify({ error: "not found" }));
      return;
    }
    const ext = path.extname(full);
    const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
    send(res, 200, fs.readFileSync(full), types[ext] || "text/plain; charset=utf-8");
  } catch (err) {
    send(res, err.status || 500, JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`paper desk http://127.0.0.1:${PORT}`);
  const run = () => sandboxRun.step().catch((err) => console.error("sandbox", err.message));
  setTimeout(run, 5000);
  setInterval(run, 60_000);
});
