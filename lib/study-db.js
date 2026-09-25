const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const FILE = path.join(__dirname, "..", "data", "study.db");
const LATEST = path.join(__dirname, "..", "data", "study-latest.json");

function open() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const db = new DatabaseSync(FILE);
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      at TEXT PRIMARY KEY,
      profiles INTEGER,
      trades INTEGER,
      links INTEGER,
      news INTEGER,
      flags INTEGER,
      note TEXT
    );
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seen_at TEXT,
      nick TEXT,
      ticker TEXT,
      price REAL,
      yield REAL,
      entry REAL
    );
    CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seen_at TEXT,
      left_name TEXT,
      right_name TEXT,
      corr REAL,
      days INTEGER
    );
    CREATE TABLE IF NOT EXISTS news (
      id TEXT PRIMARY KEY,
      seen_at TEXT,
      title TEXT,
      published TEXT
    );
    CREATE TABLE IF NOT EXISTS flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seen_at TEXT,
      ticker TEXT,
      kind TEXT,
      detail TEXT
    );
  `);
  return db;
}

function remember(snapshot) {
  const db = open();
  const at = snapshot.at;
  const insertTrade = db.prepare("INSERT INTO trades (seen_at, nick, ticker, price, yield, entry) VALUES (?, ?, ?, ?, ?, ?)");
  for (const row of snapshot.trades || []) {
    insertTrade.run(at, row.nick || "", row.ticker, row.price || null, row.yield || null, row.entry || null);
  }
  const insertLink = db.prepare("INSERT INTO links (seen_at, left_name, right_name, corr, days) VALUES (?, ?, ?, ?, ?)");
  for (const row of snapshot.links || []) insertLink.run(at, row.left, row.right, row.corr, row.days);
  const insertNews = db.prepare("INSERT INTO news (id, seen_at, title, published) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title");
  for (const row of snapshot.news || []) insertNews.run(row.id, at, row.title, row.published || "");
  const insertFlag = db.prepare("INSERT INTO flags (seen_at, ticker, kind, detail) VALUES (?, ?, ?, ?)");
  for (const row of snapshot.flags || []) insertFlag.run(at, row.ticker, row.kind, row.detail);
  db.prepare("INSERT INTO runs (at, profiles, trades, links, news, flags, note) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    at,
    snapshot.profiles || 0,
    (snapshot.trades || []).length,
    (snapshot.links || []).length,
    (snapshot.news || []).length,
    (snapshot.flags || []).length,
    snapshot.note || "",
  );
  const latest = {
    at,
    profiles: snapshot.profiles || 0,
    trades: (snapshot.trades || []).length,
    links: snapshot.links || [],
    news: (snapshot.news || []).slice(0, 5).map((row) => row.title),
    flags: snapshot.flags || [],
    note: snapshot.note || "",
    totals: {
      trades: db.prepare("SELECT COUNT(*) AS n FROM trades").get().n,
      news: db.prepare("SELECT COUNT(*) AS n FROM news").get().n,
      flags: db.prepare("SELECT COUNT(*) AS n FROM flags").get().n,
    },
  };
  fs.writeFileSync(LATEST, JSON.stringify(latest, null, 2));
  db.close();
  return latest;
}

function latest() {
  try {
    return JSON.parse(fs.readFileSync(LATEST, "utf8"));
  } catch {
    return null;
  }
}

function lastLinkAt() {
  const db = open();
  const row = db.prepare("SELECT seen_at AS at FROM links ORDER BY id DESC LIMIT 1").get();
  db.close();
  return row?.at || null;
}

module.exports = { remember, latest, lastLinkAt };
