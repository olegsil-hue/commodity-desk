function corr(xs, ys) {
  const n = xs.length;
  if (n < 12) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

function beta(xs, ys) {
  const n = xs.length;
  if (n < 12) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    num += a * (ys[i] - my);
    den += a * a;
  }
  if (den === 0) return null;
  return num / den;
}

function align(brent, other, days) {
  const map = new Map(other.map((p) => [p.date, p.ret]));
  const pairs = [];
  for (const b of brent) {
    if (map.has(b.date)) pairs.push([b.ret, map.get(b.date)]);
  }
  const slice = pairs.slice(-days);
  return {
    x: slice.map((p) => p[0]),
    y: slice.map((p) => p[1]),
    n: slice.length,
  };
}

function pctChange(bars, days) {
  if (!bars || bars.length <= days) return null;
  return bars[bars.length - 1].close / bars[bars.length - 1 - days].close - 1;
}

function actionForShortBrent(beta20, beta60, c20) {
  if (beta20 == null) return { code: "skip", text: "Мало данных" };
  const signFlip =
    beta60 != null &&
    Math.sign(beta20) !== Math.sign(beta60) &&
    Math.abs(beta20) > 0.08 &&
    Math.abs(beta60) > 0.08;
  if (signFlip) {
    return { code: "unstable", text: "20д и 60д в разные стороны. Хедж не ставить." };
  }
  if (beta20 <= -0.2 && c20 != null && c20 <= -0.2 && (beta60 == null || beta60 <= 0)) {
    return { code: "cover", text: "Закрыть шорт, если он есть. При падении Brent бумага растёт." };
  }
  if (beta20 <= -0.08 && c20 != null && c20 <= -0.15) {
    return { code: "watch-up", text: "Слабый рост при падении нефти. В шорт не добавлять." };
  }
  if (beta20 >= 0.35 && beta60 != null && beta60 >= 0.2 && c20 != null && c20 >= 0.3) {
    return { code: "insurance", text: "Падает с нефтью. Малый лонг страхует отскок Brent и режет прибыль шорта." };
  }
  if (beta20 >= 0.15 && c20 != null && c20 >= 0.2) {
    return { code: "same-way", text: "Вместе с нефтью. Шорт удваивает шорт Brent." };
  }
  return { code: "flat", text: "Связь слабая." };
}

function buildBook({ brent, series, shock = -0.015 }) {
  const rows = [];
  for (const spec of Object.values(series)) {
    const rets = [];
    for (let i = 1; i < spec.bars.length; i++) {
      rets.push({ date: spec.bars[i].date, ret: spec.bars[i].close / spec.bars[i - 1].close - 1 });
    }
    const a20 = align(brent, rets, 20);
    const a60 = align(brent, rets, 60);
    const a120 = align(brent, rets, 120);
    const b20 = beta(a20.x, a20.y);
    const b60 = beta(a60.x, a60.y);
    const act = actionForShortBrent(b20, b60, corr(a20.x, a20.y));
    rows.push({
      id: spec.id,
      name: spec.name,
      group: spec.group,
      last: spec.bars[spec.bars.length - 1].close,
      date: spec.bars[spec.bars.length - 1].date,
      d5: pctChange(spec.bars, 5),
      c20: corr(a20.x, a20.y),
      c60: corr(a60.x, a60.y),
      c120: corr(a120.x, a120.y),
      beta20: b20,
      beta60: b60,
      n20: a20.n,
      n60: a60.n,
      expected: b20 == null ? null : b20 * shock,
      expected60: b60 == null ? null : b60 * shock,
      action: act.text,
      code: act.code,
    });
  }
  rows.sort((a, b) => (b.expected ?? -99) - (a.expected ?? -99));
  const last = brent[brent.length - 1];
  const d5 =
    brent.length >= 5 ? brent.slice(-5).reduce((s, p) => s * (1 + p.ret), 1) - 1 : null;
  return {
    shock,
    brent: {
      last: last.close,
      date: last.date,
      contract: last.contract,
      d5,
      points: brent.length,
    },
    rows,
  };
}

module.exports = { buildBook, actionForShortBrent };
