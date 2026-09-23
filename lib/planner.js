const EXAMPLE_LEGS = [
  { id: "ROSN", weight: 0.65, role: "hedge" },
  { id: "RNFT", weight: 0.2, role: "hedge" },
  { id: "SELG", weight: 0.15, role: "trend" },
];

const EARN_LEGS = [
  { id: "ROSN", weight: 0.25, role: "hedge" },
  { id: "RNFT", weight: 0.1, role: "hedge" },
  { id: "SELG", weight: 0.25, role: "trend" },
  { id: "SVZ6", weight: 0.15, role: "trend" },
];

function adaptLegs(legs, clock) {
  const regime = clock?.regime || { hedgeScale: 1, trendScale: 1, id: "base", title: "" };
  return legs
    .map((leg) => {
      const scale = leg.role === "hedge" ? regime.hedgeScale : regime.trendScale;
      return { ...leg, weight: Math.min(0.4, leg.weight * scale) };
    })
    .filter((leg) => leg.weight >= 0.04);
}

function rub(n) {
  return Math.round(n);
}

function sharesFor(amount, price) {
  if (!(price > 0)) return 0;
  return Math.floor(amount / price);
}

function rowMap(book) {
  return Object.fromEntries(book.rows.map((row) => [row.id, row]));
}

function legCopy(row, weight, role) {
  if (role === "hedge") {
    return `Страховка отскока по бете 20 сессий ${row.beta20.toFixed(2)}. Это среднее, а не ход каждых суток: в отдельный день бумага может вырасти при падающей нефти.`;
  }
  return `Ставка в ту же сторону, что и шорт. Бета ${row.beta20.toFixed(2)}: при падении Brent бумага обычно растёт. Это не страховка шорта.`;
}

function buildLegs(book, policy, clock, dropIds) {
  const drop = new Set(dropIds || []);
  const keep = (legs) => legs.filter((leg) => !drop.has(leg.id));
  const rows = rowMap(book);
  if (policy === "earn") return keep(adaptLegs(EARN_LEGS, clock));
  if (policy === "beta") {
    const hedges = book.rows
      .filter((row) => row.code === "insurance" && row.beta20 > 0)
      .sort((a, b) => b.beta20 - a.beta20)
      .slice(0, 2);
    const trend = book.rows
      .filter((row) => row.code === "cover" && row.group !== "Фьючерс")
      .sort((a, b) => a.beta20 - b.beta20)[0];
    const betaSum = hedges.reduce((sum, row) => sum + row.beta20, 0) || 1;
    const legs = hedges.map((row) => ({
      id: row.id,
      weight: (0.85 * row.beta20) / betaSum,
      role: "hedge",
    }));
    if (trend) legs.push({ id: trend.id, weight: 0.15, role: "trend" });
    return keep(legs);
  }
  return keep(EXAMPLE_LEGS);
}

function planTrade(book, input) {
  const notional = Number(input.notional);
  const shock = Number(input.shock);
  const policy = input.policy === "beta" || input.policy === "example" ? input.policy : "earn";
  const clock = input.clock || null;
  if (!(notional > 0)) throw new Error("Сумма шорта должна быть больше нуля");
  if (!(shock < 0 && shock > -0.2)) throw new Error("Ожидаемое движение задайте от −0.1% до −20%");

  const rows = rowMap(book);
  const brent = book.brent;
  const target = brent.last * (1 + shock);
  const dropIds = input.dropIds || [];
  const template = buildLegs(book, policy, clock, dropIds);
  const orders = [];
  const steps = [
    {
      n: 1,
      title: "Условие",
      text: `Открыт шорт ${brent.contract} на ${rub(notional).toLocaleString("ru-RU")} ₽. Ждём ещё ${Math.abs(shock * 100).toFixed(1)}%: от ${brent.last.toFixed(2)} к ${target.toFixed(2)}. Заработок на падении даёт сам шорт и лонги с отрицательной бетой. Страховка намеренно маленькая, чтобы не съесть эту прибыль.`,
    },
  ];
  if (dropIds.includes("ROSN")) {
    steps.push({
      n: steps.length + 1,
      title: "Роснефть сегодня",
      text: "За последние сутки Роснефть выросла, пока нефть не росла. Лонг Роснефти из сегодняшней заявки убран: как страховка этих суток он не сработал. Бета 20 сессий в книге остаётся положительной, это среднее, не закон дня.",
    });
  }
  if (clock?.regime) {
    const slotLine = (clock.slots || [])
      .map((slot) => `${slot.label}: ${slot.text}`)
      .join(". ");
    steps.push({
      n: steps.length + 1,
      title: "Слоты дня",
      text: `${clock.regime.title}. ${slotLine}`,
    });
  }

  let netBeta = -1;
  let index = steps.length + 1;
  for (const item of template) {
    const row = rows[item.id];
    if (!row) throw new Error(`В книге нет ${item.id}`);
    const amount = notional * item.weight;
    const qty = sharesFor(amount, row.last);
    const filled = qty * row.last;
    const betaPiece = item.weight * row.beta20;
    netBeta += betaPiece;
    const move = row.beta20 * shock;
    orders.push({
      side: "BUY",
      id: row.id,
      name: row.name,
      role: item.role,
      roleLabel: item.role === "hedge" ? "страховка" : "вместе с шортом",
      weight: item.weight,
      beta20: row.beta20,
      beta60: row.beta60,
      price: row.last,
      priceDate: row.date,
      amount,
      qty,
      filled,
      cashLeft: amount - filled,
      expectedOnShock: move,
      pnlOnShock: filled * move,
    });
    steps.push({
      n: index,
      title: `${row.name} · ${(item.weight * 100).toFixed(0)}%`,
      text: `Открываю лонг на ${(item.weight * 100).toFixed(0)}% суммы шорта: ${rub(amount).toLocaleString("ru-RU")} ₽, ${qty.toLocaleString("ru-RU")} шт. по ${row.last.toFixed(2)}. ${legCopy(row, item.weight, item.role)} Если Brent сделает ${(shock * 100).toFixed(1)}%, эта нога в среднем ${move >= 0 ? "даст" : "отнимет"} ${Math.abs(move * 100).toFixed(2)}% своей суммы.${row.group === "Фьючерс" ? " На боевом счёте это фьючерс: покупается контрактами под гарантийное обеспечение, не как акция." : ""}`,
    });
    index += 1;
  }

  const shortPnl = -shock * notional;
  const longPnl = orders.reduce((sum, order) => sum + order.pnlOnShock, 0);
  const bounceShock = -shock;
  const bounceShort = -bounceShock * notional;
  const bounceLong = orders.reduce((sum, order) => sum + order.filled * order.beta20 * bounceShock, 0);

  steps.push({
    n: index,
    title: "Что остаётся от шорта",
    text: `Чувствительность всего пакета к Brent: ${netBeta.toFixed(2)}. Падение на ${(Math.abs(shock) * 100).toFixed(1)}% даёт по шорту +${rub(shortPnl).toLocaleString("ru-RU")} ₽ и по лонгам ${rub(longPnl).toLocaleString("ru-RU")} ₽, вместе ${rub(shortPnl + longPnl).toLocaleString("ru-RU")} ₽. Если нефть на столько же вырастет, результат ${rub(bounceShort + bounceLong).toLocaleString("ru-RU")} ₽.`,
  });

  const pctOf = (item) => `${(item.weight * 100).toFixed(0)}% ${rows[item.id].name}`;
  const trend = template.filter((item) => item.role === "trend");
  const hedge = template.filter((item) => item.role === "hedge");
  const sentence =
    policy === "earn"
      ? `Шорт Brent оставляю: на падении зарабатывает он. Добавляю ${trend.map(pctOf).join(" и ") || "ничего"}. Страховку держу короткой: ${hedge.map(pctOf).join(" и ") || "без неё"}.`
      : `Если открыт шорт на Brent и ждём падение ещё ${(Math.abs(shock) * 100).toFixed(1)}%, то открываю ${template
          .map((item, i) => (i === 0 ? `лонг на ${pctOf(item)} от суммы` : `ещё ${pctOf(item)}`))
          .join(", ")}.`;

  return {
    policy,
    clock: clock
      ? { regime: clock.regime, slots: clock.slots, source: clock.source, asOf: clock.asOf }
      : null,
    notional,
    shock,
    brent,
    target,
    netBeta,
    sentence,
    steps,
    orders,
    cashRequired: orders.reduce((sum, order) => sum + order.filled, 0),
    scenarios: [
      {
        label: `Brent ${(shock * 100).toFixed(1)}%`,
        short: shortPnl,
        longs: longPnl,
        total: shortPnl + longPnl,
      },
      {
        label: `Brent +${(Math.abs(shock) * 100).toFixed(1)}%`,
        short: bounceShort,
        longs: bounceLong,
        total: bounceShort + bounceLong,
      },
    ],
  };
}

module.exports = { planTrade, EXAMPLE_LEGS };
