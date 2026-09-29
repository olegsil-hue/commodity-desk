const fs = require("fs");
const path = require("path");
const journal = require("./journal");
const experience = require("./experience");
const history = require("./history");
const headlines = require("./headlines");
const { loadFuturesBoard } = require("./quotes");

const FILE = path.join(__dirname, "..", "data", "brain.json");
const ROOTS = {
  нефть: "BR",
  газ: "NG",
  золото: "GD",
  серебро: "SV",
  медь: "CE",
  платина: "PT",
  палладий: "PD",
  никель: "NI",
  алюминий: "AL",
};

function moscowDay(value = new Date()) {
  return new Date(new Date(value).getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function pct(value) {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value * 100).toFixed(2).replace(".", ",")}%`;
}

function load() {
  try {
    const graph = JSON.parse(fs.readFileSync(FILE, "utf8"));
    graph.nodes = graph.nodes || [];
    graph.links = graph.links || [];
    graph.rule = graph.rule || {};
    return graph;
  } catch {
    return { at: null, nodes: [], links: [], rule: {} };
  }
}

function save(graph) {
  graph.nodes = graph.nodes.slice(-80);
  graph.links = graph.links.slice(-120);
  fs.writeFileSync(FILE, JSON.stringify(graph, null, 2));
  return graph;
}

function putNode(graph, node) {
  const index = graph.nodes.findIndex((item) => item.id === node.id);
  const next = { ...node, updated: new Date().toISOString() };
  if (index >= 0) graph.nodes[index] = { ...graph.nodes[index], ...next };
  else graph.nodes.push(next);
}

function putLink(graph, from, to, label) {
  const id = `${from}>${to}:${label}`;
  const index = graph.links.findIndex((item) => item.id === id);
  const link = { id, from, to, label };
  if (index >= 0) graph.links[index] = link;
  else graph.links.push(link);
}

function roundTrips(day = moscowDay()) {
  const rows = journal.load()
    .filter((row) => (row.venue === "sandbox" || row.venue === "live") && row.ticker && row.at && moscowDay(row.at) === day && Number(row.price) > 0)
    .slice()
    .sort((a, b) => new Date(a.at) - new Date(b.at));
  const open = {};
  const closed = [];
  for (const row of rows) {
    const book = open[row.ticker] || [];
    open[row.ticker] = book;
    const price = Number(row.price);
    if (!book.length || book[0].side === row.side) {
      book.push({ side: row.side, price, at: row.at, venue: row.venue });
      continue;
    }
    const entry = book.shift();
    const loss = entry.side === "sell" ? price > entry.price : price < entry.price;
    closed.push({
      ticker: row.ticker,
      side: entry.side,
      entry: entry.price,
      exit: price,
      at: row.at,
      venue: row.venue,
      loss,
    });
  }
  return closed;
}

function writeSandbox(graph) {
  putNode(graph, {
    id: "hub:sandbox",
    process: "sandbox",
    hub: true,
    title: "Песочница",
    body: "Сделки учебного счёта. Боевой счёт этот процесс не трогает. Каждое закрытие становится отдельной заметкой.",
  });
  const closed = roundTrips();
  const losses = closed.filter((row) => row.loss);
  putNode(graph, {
    id: "sandbox:today",
    process: "sandbox",
    title: `Сегодня ${closed.length} закрытий`,
    body: losses.length
      ? `Из них в минусе ${losses.length}. Пока день не кончился, сторону с минусом правило больше не открывает.`
      : "Закрытий в минус сегодня нет.",
  });
  putLink(graph, "hub:sandbox", "sandbox:today", "сводка");
  for (const row of closed.slice(-8)) {
    const id = `sandbox:${row.ticker}:${row.at}`;
    const side = row.side === "sell" ? "шорт" : "лонг";
    putNode(graph, {
      id,
      process: "sandbox",
      title: `${row.ticker} ${side}`,
      body: `${side} ${row.ticker}: вход ${row.entry}, выход ${row.exit}. ${row.loss ? "Минус." : "Плюс."} Счёт ${row.venue === "sandbox" ? "песочницы" : "боевой"}.`,
    });
    putLink(graph, "sandbox:today", id, row.loss ? "минус" : "плюс");
  }
  return { closed, losses };
}

function writeTrades(graph) {
  putNode(graph, {
    id: "hub:trades",
    process: "trades",
    hub: true,
    title: "Свои и чужие сделки",
    body: "Чужие — это статистика хода контракта на следующий день. Свои — закрытые сделки с 2020 и журнал стола.",
  });
  const learned = experience.rule(experience.load());
  const archive = history.stats();
  const long = archive.followLong || { n: 0, avg: 0, wins: 0 };
  const short = archive.followShort || { n: 0, avg: 0, wins: 0 };
  putNode(graph, {
    id: "trades:own-long",
    process: "trades",
    title: "Свои лонги",
    body: `С ${archive.from || "2020"} закрытых покупок ${long.n}, в среднем ${pct(long.avg || 0)}, в плюсе ${long.wins || 0}.`,
  });
  putNode(graph, {
    id: "trades:own-short",
    process: "trades",
    title: "Свои шорты",
    body: `С ${archive.from || "2020"} закрытых коротких ${short.n}, в среднем ${pct(short.avg || 0)}, в плюсе ${short.wins || 0}.`,
  });
  putNode(graph, {
    id: "trades:market",
    process: "trades",
    title: "Чужой опыт рынка",
    body: learned.text,
  });
  putLink(graph, "hub:trades", "trades:own-long", "архив");
  putLink(graph, "hub:trades", "trades:own-short", "архив");
  putLink(graph, "hub:trades", "trades:market", "годы");
  return learned;
}

async function writeNews(graph, board) {
  putNode(graph, {
    id: "hub:news",
    process: "news",
    hub: true,
    title: "Новости и ход",
    body: "Ленты Axios, CNN, РБК и BBC. Заметка появляется, только если тема новости совпала с ходом фьючерса.",
  });
  let rows = [];
  try {
    rows = await headlines.collect();
  } catch {
    rows = [];
  }
  let listed = board;
  if (!listed?.rows) {
    try {
      listed = await loadFuturesBoard();
    } catch {
      listed = { rows: [], quotes: {} };
    }
  }
  const quotes = listed.quotes || {};
  const byTopic = new Map();
  for (const row of rows) {
    for (const topic of row.topics || []) {
      const list = byTopic.get(topic) || [];
      list.push(row);
      byTopic.set(topic, list);
    }
  }
  const links = [];
  for (const [topic, items] of byTopic) {
    const root = ROOTS[topic];
    if (!root) continue;
    const moved = Object.entries(quotes)
      .filter(([id, quote]) => id.startsWith(root) && quote?.day != null)
      .sort((a, b) => Math.abs(b[1].day) - Math.abs(a[1].day))[0];
    if (!moved) continue;
    const [id, quote] = moved;
    const noteId = `news:${topic}`;
    const sample = items[0]?.title || "";
    putNode(graph, {
      id: noteId,
      process: "news",
      title: `${topic} · ${id}`,
      body: `${items.length} новостей. ${id} за день ${pct(quote.day)}. ${sample}`,
    });
    putLink(graph, "hub:news", noteId, "тема");
    links.push({ topic, root, id, day: quote.day, count: items.length, title: sample });
  }
  if (!links.length) {
    putNode(graph, {
      id: "news:empty",
      process: "news",
      title: "Связей пока нет",
      body: headlines.summary(rows),
    });
    putLink(graph, "hub:news", "news:empty", "лента");
  }
  return links;
}

function writeRule(graph, sandbox, learned, newsLinks) {
  const losses = sandbox.losses || [];
  const lostSell = losses.some((row) => row.side === "sell");
  const lostBuy = losses.some((row) => row.side === "buy");
  const allowLong = learned.allowLong !== false && !lostBuy;
  const allowShort = learned.allowShort !== false && !lostSell;
  const minMove = losses.length >= 3 ? 0.006 : 0.003;
  const preferRoots = [];
  for (const link of newsLinks) {
    if (link.count < 1 || Math.abs(link.day) < minMove || Math.abs(link.day) > 0.012) continue;
    const sideAllowed = link.day > 0 ? allowLong : allowShort;
    if (sideAllowed) preferRoots.push(link.root);
  }
  const parts = [];
  if (!allowLong) parts.push(lostBuy ? "лонг сегодня уже закрывался в минус, новую покупку не открываю" : "лонг выключен опытом своих и рыночных сделок");
  else parts.push("лонг разрешён опытом");
  if (!allowShort) parts.push(lostSell ? "шорт сегодня уже закрывался в минус, новый короткий контракт не открываю" : "шорт выключен опытом");
  else parts.push("шорт разрешён опытом");
  parts.push(losses.length >= 3 ? "после трёх минусов за день беру ход только от 0,6% до 1,2%" : "беру ход от 0,3% до 1,2%");
  if (newsLinks.length) {
    const names = newsLinks.slice(0, 3).map((link) => `${link.topic} (${link.id} ${pct(link.day)})`).join(", ");
    parts.push(`новости связаны с ходом: ${names}`);
  }
  const text = `${parts.join(". ")}.`;
  putNode(graph, {
    id: "hub:rule",
    process: "rule",
    hub: true,
    title: "Правило сейчас",
    body: text,
  });
  graph.links = graph.links.filter((link) => link.to !== "hub:rule");
  putLink(graph, "sandbox:today", "hub:rule", lostSell || lostBuy ? "минус дня" : "день");
  putLink(graph, "trades:market", "hub:rule", "опыт");
  putLink(graph, "trades:own-long", "hub:rule", allowLong ? "лонг открыт" : "лонг закрыт");
  putLink(graph, "trades:own-short", "hub:rule", allowShort ? "шорт открыт" : "шорт закрыт");
  for (const link of newsLinks.slice(0, 6)) putLink(graph, `news:${link.topic}`, "hub:rule", "ход и новость");
  graph.rule = {
    allowLong,
    allowShort,
    minMove,
    maxMove: 0.012,
    preferRoots: [...new Set(preferRoots)],
    skipRoots: learned.skipRoots || [],
    text,
  };
}

async function cycle(board) {
  const graph = load();
  const sandbox = writeSandbox(graph);
  const learned = writeTrades(graph);
  const newsLinks = await writeNews(graph, board);
  writeRule(graph, sandbox, learned, newsLinks);
  graph.at = new Date().toISOString();
  return save(graph);
}

function current() {
  return load();
}

module.exports = { cycle, current, roundTrips };
