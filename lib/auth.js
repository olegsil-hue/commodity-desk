const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ADMIN = path.join(__dirname, "..", "data", "admin.json");
const SESSIONS = path.join(__dirname, "..", "data", "sessions.json");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString("hex");
}

function hasAdmin() {
  return fs.existsSync(ADMIN);
}

function setup(password) {
  if (hasAdmin()) {
    const error = new Error("Пароль уже задан.");
    error.status = 409;
    throw error;
  }
  if (typeof password !== "string" || password.length < 8) {
    const error = new Error("Пароль не короче 8 символов.");
    error.status = 400;
    throw error;
  }
  const salt = crypto.randomBytes(16).toString("hex");
  writeJson(ADMIN, { salt, hash: hashPassword(password, salt) });
}

function check(password) {
  const admin = readJson(ADMIN, null);
  if (!admin) return false;
  const got = hashPassword(String(password || ""), admin.salt);
  return crypto.timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(admin.hash, "hex"));
}

function login(password) {
  if (!check(password)) {
    const error = new Error("Пароль не подошёл.");
    error.status = 401;
    throw error;
  }
  const token = crypto.randomBytes(24).toString("hex");
  const sessions = readJson(SESSIONS, {});
  sessions[token] = Date.now() + 12 * 60 * 60 * 1000;
  writeJson(SESSIONS, sessions);
  return token;
}

function valid(token) {
  if (!token) return false;
  const sessions = readJson(SESSIONS, {});
  const until = sessions[token];
  if (!until || until < Date.now()) return false;
  return true;
}

function logout(token) {
  const sessions = readJson(SESSIONS, {});
  delete sessions[token];
  writeJson(SESSIONS, sessions);
}

function tokenFrom(req) {
  const raw = req.headers.cookie || "";
  const part = raw.split(";").map((item) => item.trim()).find((item) => item.startsWith("desk="));
  return part ? part.slice(5) : "";
}

module.exports = { hasAdmin, setup, login, valid, logout, tokenFrom };
