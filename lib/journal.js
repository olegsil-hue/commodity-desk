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
  list.unshift({ at: new Date().toISOString(), ...entry });
  fs.writeFileSync(FILE, JSON.stringify(list.slice(0, 100), null, 2));
  return list[0];
}

module.exports = { load, add };
