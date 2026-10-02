// Если смена не идёт, а биржа открыта, запускает её. Сам заявок не ставит.
const openMinutes = (() => {
  const shifted = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const day = shifted.getUTCDay();
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const open = day === 0 || day === 6 ? 10 * 60 : 9 * 60;
  return { minutes, open, close: 23 * 60 + 50 };
})();

async function main() {
  if (openMinutes.minutes < openMinutes.open || openMinutes.minutes >= openMinutes.close) {
    console.log("биржа закрыта, смену не запускаю");
    return;
  }
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error("Нет GITHUB_TOKEN");
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "commodity-desk",
  };
  const listed = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/session.yml/runs?per_page=8`, { headers });
  if (!listed.ok) throw new Error(`список смен ${listed.status}`);
  const body = await listed.json();
  const busy = (body.workflow_runs || []).some((run) => run.status !== "completed");
  if (busy) {
    console.log("смена уже идёт");
    return;
  }
  const dispatched = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/session.yml/dispatches`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "master" }),
  });
  if (dispatched.status !== 204) throw new Error(`запуск смены ${dispatched.status}`);
  console.log("смена запущена");
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
