const DEFAULT_TICKERS = {
  "BZ=F": "Brent",
  "CL=F": "WTI",
  "NG=F": "NatGas",
  "GC=F": "Gold",
  "SI=F": "Silver",
  "HG=F": "Copper",
  "PL=F": "Platinum",
  "DX-Y.NYB": "DXY",
  "ES=F": "ES",
};

async function fetchTicker(ticker, range = "2y") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=${range}`;
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 commodity-radar" },
      });
      if (!res.ok) throw new Error(`${ticker} HTTP ${res.status}`);
      const data = await res.json();
      const result = data.chart.result[0];
      const ts = result.timestamp;
      const closes = result.indicators.quote[0].close;
      const out = [];
      for (let i = 0; i < ts.length; i++) {
        if (closes[i] != null) out.push({ t: ts[i], p: closes[i] });
      }
      return out;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function fetchAll(tickers = DEFAULT_TICKERS) {
  const series = {};
  for (const [symbol, name] of Object.entries(tickers)) {
    series[name] = { symbol, bars: await fetchTicker(symbol) };
  }
  return series;
}

module.exports = { DEFAULT_TICKERS, fetchTicker, fetchAll };
