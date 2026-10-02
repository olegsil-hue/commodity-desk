const https = require("https");
const fs = require("fs");
const path = require("path");
const tls = require("tls");

const ROOT = path.join(__dirname, "..", "certs", "russian-trusted-root-ca.pem");
const ca = [...tls.rootCertificates, fs.readFileSync(ROOT, "utf8")];
const FEEDS = [
  ["Axios", "https://api.axios.com/feed/"],
  ["CNN", "https://www.cnn.com/rss/cnn_latest.rss"],
  ["РБК", "https://rssexport.rbc.ru/rbcnews/news/30/full.rss"],
  ["BBC", "https://feeds.bbci.co.uk/news/business/rss.xml"],
];
const TOPICS = [
  ["нефть", /нефт|brent|crude|opec|баррел|oil price|\boil\b/i],
  ["газ", /природн\w* газ|спг|\blng\b|natural gas|\bgas price/i],
  ["золото", /золот|gold/i],
  ["серебро", /серебр|silver/i],
  ["медь", /медь|медн|copper/i],
  ["платина", /платин|platinum/i],
  ["палладий", /паллади|palladium/i],
  ["никель", /никел|nickel/i],
  ["алюминий", /алюмин|aluminum|aluminium/i],
];

let cache = { at: 0, rows: [] };

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.get({
      hostname: target.hostname,
      path: target.pathname + target.search,
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/rss+xml, application/xml, text/xml" },
      timeout: 12000,
      ca,
      servername: target.hostname,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        fetchText(new URL(res.headers.location, url).href).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${url} ${res.statusCode}`));
          return;
        }
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

function textOf(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!match) return "";
  return match[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function topicsOf(text) {
  return TOPICS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

async function collect() {
  if (cache.rows.length && Date.now() - cache.at < 30 * 60 * 1000) return cache.rows;
  const rows = [];
  for (const [source, url] of FEEDS) {
    try {
      const xml = await fetchText(url);
      const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
      for (const item of items.slice(0, 25)) {
        const title = textOf(item, "title");
        const link = textOf(item, "link") || textOf(item, "guid");
        const topics = topicsOf(title);
        if (!title || !topics.length) continue;
        rows.push({ source, title: title.slice(0, 180), link, topics, at: new Date().toISOString() });
      }
    } catch (err) {
      rows.push({ source, title: "", link: "", topics: [], error: err.message, at: new Date().toISOString() });
    }
  }
  cache = { at: Date.now(), rows: rows.filter((row) => row.title).slice(0, 40) };
  return cache.rows;
}

function summary(rows) {
  const list = rows || [];
  if (!list.length) return "Связей новостей с ресурсами пока нет.";
  const counts = new Map();
  for (const row of list) for (const topic of row.topics) counts.set(topic, (counts.get(topic) || 0) + 1);
  const names = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ${count}`).join(", ");
  const sample = list.slice(0, 2).map((row) => `${row.source}: ${row.title}`).join(" ");
  return `Новости Axios, CNN, РБК и BBC. Связи: ${names}. ${sample}`;
}

module.exports = { collect, summary };
