async function dispatch(workflow) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return { ok: false, status: 0 };
  const response = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "commodity-desk",
    },
    body: JSON.stringify({ ref: "master" }),
  });
  return { ok: response.status === 204, status: response.status };
}

module.exports = { dispatch };
