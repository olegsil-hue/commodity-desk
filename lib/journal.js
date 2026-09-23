const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "sandbox-journal.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return [];
  }
}

function add(entry) {
  const list = load();
  list.push({ ...entry, at: entry.at || new Date().toISOString() });
  list.sort((a, b) => new Date(b.at) - new Date(a.at));
  const next = list.slice(0, 100);
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  return next[0];
}

module.exports = { load, add };
