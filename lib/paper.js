const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "paper-account.json");

function empty() {
  return { cash: 0, positions: [], trades: [], updatedAt: null };
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return empty();
  }
}

function save(account) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  account.updatedAt = new Date().toISOString();
  fs.writeFileSync(FILE, JSON.stringify(account, null, 2));
  return account;
}

function positionIndex(account, id) {
  return account.positions.findIndex((position) => position.id === id);
}

function executePlan(plan) {
  const account = load();
  const already = plan.orders.filter((order) =>
    account.positions.some((position) => position.id === order.id && position.qty > 0),
  );
  if (already.length) {
    const error = new Error("Эти лонги уже есть на бумажном счёте: " + already.map((order) => order.id).join(", "));
    error.status = 409;
    throw error;
  }
  const time = new Date().toISOString();
  for (const order of plan.orders) {
    if (order.qty < 1) continue;
    const idx = positionIndex(account, order.id);
    if (idx === -1) {
      account.positions.push({
        id: order.id,
        name: order.name,
        qty: order.qty,
        avg: order.price,
        role: order.role,
      });
    } else {
      const position = account.positions[idx];
      const nextQty = position.qty + order.qty;
      position.avg = (position.avg * position.qty + order.price * order.qty) / nextQty;
      position.qty = nextQty;
      position.role = order.role;
    }
    account.cash -= order.filled;
    account.trades.unshift({
      time,
      side: "BUY",
      id: order.id,
      name: order.name,
      qty: order.qty,
      price: order.price,
      amount: order.filled,
      role: order.roleLabel,
      reason: plan.sentence,
    });
  }
  const short = account.positions.find((position) => position.id === plan.brent.contract);
  if (!short) {
    account.positions.unshift({
      id: plan.brent.contract,
      name: "Brent " + plan.brent.contract,
      qty: -1,
      avg: plan.brent.last,
      role: "short",
      notional: plan.notional,
    });
    account.trades.unshift({
      time,
      side: "SHORT",
      id: plan.brent.contract,
      name: "Brent " + plan.brent.contract,
      qty: 1,
      price: plan.brent.last,
      amount: plan.notional,
      role: "уже открыт",
      reason: "Шорт отмечен как уже открытый, новая заявка на биржу не отправлялась.",
    });
  } else {
    short.notional = plan.notional;
    short.avg = plan.brent.last;
  }
  return save(account);
}

function flatten() {
  const account = load();
  const time = new Date().toISOString();
  for (const position of account.positions) {
    if (position.qty > 0) {
      account.cash += position.qty * position.avg;
      account.trades.unshift({
        time,
        side: "SELL",
        id: position.id,
        name: position.name,
        qty: position.qty,
        price: position.avg,
        amount: position.qty * position.avg,
        role: "закрытие",
        reason: "Закрытие лонга по цене входа. Это бумажный счёт, не биржа.",
      });
    }
  }
  account.positions = account.positions.filter((position) => position.qty < 0);
  return save(account);
}

module.exports = { load, executePlan, flatten, empty, save };
