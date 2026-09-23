const { fetchAll } = require("./lib/yahoo");
const {
  attachDateMaps,
  buildSnapshot,
  eventStudy,
  monthlyNormalized,
  pairBacktest,
} = require("./lib/stats");

function pct(x) {
  if (x == null || Number.isNaN(x)) return "n/a";
  return `${(x * 100).toFixed(2)}%`;
}

function num(x, d = 2) {
  if (x == null || Number.isNaN(x)) return "n/a";
  return x.toFixed(d);
}

async function main() {
  const json = process.argv.includes("--json");
  const series = attachDateMaps(await fetchAll());
  const snap = buildSnapshot(series);
  const events = eventStudy(series);
  const backtest = pairBacktest(series);
  const monthly = monthlyNormalized(series);
  const report = { generatedAt: new Date().toISOString(), snap, events, backtest, monthly };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("Commodity Radar  |  Yahoo Finance daily  | ", snap.returns.Brent.date);
  console.log("Режим:", snap.regime.title);
  console.log("");
  console.log("Цена        last        1д      5д     21д     63д    252д");
  for (const [name, r] of Object.entries(snap.returns)) {
    console.log(
      name.padEnd(10),
      String(r.last.toFixed(r.last >= 100 ? 2 : 3)).padStart(10),
      pct(r.d1).padStart(8),
      pct(r.d5).padStart(8),
      pct(r.d21).padStart(8),
      pct(r.d63).padStart(8),
      pct(r.d252).padStart(8),
    );
  }
  console.log("");
  console.log(`Gold/Brent ${num(snap.goldBrent.ratioNow)}  (2г среднее ${num(snap.goldBrent.mean)}, z=${num(snap.goldBrent.z)})`);
  console.log(`Gold/Silver ${num(snap.goldSilver)}`);
  console.log("");
  console.log("Корреляции дневных log-return  |  20д / 60д / 252д");
  const focus = snap.pairs.filter((p) =>
    ["Brent-Gold", "Brent-Silver", "Brent-NatGas", "Brent-Copper", "Gold-Silver", "Gold-DXY", "Brent-ES"].includes(`${p.a}-${p.b}`),
  );
  for (const p of focus) {
    console.log(`${p.a}-${p.b}`.padEnd(16), num(p.c20, 3), "/", num(p.c60, 3), "/", num(p.c252, 3));
  }
  console.log("");
  console.log("Как зарабатывать (сигналы)");
  for (const s of snap.signals) {
    console.log("-", s.action);
    console.log(" ", s.why);
    if (s.instruments.length) console.log(" ", s.instruments.join(" · "));
    console.log("  риск:", s.risk);
  }
  console.log("");
  console.log("Event study 2 года: что делает золото после движения нефти");
  for (const e of events) {
    console.log(
      `- ${e.label}: n=${e.n}  золото>0 ${pct(e.goldHit)}  среднее золото ${pct(e.avgGold5)}  нефть ${pct(e.avgOil5)}`,
    );
  }
  console.log("");
  console.log(
    "Правило: 20д corr<-0.15 и |нефть 5д|>2% → лонг золото / шорт нефть (или наоборот).",
    `2г: стратегия ${pct(backtest.strategy)}, buy&hold золото ${pct(backtest.buyHoldGold)}, Brent ${pct(backtest.buyHoldBrent)}, в рынке ${backtest.daysIn}/${backtest.days} дней.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
