const money = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const priceFmt = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const els = {
  gate: document.querySelector("#gate"),
  desk: document.querySelector("#desk"),
  gateTitle: document.querySelector("#gate-title"),
  gateHint: document.querySelector("#gate-hint"),
  gateStatus: document.querySelector("#gate-status"),
  meta: document.querySelector("#meta"),
  sentence: document.querySelector("#sentence"),
  regime: document.querySelector("#regime"),
  slots: document.querySelector("#slots"),
  steps: document.querySelector("#steps"),
  orders: document.querySelector("#orders"),
  scenarios: document.querySelector("#scenarios"),
  positions: document.querySelector("#positions"),
  trades: document.querySelector("#trades"),
  sandboxJournal: document.querySelector("#sandbox-journal"),
  sandboxResult: document.querySelector("#sandbox-result"),
  dayPlan: document.querySelector("#day-plan"),
  positionPlan: document.querySelector("#position-plan"),
  sandboxMeta: document.querySelector("#sandbox-meta"),
  sandboxDecision: document.querySelector("#sandbox-decision"),
  sandboxLines: document.querySelector("#sandbox-lines"),
  sandboxPause: document.querySelector("#sandbox-pause"),
  status: document.querySelector("#status"),
  notional: document.querySelector("#notional"),
  shock: document.querySelector("#shock"),
  policy: document.querySelector("#policy"),
  pause: document.querySelector("#pause"),
  banner: document.querySelector("#banner"),
  dayNote: document.querySelector("#day-note"),
  advice: document.querySelector("#advice"),
  watch: document.querySelector("#watch"),
  checks: document.querySelector("#checks"),
  brokerRows: document.querySelector("#broker-rows"),
};

let needsSetup = false;
let board = null;

function pct(value) {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

function input() {
  return {
    notional: Number(els.notional.value),
    shock: Number(els.shock.value) / 100,
    policy: els.policy.value,
  };
}

function roleTag(role) {
  const cls = role === "hedge" ? "hedge" : "trend";
  const label = role === "hedge" ? "страховка" : "вместе с шортом";
  return `<span class="tag ${cls}">${label}</span>`;
}

function showDesk(on) {
  els.gate.hidden = on;
  els.desk.hidden = !on;
}

function editsFromTable() {
  const legs = {};
  for (const row of els.orders.querySelectorAll("tr[data-id]")) {
    const id = row.dataset.id;
    const qty = Number(row.querySelector(".qty-edit").value);
    legs[id] = {
      skip: row.querySelector(".skip-edit").checked,
      qty: qty > 0 ? qty : null,
    };
  }
  const marks = {};
  for (const field of els.watch.querySelectorAll(".mark-edit")) {
    const value = Number(field.value);
    if (value > 0) marks[field.dataset.key] = value;
  }
  return { legs, marks, pauseSlots: els.pause.checked };
}

function renderWatch(next) {
  board = next;
  if (next?.notional && document.activeElement !== els.notional) els.notional.value = Math.round(next.notional);
  els.pause.checked = Boolean(next?.overrides?.pauseSlots);
  const br = pct(next.brDay);
  const rosn = pct(next.rosnDay);
  const rosnLine = next.dropIds?.includes("ROSN")
    ? "За эти сутки Роснефть с нефтью не упала, поэтому лонг Роснефти из сегодняшней заявки убран."
    : "Сегодняшний ход не спорит с бетой 20 сессий, Роснефть остаётся короткой страховкой.";
  els.dayNote.textContent = `На ленте MOEX к вчерашнему закрытию BR-10.26 ${br}, Роснефть ${rosn}. Вы видите нефть −2,59% и Роснефть +0,32%: эти две цифры на текущую ленту не ложатся. Если у брокера другая цена, впишите её в столбец и сохраните правку. Бета Роснефти за 20 сессий положительная, это среднее. ${rosnLine}`;
  els.watch.innerHTML = (next.rows || [])
    .map((row) => {
      const cls = row.pnl > 0 ? "up" : row.pnl < 0 ? "down" : "";
      return `<tr>
        <td>${row.name}<br>${row.side === "short" ? "шорт" : row.side}</td>
        <td class="num">${row.qty}</td>
        <td class="num">${priceFmt.format(row.entry)}</td>
        <td class="num">${priceFmt.format(row.target)}</td>
        <td class="num">${row.exchange ? priceFmt.format(row.exchange) : "—"}</td>
        <td><input class="cell mark-edit" data-key="${row.key}" type="number" step="0.01" value="${row.broker || ""}" /></td>
        <td class="num ${cls}">${pct(row.fromEntry)}</td>
        <td class="num">${row.hit ? "на цели" : row.mark ? "ещё " + ((row.mark - row.target) / row.mark * 100).toFixed(2) + "%" : "—"}</td>
        <td class="num ${cls}">${row.pnl == null ? "—" : money.format(row.pnl) + " ₽"}</td>
        <td>${row.hit ? "цель достигнута" : "жду цену"}</td>
      </tr>`;
    })
    .join("");
  const total = next.pnl == null ? "—" : `${money.format(next.pnl)} ₽`;
  els.advice.textContent = `Вместе по вашим уровням и цене биржи: ${total}. Курс доллара ${priceFmt.format(next.usd)}. Ближняя сверка — октябрь: 3 контракта к 95 и 5 контрактов к 93,3. Ноябрьские 2 контракта к 88,85 — дальняя цель, до неё от входа 100,76 ещё около 12%. Пока биржа выше цели, шорт не закрываю. На падение добавляю Селигдар и серебро, Русснефть оставляю короткой страховкой. Роснефть сегодня не покупаю.`;
  els.checks.innerHTML = next.checkpoints?.length
    ? next.checkpoints
        .map((item) => {
          const hits = (item.rows || []).filter((row) => row.hit).length;
          return `<tr><td>${item.at.slice(0, 16).replace("T", " ")}</td><td class="num">${money.format(item.pnl)} ₽</td><td>${hits} из ${item.rows.length}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="3">Сверок ещё нет. Нажмите «Зафиксировать сверку» и сравните через несколько часов.</td></tr>`;
}

function renderPlan(plan) {
  els.sentence.textContent = plan.sentence;
  const slots = plan.clock?.slots || [];
  const regime = plan.clock?.regime?.title || "Слоты ещё не посчитаны.";
  const source = plan.clock?.source ? ` Источник: ${plan.clock.source}.` : "";
  els.regime.textContent = regime + source;
  els.slots.innerHTML = slots.length
    ? slots
        .map((slot) => {
          const sign = slot.direction === "down" ? "падение" : slot.direction === "up" ? "рост" : slot.direction === "flat" ? "боковик" : "жду";
          const ret = slot.ret == null ? "—" : pct(slot.ret);
          return `<tr><td>${slot.label}</td><td>${sign}</td><td class="num">${ret}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="3">Нет минутных свечей</td></tr>`;
  els.steps.innerHTML = plan.steps
    .map((step) => `<li><strong>${step.n}. ${step.title}</strong>${step.text}</li>`)
    .join("");
  const legs = plan.board?.overrides?.legs || {};
  els.orders.innerHTML = plan.orders
    .map((order) => {
      const patch = legs[order.id] || {};
      return `<tr data-id="${order.id}">
        <td>Покупка</td>
        <td>${order.id} ${order.name}</td>
        <td>${roleTag(order.role)}</td>
        <td class="num">${(order.weight * 100).toFixed(0)}%</td>
        <td class="num">${order.qty.toLocaleString("ru-RU")}</td>
        <td><input class="cell qty-edit" type="number" min="0" step="1" value="${patch.qty || ""}" /></td>
        <td><input class="skip-edit" type="checkbox" ${patch.skip ? "checked" : ""} /></td>
        <td class="num">${priceFmt.format(order.price)}</td>
        <td class="num">${money.format(order.filled)} ₽</td>
      </tr>`;
    })
    .join("");
  els.scenarios.innerHTML = plan.scenarios
    .map(
      (row) => `<tr>
        <td>${row.label}</td>
        <td class="num">${money.format(row.short)} ₽</td>
        <td class="num">${money.format(row.longs)} ₽</td>
        <td class="num">${money.format(row.total)} ₽</td>
      </tr>`,
    )
    .join("");
  if (plan.board) renderWatch(plan.board);
}

function renderAccount(account) {
  const positions = account.positions.length
    ? account.positions
        .map(
          (position) => `<tr>
            <td>${position.id}</td>
            <td class="num">${position.qty < 0 ? "шорт" : position.qty.toLocaleString("ru-RU")}</td>
            <td class="num">${position.notional ? money.format(position.notional) + " ₽" : priceFmt.format(position.avg)}</td>
            <td>${position.role === "short" ? "шорт Brent" : position.role === "hedge" ? "страховка" : "вместе с шортом"}</td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="4">Позиций нет</td></tr>`;
  els.positions.innerHTML = positions;
  els.trades.innerHTML = account.trades.length
    ? account.trades
        .slice(0, 12)
        .map(
          (trade) => `<tr>
            <td>${trade.time.slice(11, 19)}</td>
            <td>${trade.side === "BUY" ? "Покупка" : trade.side === "SELL" ? "Продажа" : "Шорт"}</td>
            <td>${trade.id}</td>
            <td class="num">${trade.qty.toLocaleString("ru-RU")}</td>
            <td class="num">${money.format(trade.amount)} ₽</td>
            <td>${trade.role}</td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="6">Сделок нет</td></tr>`;
}

function renderBroker(info) {
  document.querySelector("#sandbox-open").disabled = false;
  document.querySelector("#sandbox-pay").disabled = false;
  const parts = [];
  if (info?.sandbox?.connected) parts.push(`Песочница …${info.sandbox.tail}, на биржу не идёт`);
  if (info?.live?.connected) parts.push(`Боевой счёт …${info.live.tail}. Лимит — свободные рубли на счёте`);
  if (!info?.connected && !parts.length) {
    els.banner.textContent = "Токен не сохранён. Вставьте его в поле слева, не в чат.";
    return;
  }
  els.banner.textContent = parts.join(". ") + ".";
  if (info.accountId && !document.querySelector("#broker-account").value) {
    const select = document.querySelector("#broker-account");
    if (![...select.options].some((option) => option.value === info.accountId)) {
      select.innerHTML = `<option value="${info.accountId}">${info.accountId}</option>`;
    }
    select.value = info.accountId;
  }
}

async function refreshPlan() {
  const response = await fetch("/api/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input()),
  });
  const plan = await response.json();
  if (response.status === 401) {
    showDesk(false);
    return;
  }
  if (!response.ok) {
    els.status.textContent = plan.error || "Не удалось посчитать план";
    return;
  }
  renderPlan(plan);
  els.status.textContent = `На лонги нужно ${money.format(plan.cashRequired)} ₽ по ценам книги ${plan.brent.date}. Бумажный журнал биржу не трогает.`;
}

async function bootDesk() {
  const response = await fetch("/api/broker");
  if (response.status === 401) {
    showDesk(false);
    return;
  }
  const broker = await response.json();
  const live = broker.live;
  els.meta.textContent = live?.connected
    ? `Боевой счёт …${live.tail}. Лимит — свободные рубли на счёте.`
    : "Боевой счёт не подключён.";
  await refreshSandbox();
}

function cloudScreen() {
  return location.hostname !== "127.0.0.1" && location.hostname !== "localhost";
}

async function boot() {
  const cloud = cloudScreen();
  if (cloud) document.querySelector(".toolbar .check").hidden = true;
  const response = await fetch("/api/session");
  const session = await response.json();
  needsSetup = session.needsSetup;
  els.gateTitle.textContent = needsSetup ? "Задайте пароль админа" : "Вход";
  els.gateHint.textContent = cloud
    ? "Тот же пароль, что у стола на компьютере."
    : needsSetup
      ? "Первый запуск. Пароль останется на этом компьютере, в чат его писать не нужно."
      : "Стол на этом компьютере. Пароль хранится только локально.";
  document.querySelector("#password").autocomplete = needsSetup ? "new-password" : "current-password";
    if (session.admin) {
    showDesk(true);
    await bootDesk();
    await refreshChat();
    return;
  }
  showDesk(false);
}

document.querySelector("#gate-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = document.querySelector("#password").value;
  const button = event.target.querySelector("button");
  button.disabled = true;
  els.gateStatus.textContent = "Проверяю пароль...";
  try {
    let response = await fetch(needsSetup ? "/api/setup" : "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (response.status === 409) {
      needsSetup = false;
      response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
    }
    const data = await response.json();
    if (!response.ok) {
      const session = await fetch("/api/session").then((item) => item.json());
      needsSetup = session.needsSetup;
      els.gateTitle.textContent = needsSetup ? "Задайте пароль админа" : "Вход";
      els.gateStatus.textContent = needsSetup
        ? "Этот пароль не сохранился. Введите его ещё раз."
        : "Пароль не подошёл. Введите его ещё раз.";
      return;
    }
    document.querySelector("#password").value = "";
    showDesk(true);
    els.meta.textContent = "Вход выполнен. Считаю боевой счёт.";
    await bootDesk();
    await refreshChat();
  } catch (err) {
    els.gateStatus.textContent = "Сервер не ответил. Обновите страницу и повторите.";
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  showDesk(false);
});

function renderSandbox(box) {
  if (!box) return;
  els.sandboxPause.checked = box.enabled === false;
  if (!box.ready) {
    const raw = box.text || "Песочница не посчитана";
    els.sandboxResult.textContent = /timeout|aborted/i.test(raw) ? "Биржа не ответила вовремя" : raw;
    els.sandboxResult.className = "result";
    els.sandboxMeta.textContent = "";
    els.sandboxDecision.textContent = box.lastDecision || "";
    return;
  }
  const pnl = box.pnl || 0;
  const yieldPct = box.deposited ? pnl / box.deposited : 0;
  const yieldText = `${yieldPct >= 0 ? "+" : ""}${(yieldPct * 100).toFixed(2).replace(".", ",")}%`;
  els.sandboxResult.textContent = `${pnl >= 0 ? "+" : ""}${money.format(pnl)} ₽ (${yieldText})`;
  els.sandboxResult.className = `result ${pnl >= 0 ? "up" : "down"}`;
  const updated = box.updatedAt ? ` Обновлено ${mskClock(box.updatedAt).slice(0, 5)} мск.` : "";
  const oilText = box.futuresSettled
    ? `Нефть ${money.format(box.futuresPnl || 0)} ₽ уже внутри свободных денег.`
    : `Нефть ${money.format(box.futuresPnl || 0)} ₽.`;
  els.sandboxMeta.textContent = `Внесено ${money.format(box.deposited)} ₽. Свободно ${money.format(box.available || box.cash)} ₽. Акции ${money.format(box.stockValue || 0)} ₽. ${oilText}${updated}`;
  if (els.dayPlan) els.dayPlan.textContent = box.plan?.day || "";
  if (els.positionPlan) els.positionPlan.textContent = (box.plan?.positions || []).join("\n");
  els.sandboxDecision.textContent = [box.priceNote, box.lastDecision].filter(Boolean).join(" ");
  els.sandboxLines.innerHTML = box.lines?.length
    ? box.lines
        .map((line) => {
          const cls = line.pnl > 0 ? "up" : line.pnl < 0 ? "down" : "";
          return `<tr>
            <td>${line.ticker}</td>
            <td class="num">${line.qty}</td>
            <td class="num">${priceFmt.format(line.avg)}</td>
            <td class="num">${priceFmt.format(line.current)}</td>
            <td class="num ${cls}">${line.pnl >= 0 ? "+" : ""}${money.format(line.pnl)} ₽</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="5">Открытых позиций нет</td></tr>`;
  if (box.journal) renderSandboxJournal(box.journal);
  renderLogic(box.logic);
}

function mskClock(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(11, 19);
}

function tradeIncome(list) {
  const open = {};
  const marked = [];
  const rows = (list || []).filter((row) => row.venue === "live").slice().sort((a, b) => new Date(a.at) - new Date(b.at));
  for (const row of rows) {
    const lots = row.lotsExecuted || row.lots || 0;
    const perLot = lots ? Number(row.amount) / lots : 0;
    const book = open[row.ticker] || [];
    open[row.ticker] = book;
    if (row.side === "buy") {
      if (book.length && book[0].side === "sell") {
        marked.push(closeAgainst(row, book, perLot, lots));
      } else {
        book.push({ side: "buy", left: lots, perLot, price: Number(row.price), reason: row.reason || "" });
        marked.push({ ...row, tradePnl: null });
      }
    } else if (book.length && book[0].side !== "sell") {
      marked.push(closeAgainst(row, book, perLot, lots));
    } else {
      book.push({ side: "sell", left: lots, perLot, price: Number(row.price), reason: row.reason || "" });
      marked.push({ ...row, tradePnl: null });
    }
  }
  return marked.reverse();
}

function closeAgainst(row, book, perLot, lots) {
  let left = lots;
  let pnl = 0;
  let entryNotional = 0;
  let entryQty = 0;
  let entryPx = 0;
  let entryReason = "";
  while (left > 0 && book.length) {
    const lot = book[0];
    const take = Math.min(left, lot.left);
    const sign = row.side === "sell" ? 1 : -1;
    pnl += sign * (perLot - lot.perLot) * take;
    entryNotional += lot.perLot * take;
    entryPx += (lot.price || 0) * take;
    entryQty += take;
    if (!entryReason && lot.reason) entryReason = lot.reason;
    lot.left -= take;
    left -= take;
    if (lot.left <= 0) book.shift();
  }
  return {
    ...row,
    tradePnl: pnl,
    entryNotional,
    entryPrice: entryQty ? entryPx / entryQty : null,
    entryReason,
  };
}

function shownReason(row) {
  const vague = /отскок или цель|у брокера|журнале стола/.test(row.reason || "");
  if (row.tradePnl == null || !vague) return row.reason || "";
  const pnl = row.tradePnl;
  const entry = row.entryPrice;
  const exit = Number(row.price);
  const pct = row.entryNotional ? (pnl / row.entryNotional) * 100 : null;
  const pctText = pct == null ? "" : `около ${pct >= 0 ? "+" : ""}${pct.toFixed(1).replace(".", ",")}% от денег входа`;
  const head = entry
    ? `Вход ${priceFmt.format(entry)}, ${row.side === "sell" ? "продажа" : "выкуп"} ${priceFmt.format(exit)}, ${pnl >= 0 ? "+" : ""}${money.format(pnl)} ₽`
    : `${pnl >= 0 ? "+" : ""}${money.format(pnl)} ₽`;
  const fromBroker = row.brokerOp || /брокера|журнале стола/.test(row.reason || "");
  let rule;
  if (fromBroker && pct != null && pct < 1 && pnl > 0) {
    rule = "До цели +1% это не дотягивает. Продажа прошла у брокера, стол в журнал её не записал — теперь строка на месте.";
  } else if (fromBroker) {
    rule = "Эта сделка была у брокера и раньше в журнал не попала.";
  } else if (pnl > 0 && /отскок/i.test(row.entryReason || "")) {
    rule = "Закрыл отскок: от своего входа набрался плюс. У такой покупки цель около +0,6%.";
  } else if (pnl > 0) {
    rule = "Закрыл лонг по цели: от своего входа набрался плюс около 1% или больше. Это не ставка на отскок.";
  } else if (pnl < 0) {
    rule = "Закрыто по стопу: от своего входа набрался минус.";
  } else {
    rule = "Закрыто около нуля.";
  }
  return `${head}${pctText ? ", " + pctText : ""}. ${rule}`;
}

function renderLogic(list) {
  const node = document.querySelector("#logic");
  if (!node) return;
  node.innerHTML = list?.length
    ? list.map((item) => `<li><strong>${item.title}</strong>${item.text}</li>`).join("")
    : `<li>Жду первый разбор после проверки книги.</li>`;
}

function renderSandboxJournal(list) {
  const live = tradeIncome(list);
  els.sandboxJournal.innerHTML = live.length
    ? live
        .slice(0, 20)
        .map((row) => {
          const income = row.tradePnl == null ? "—" : `${row.tradePnl >= 0 ? "+" : ""}${money.format(row.tradePnl)} ₽`;
          const cls = row.tradePnl > 0 ? "up" : row.tradePnl < 0 ? "down" : "";
          return `<tr>
            <td>${mskClock(row.at)}</td>
            <td>${row.side === "buy" ? "Покупка" : "Продажа"}</td>
            <td>${row.ticker}</td>
            <td class="num">${row.lotsExecuted ?? row.lots}</td>
            <td class="num">${row.price == null ? "—" : priceFmt.format(row.price)}</td>
            <td class="num ${cls}">${income}</td>
            <td>${shownReason(row)}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="7">Заявок боевого счёта ещё нет</td></tr>`;
}

async function refreshSandbox() {
  const response = await fetch("/api/sandbox");
  if (!response.ok) return;
  renderSandbox(await response.json());
}

document.querySelector("#sandbox-pause").addEventListener("change", async () => {
  const enabled = !els.sandboxPause.checked;
  const response = await fetch("/api/sandbox/pause", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (response.ok) renderSandbox(await response.json());
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function chatHtml(messages) {
  return (messages || []).length
    ? messages.map((item) => `<p class="${item.role === "user" ? "user" : ""}"><strong>${item.role === "user" ? "Вы" : "Стол"}.</strong> ${escapeHtml(item.text)}</p>`).join("")
    : `<p>Команд ещё не было.</p>`;
}

async function refreshChat() {
  const node = document.querySelector("#chat");
  if (!node) return;
  const response = await fetch("/api/chat");
  if (!response.ok) return;
  const data = await response.json();
  node.innerHTML = chatHtml(data.messages);
  node.scrollTop = node.scrollHeight;
}

document.querySelector("#chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.querySelector("#chat-text");
  const text = input.value.trim();
  if (!text) return;
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (response.status === 401) {
    showDesk(false);
    return;
  }
  input.value = "";
  if (response.ok) {
    const data = await response.json();
    const node = document.querySelector("#chat");
    node.innerHTML = chatHtml(data.messages);
  }
});

boot();
setInterval(() => {
  if (!els.desk.hidden) {
    refreshSandbox();
    refreshChat();
  }
}, 60_000);
