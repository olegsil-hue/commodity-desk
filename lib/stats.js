function logReturns(prices) {
  const r = [];
  for (let i = 1; i < prices.length; i++) {
    r.push(Math.log(prices[i] / prices[i - 1]));
  }
  return r;
}

function pctChange(bars, days) {
  if (bars.length <= days) return null;
  return bars[bars.length - 1].p / bars[bars.length - 1 - days].p - 1;
}

function corr(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 8) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= n;
  my /= n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx;
    const b = y[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

function alignCloses(a, b) {
  const mb = new Map(b.bars.map((x) => [x.t, x.p]));
  const pa = [];
  const pb = [];
  for (const bar of a.bars) {
    if (mb.has(bar.t)) {
      pa.push(bar.p);
      pb.push(mb.get(bar.t));
    }
  }
  return [pa, pb];
}

function windowCorr(a, b, days) {
  const [pa, pb] = alignCloses(a, b);
  const ra = logReturns(pa);
  const rb = logReturns(pb);
  if (ra.length < 8) return null;
  if (ra.length <= days) return corr(ra, rb);
  return corr(ra.slice(-days), rb.slice(-days));
}

function lastDate(bars) {
  return new Date(bars[bars.length - 1].t * 1000).toISOString().slice(0, 10);
}

function classifyRegime({ brent5, gold5, es5, dxy5 }) {
  const oilDown = brent5 < -0.02;
  const oilUp = brent5 > 0.02;
  const goldUp = gold5 > 0.005;
  const goldDown = gold5 < -0.005;
  const riskOff = es5 < -0.01;
  const dollarUp = dxy5 > 0.004;

  if (oilDown && goldUp && (riskOff || !dollarUp)) {
    return {
      id: "risk_off_rotation",
      title: "Risk-off: нефть падает, золото покупают как убежище",
    };
  }
  if (oilUp && goldUp && !dollarUp) {
    return {
      id: "inflation_shock",
      title: "Инфляционный шок: нефть и металлы растут вместе",
    };
  }
  if (dollarUp && goldDown && oilDown) {
    return {
      id: "dollar_squeeze",
      title: "Сильный доллар давит на всё сырьё сразу",
    };
  }
  if (oilDown && goldDown) {
    return {
      id: "demand_scare",
      title: "Спрос слабеет: нефть и золото снижаются вместе",
    };
  }
  return {
    id: "mixed",
    title: "Смешанный режим: жёсткой inverse-связки нет",
  };
}

function buildSnapshot(series) {
  const names = Object.keys(series);
  const returns = {};
  for (const name of names) {
    const bars = series[name].bars;
    returns[name] = {
      last: bars[bars.length - 1].p,
      date: lastDate(bars),
      d1: pctChange(bars, 1),
      d5: pctChange(bars, 5),
      d21: pctChange(bars, 21),
      d63: pctChange(bars, 63),
      d252: pctChange(bars, 252),
    };
  }

  const windows = [20, 60, 252];
  const pairs = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i];
      const b = names[j];
      const row = { a, b };
      for (const w of windows) row[`c${w}`] = windowCorr(series[a], series[b], w);
      pairs.push(row);
    }
  }

  const [gold, brent] = alignCloses(series.Gold, series.Brent);
  const ratioNow = gold[gold.length - 1] / brent[brent.length - 1];
  const ratios = gold.map((g, i) => g / brent[i]);
  const mean = ratios.reduce((s, x) => s + x, 0) / ratios.length;
  const sd = Math.sqrt(ratios.reduce((s, x) => s + (x - mean) ** 2, 0) / ratios.length);
  const [silver] = alignCloses(series.Silver, series.Gold);
  const goldPx = alignCloses(series.Gold, series.Silver)[0];
  const silverPx = alignCloses(series.Gold, series.Silver)[1];
  const goldSilver = goldPx[goldPx.length - 1] / silverPx[silverPx.length - 1];

  const regime = classifyRegime({
    brent5: returns.Brent.d5,
    gold5: returns.Gold.d5,
    es5: returns.ES.d5,
    dxy5: returns.DXY.d5,
  });

  const signals = buildSignals(returns, pairs, { ratioNow, mean, goldSilver }, regime);
  return { returns, pairs, regime, signals, goldBrent: { ratioNow, mean, z: (ratioNow - mean) / sd }, goldSilver };
}

function buildSignals(returns, pairs, ratios, regime) {
  const brentGold = pairs.find((p) => p.a === "Brent" && p.b === "Gold");
  const goldSilverPair = pairs.find((p) => p.a === "Gold" && p.b === "Silver");
  const signals = [];

  if (brentGold && brentGold.c20 < -0.15 && returns.Brent.d5 < -0.03 && returns.Gold.d5 > -0.005) {
    signals.push({
      id: "oil_down_gold_bid",
      action: "Покупать золото / не усреднять лонг по нефти",
      why: `20д корреляция Brent–золото ${brentGold.c20.toFixed(2)}, нефть за 5д ${(returns.Brent.d5 * 100).toFixed(1)}%. Это рабочая inverse-нога, не «вечный закон».`,
      instruments: ["GC=F / GLD / золото COMEX", "короткий хедж BZ=F только при подтверждённом risk-off"],
      risk: "Если нефть падает из-за сильного доллара, золото тоже может просесть.",
    });
  }

  if (regime.id === "inflation_shock") {
    signals.push({
      id: "both_up",
      action: "Не шортить золото против нефти: оба актива в одном тренде",
      why: "При шоке предложения / инфляции inverse ломается. Лучше лонг металлов и дистиллятов, чем ставка на расхождение.",
      instruments: ["HG=F медь", "SI=F серебро", "HO=F heating oil vs CL=F"],
      risk: "Резкое укрепление доллара разворачивает всю корзину.",
    });
  }

  if (returns.NatGas.d5 > 0.05 && Math.abs(returns.Brent.d5) > 0.03) {
    signals.push({
      id: "gas_decouple",
      action: "Торговать газ отдельно от нефти",
      why: `Газ за 5д ${(returns.NatGas.d5 * 100).toFixed(1)}%, нефть ${(returns.Brent.d5 * 100).toFixed(1)}%. Корреляция слабая — это погодный/складской рынок, не нефтяной спред.`,
      instruments: ["NG=F", "сезонный лонг в преддверии зимы только со стопом по storage"],
      risk: "NG очень волатилен; размер позиции в 3–5 раз меньше нефтяной.",
    });
  }

  if (returns.Silver.d5 - returns.Gold.d5 > 0.03) {
    signals.push({
      id: "silver_lead",
      action: "Серебро сильнее золота: промышленный спрос + драгметалл",
      why: `Серебро 5д ${(returns.Silver.d5 * 100).toFixed(1)}% vs золото ${(returns.Gold.d5 * 100).toFixed(1)}%. Если риск-он и медь тоже растёт, серебро — более агрессивная нога.`,
      instruments: ["SI=F / SLV", "не шортить серебро против золота, пока медь в плюсе"],
      risk: "Серебро падает быстрее золота при risk-off.",
    });
  }

  if (returns.WTI.d1 < -0.04 && returns.Brent.d1 > -0.02) {
    signals.push({
      id: "wti_brent_gap",
      action: "Спред WTI–Brent разошёлся: ждать сужения, не ловить одну ногу вслепую",
      why: `WTI день ${(returns.WTI.d1 * 100).toFixed(1)}%, Brent ${(returns.Brent.d1 * 100).toFixed(1)}%. Обычно спред схлопывается; торговать пару, не направление нефти.`,
      instruments: ["длинный WTI / короткий Brent при экстремальном дисконте WTI"],
      risk: "Структурный дисконт WTI может держаться неделями (логистика, Cushing).",
    });
  }

  if (signals.length === 0) {
    signals.push({
      id: "standby",
      action: "Сигнала на агрессивную inverse-сделку нет",
      why: "Корреляции и 5-дневные импульсы не совпали с рабочим режимом.",
      instruments: [],
      risk: "Не торговать гипотезу «нефть вниз = золото вверх» как постоянное правило.",
    });
  }

  void goldSilverPair;
  void ratios;
  return signals;
}

function monthlyNormalized(series, months = 13) {
  const names = Object.keys(series);
  const monthKey = (t) => new Date(t * 1000).toISOString().slice(0, 7);
  const keys = [];
  const seen = new Set();
  for (const bar of series.Brent.bars) {
    const k = monthKey(bar.t);
    if (!seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  }
  const monthLast = keys.slice(-months);
  const out = { months: monthLast, series: {} };
  for (const name of names) {
    const map = new Map();
    for (const bar of series[name].bars) map.set(monthKey(bar.t), bar.p);
    const vals = monthLast.map((m) => map.get(m));
    const first = vals.find((x) => x != null);
    out.series[name] = vals.map((x) => (x == null || !first ? null : (100 * x) / first));
  }
  return out;
}

function eventStudy(series) {
  const dates = commonDates(series, ["Brent", "Gold", "ES", "DXY"]);
  const br = dates.map((d) => series.Brent.byDate.get(d));
  const go = dates.map((d) => series.Gold.byDate.get(d));
  const es = dates.map((d) => series.ES.byDate.get(d));
  const dx = dates.map((d) => series.DXY.byDate.get(d));
  const rB = [],
    rG = [],
    rE = [],
    rX = [];
  for (let i = 1; i < br.length; i++) {
    rB.push(br[i] / br[i - 1] - 1);
    rG.push(go[i] / go[i - 1] - 1);
    rE.push(es[i] / es[i - 1] - 1);
    rX.push(dx[i] / dx[i - 1] - 1);
  }
  const past5 = (arr, i) => arr.slice(i - 4, i + 1).reduce((s, x) => s + x, 0);
  const fwd5 = (arr, i) => (i + 5 >= arr.length ? null : arr.slice(i + 1, i + 6).reduce((s, x) => s + x, 0));
  function bucket(label, pred) {
    let n = 0;
    let hits = 0;
    let gSum = 0;
    let oSum = 0;
    for (let i = 20; i < rB.length - 5; i++) {
      if (!pred(i)) continue;
      const g = fwd5(rG, i);
      const o = fwd5(rB, i);
      if (g == null) continue;
      n++;
      gSum += g;
      oSum += o;
      if (g > 0) hits++;
    }
    return {
      label,
      n,
      goldHit: n ? hits / n : null,
      avgGold5: n ? gSum / n : null,
      avgOil5: n ? oSum / n : null,
    };
  }
  return [
    bucket("Нефть −3% за 5д → золото след. 5д", (i) => past5(rB, i) < -0.03),
    bucket("Нефть −5% за 5д → золото след. 5д", (i) => past5(rB, i) < -0.05),
    bucket("Нефть +3% за 5д → золото след. 5д", (i) => past5(rB, i) > 0.03),
    bucket("Нефть −3% и акции вниз", (i) => past5(rB, i) < -0.03 && past5(rE, i) < 0),
    bucket("Нефть −3% и доллар вверх", (i) => past5(rB, i) < -0.03 && past5(rX, i) > 0),
    bucket("Нефть −3% и доллар вниз", (i) => past5(rB, i) < -0.03 && past5(rX, i) < 0),
  ];
}

function attachDateMaps(series) {
  for (const name of Object.keys(series)) {
    series[name].byDate = new Map(
      series[name].bars.map((b) => [new Date(b.t * 1000).toISOString().slice(0, 10), b.p]),
    );
  }
  return series;
}

function commonDates(series, names) {
  let dates = [...series[names[0]].byDate.keys()];
  for (const n of names.slice(1)) {
    dates = dates.filter((d) => series[n].byDate.has(d));
  }
  return dates.sort();
}

function pairBacktest(series) {
  const dates = commonDates(series, ["Brent", "Gold"]);
  const br = dates.map((d) => series.Brent.byDate.get(d));
  const go = dates.map((d) => series.Gold.byDate.get(d));
  const rB = [];
  const rG = [];
  for (let i = 1; i < br.length; i++) {
    rB.push(br[i] / br[i - 1] - 1);
    rG.push(go[i] / go[i - 1] - 1);
  }
  const past5 = (arr, i) => arr.slice(i - 4, i + 1).reduce((s, x) => s + x, 0);
  let eq = 1;
  let gold = 1;
  let oil = 1;
  let daysIn = 0;
  for (let i = 21; i < rB.length; i++) {
    const c = corr(rB.slice(i - 20, i), rG.slice(i - 20, i));
    const oil5 = past5(rB, i - 1);
    let ret = 0;
    if (c != null && c < -0.15 && oil5 < -0.02) {
      ret = rG[i] - rB[i];
      daysIn++;
    } else if (c != null && c < -0.15 && oil5 > 0.02) {
      ret = rB[i] - rG[i];
      daysIn++;
    }
    eq *= 1 + ret;
    gold *= 1 + rG[i];
    oil *= 1 + rB[i];
  }
  return {
    strategy: eq - 1,
    buyHoldGold: gold - 1,
    buyHoldBrent: oil - 1,
    daysIn,
    days: rB.length - 21,
  };
}

module.exports = {
  buildSnapshot,
  monthlyNormalized,
  eventStudy,
  pairBacktest,
  attachDateMaps,
  windowCorr,
};
