const learn = require("../lib/learn");

async function main() {
  const lessons = await learn.ensure();
  console.log(learn.summary() || "Учёба пока пустая.");
  console.log("профилей", (lessons.people || []).length, "бумаг", (lessons.tickers || []).length);
  if (!process.env.CURSOR_API_KEY) {
    console.log("Субагент Cursor не вызван: ключа нет. Учёба идёт по открытым профилям Пульса.");
    return;
  }
  const { Agent } = await import("@cursor/sdk");
  const names = (lessons.tickers || []).slice(0, 8).map((item) => `${item.ticker} +${item.avg}% n=${item.n}`).join(", ");
  const result = await Agent.prompt(`Ты субагент торгового стола. Не ставь заявки и не проси токен брокера. По этим повторяющимся бумагам крупных счетов напиши одно предложение по-русски: какие имена стол должен сравнить с нефтью в 9:00. ${names}`, {
    apiKey: process.env.CURSOR_API_KEY,
  });
  console.log(result?.result || result?.text || "субагент ответил без текста");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
