const fs = require("fs");
const path = require("path");
const { loadMarket } = require("./lib/moex");
const { buildBook } = require("./lib/hedge");

function pct(x, digits = 1) {
  if (x == null || Number.isNaN(x)) return "  n/a";
  const v = (x * 100).toFixed(digits);
  return (x >= 0 ? "+" : "") + v + "%";
}

function num(x, digits = 2) {
  if (x == null || Number.isNaN(x)) return "  n/a";
  return (x >= 0 ? "+" : "") + x.toFixed(digits);
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

async function main() {
  const shockArg = process.argv.find((a) => a.startsWith("--shock="));
  const shock = shockArg ? Number(shockArg.split("=")[1]) / 100 : -0.015;
  const json = process.argv.includes("--json");
  process.stderr.write("MOEX: качаю свечи (акции, индексы, валюта, фьючерсы)...\n");
  const market = await loadMarket("2025-09-01");
  const book = buildBook({ ...market, shock });
  const outPath = path.join(__dirname, "data", "moex-book.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), book, errors: market.errors }, null, 2));

  if (json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), book, errors: market.errors }, null, 2));
    return;
  }

  const b = book.brent;
  console.log("");
  console.log("MOEX TERMINAL   шорт Brent уже открыт, сценарий ещё " + pct(shock, 1));
  console.log(
    `Фронт ${b.contract}   close ${b.date}   ${b.last.toFixed(2)}   5д ${pct(b.d5)}   дней в склейке ${b.points}`,
  );
  console.log("BR-10.26 (BRV6) последний день обращения 2026-10-01. Дальше взгляд переносится в BR-11.26 (BRX6).");
  console.log("");
  console.log(
    pad("Бумага", 18) +
      pad("Группа", 14) +
      pad("5д", 8) +
      pad("c20", 7) +
      pad("b20", 7) +
      pad("b60", 7) +
      pad("при " + pct(shock, 1), 10) +
      "сигнал",
  );
  console.log("-".repeat(110));
  for (const r of book.rows) {
    console.log(
      pad(r.id, 18) +
        pad(r.group, 14) +
        pad(pct(r.d5), 8) +
        pad(num(r.c20), 7) +
        pad(num(r.beta20), 7) +
        pad(num(r.beta60), 7) +
        pad(pct(r.expected), 10) +
        r.action,
    );
  }
  console.log("");
  const rising = book.rows.filter((r) => r.code === "cover" || r.code === "watch-up");
  const insurance = book.rows.filter((r) => r.code === "insurance");
  console.log("Что сделать с открытым шортом Brent");
  console.log("1. Бумаги, которые обычно растут, когда Brent падает. Риск — если вы их тоже шортите. Перекрытие: закрыть эти шорты.");
  for (const r of rising.slice(0, 8)) {
    console.log(`   ${r.id.padEnd(14)} ожидание ${pct(r.expected)}   ${r.action}`);
  }
  console.log("2. Сам шорт Brent теряет, только если нефть пойдёт вверх, а не вниз. Страховка от отскока — малый лонг самой связанной нефти, не лонг золота.");
  for (const r of insurance.slice(0, 5)) {
    console.log(`   ${r.id.padEnd(14)} бета20 ${num(r.beta20)}   ${r.action}`);
  }
  if (market.errors.length) {
    console.log("");
    console.log("Не скачались: " + market.errors.join("; "));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
