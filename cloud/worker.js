export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/sandbox") {
      const raw = await env.SNAPSHOT.get("live");
      const body = raw || JSON.stringify({ ready: false, text: "Жду первую публикацию с GitHub." });
      return new Response(body, {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/api/broker") {
      const raw = await env.SNAPSHOT.get("live");
      const box = raw ? JSON.parse(raw) : {};
      const tail = box.tail || "";
      return Response.json({
        connected: true,
        mode: "live",
        tail,
        live: { connected: Boolean(tail), tail },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
