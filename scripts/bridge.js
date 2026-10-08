// Ночная передача: дожидается открытия и запускает смену. Заявок не ставит.
const { dispatch } = require("./github-dispatch");

function moscow(now = new Date()) {
  const shifted = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  return {
    day: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    shifted,
  };
}

function openMinute(day) {
  return day === 0 || day === 6 ? 10 * 60 : 9 * 60;
}

function minutesUntilOpen(now = new Date()) {
  const clock = moscow(now);
  const todayOpen = openMinute(clock.day);
  if (clock.minutes < todayOpen) return todayOpen - clock.minutes;
  const next = new Date(clock.shifted.getTime() + 24 * 60 * 60 * 1000);
  return (24 * 60 - clock.minutes) + openMinute(next.getUTCDay());
}

async function main() {
  const left = minutesUntilOpen();
  const cap = 5 * 60;
  if (left > cap) {
    console.log(new Date().toISOString(), "до открытия больше пяти часов, передаю дальше");
    await new Promise((resolve) => setTimeout(resolve, cap * 60 * 1000));
    const next = await dispatch("bridge.yml");
    console.log(new Date().toISOString(), next.ok ? "следующее ожидание запущено" : `ожидание не запустилось: ${next.status}`);
    return;
  }
  const startAt = Date.now() + Math.max(0, left - 5) * 60 * 1000;
  console.log(new Date().toISOString(), "жду открытия, минут", left);
  while (Date.now() < startAt) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, startAt - Date.now())));
  }
  const session = await dispatch("session.yml");
  console.log(new Date().toISOString(), session.ok ? "смена запущена" : `смена не запустилась: ${session.status}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
