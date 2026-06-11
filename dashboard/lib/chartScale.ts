// Split vertical scale shared by the interactive chart and the OG image.
//
// The bottom band uses a real linear scale so the agent and the S&P (small
// moves) stay legible. The top band compresses the "fantasy" lines (Cartera
// Adorni and Bot Costiorto) logarithmically so they can shoot up off the
// charts without flattening everyone else. Adorni grows fastest, so it sits
// on top, asymptotic.

import type { Series } from "./benchmarks";

export interface ChartScale {
  y: (value: number) => number;
  baselineY: number;
  splitY: number | null;
  maxReal: number;
}

export function makeScale(series: Series[], capital: number, plotTop: number, plotH: number): ChartScale {
  const bottom = plotTop + plotH;

  const realVals = series.filter((s) => !s.fantasy).flatMap((s) => s.points.map((p) => p.value));
  realVals.push(capital);
  let minReal = Math.min(...realVals);
  let maxReal = Math.max(...realVals);
  const realSpan = Math.max(maxReal - minReal, capital * 0.01);
  minReal -= realSpan * 0.14;
  maxReal += realSpan * 0.14;

  const fantasyVals = series.filter((s) => s.fantasy).flatMap((s) => s.points.map((p) => p.value));
  const topVal = fantasyVals.length ? Math.max(...fantasyVals, maxReal * 1.02) : maxReal;
  const hasFantasy = topVal > maxReal * 1.05;

  // Fantasy band takes the top 52% of the plot when present.
  const splitY = hasFantasy ? plotTop + plotH * 0.52 : plotTop;

  const yReal = (v: number) => splitY + (1 - (v - minReal) / (maxReal - minReal)) * (bottom - splitY);

  const lnA = Math.log(maxReal);
  const lnB = Math.log(Math.max(topVal, maxReal * 1.0001));
  const yFantasy = (v: number) => {
    const t = Math.min(1, Math.max(0, (Math.log(v) - lnA) / (lnB - lnA)));
    return splitY - t * (splitY - plotTop);
  };

  const y = (v: number) => (v <= maxReal ? yReal(v) : yFantasy(v));
  return { y, baselineY: yReal(capital), splitY: hasFantasy ? splitY : null, maxReal };
}
