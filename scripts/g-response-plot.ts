#!/usr/bin/env node
/**
 * Draws held-out error against CPU for the pilot response models, from a
 * comparison and a benchmark already measured (scripts/g-response-compare.ts
 * and scripts/g-response-benchmark.ts). Each model is a point at its median
 * cost per step at the chosen rate, with a bar over the 10th–90th percentile
 * of batches, and its balanced held-out error; its fit error is the hollow
 * mark. Nothing is measured here.
 *
 * Usage: node scripts/g-response-plot.ts [--compare=<json>] [--benchmark=<json>] [--hz=60] [--out=docs/g-response-error-vs-cpu.svg]
 * Defaults: the newest compare-*.json and benchmark-*.json in build/g-response.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const arg = (name: string, fallback: string) =>
  process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const newest = (prefix: string): string => {
  const dir = path.join(root, "build/g-response");
  const files = readdirSync(dir).filter(file => file.startsWith(prefix) && file.endsWith(".json")).sort();
  if (!files.length) throw new Error(`No ${prefix}*.json in ${dir}: run the comparison and the benchmark first.`);
  return path.join(dir, files.at(-1)!);
};
const comparePath = path.resolve(root, arg("compare", "") || newest("compare-"));
const benchmarkPath = path.resolve(root, arg("benchmark", "") || newest("benchmark-"));
const hz = Number(arg("hz", "60"));
const out = path.resolve(root, arg("out", "docs/g-response-error-vs-cpu.svg"));

interface Summary { model: string; role: string; balancedZ: number | null }
interface Rate { hz: number; stepNs: { median: number; p10: number; p90: number } }
interface Benchmark { runtime: string; device: string; candidates: { name: string; stateBytes: number; rates: Rate[] }[] }
const compare = JSON.parse(readFileSync(comparePath, "utf8")) as { hz: number; summaries: Summary[] };
const benchmark = JSON.parse(readFileSync(benchmarkPath, "utf8")) as Benchmark;

const MODELS = ["Curve", "Exposure", "Perfusion"] as const;
const points = MODELS.map(model => {
  const rate = benchmark.candidates.find(candidate => candidate.name === model)!.rates.find(each => each.hz === hz)!;
  const error = (role: string) => compare.summaries.find(summary => summary.model === model && summary.role === role)!.balancedZ!;
  return { model, cost: rate.stepNs, holdout: error("holdout"), fit: error("fit") };
});

const W = 560;
const H = 340;
const left = 64;
const right = 24;
const top = 40;
const bottom = 56;
// Room right of the costliest model for its bar.
const xMax = Math.ceil(Math.max(...points.map(point => point.cost.p90)) / 10) * 10 + 10;
const yMax = Math.ceil(Math.max(...points.map(point => Math.max(point.holdout, point.fit > 5 ? 0 : point.fit))) + 0.5);
const x = (ns: number) => left + (ns / xMax) * (W - left - right);
const y = (sd: number) => top + (1 - Math.min(sd, yMax) / yMax) * (H - top - bottom);
const COLOURS: Record<string, string> = { Curve: "#6b7280", Exposure: "#b45309", Perfusion: "#1d4ed8" };

const parts: string[] = [];
parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, sans-serif" font-size="12">`);
parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
parts.push(`<text x="${left}" y="22" font-size="14" font-weight="600" fill="#111827">Held-out error against CPU, ${hz} Hz physics</text>`);
for (let ns = 0; ns <= xMax; ns += 10) {
  parts.push(`<line x1="${x(ns)}" x2="${x(ns)}" y1="${top}" y2="${H - bottom}" stroke="#e5e7eb"/>`);
  parts.push(`<text x="${x(ns)}" y="${H - bottom + 16}" text-anchor="middle" fill="#374151">${ns}</text>`);
}
for (let sd = 0; sd <= yMax; sd += 1) {
  parts.push(`<line x1="${left}" x2="${W - right}" y1="${y(sd)}" y2="${y(sd)}" stroke="#e5e7eb"/>`);
  parts.push(`<text x="${left - 8}" y="${y(sd) + 4}" text-anchor="end" fill="#374151">${sd}</text>`);
}
parts.push(`<text x="${(left + W - right) / 2}" y="${H - 16}" text-anchor="middle" fill="#111827">CPU per accepted step, ns (median; bar: 10th–90th percentile of batches)</text>`);
parts.push(`<text transform="translate(18 ${(top + H - bottom) / 2}) rotate(-90)" text-anchor="middle" fill="#111827">Balanced error, standard deviations</text>`);
for (const point of points) {
  const colour = COLOURS[point.model]!;
  const cx = x(point.cost.median);
  parts.push(`<line x1="${x(point.cost.p10)}" x2="${x(point.cost.p90)}" y1="${y(point.holdout)}" y2="${y(point.holdout)}" stroke="${colour}" stroke-width="2"/>`);
  parts.push(`<circle cx="${cx}" cy="${y(point.holdout)}" r="6" fill="${colour}"/>`);
  if (point.fit <= yMax) parts.push(`<circle cx="${cx}" cy="${y(point.fit)}" r="5" fill="#ffffff" stroke="${colour}" stroke-width="2"/>`);
  else parts.push(`<text x="${cx}" y="${top - 4}" text-anchor="middle" fill="${colour}">fit ${point.fit.toFixed(1)} ↑</text>`);
  const label = `${point.model}: ${point.holdout.toFixed(2)} sd, ${point.cost.median.toFixed(0)} ns`;
  // The two low points sit close: Curve's label goes above right, Exposure's below left and Perfusion's above left.
  const [dx, dy, anchor] = point.model === "Curve" ? [10, -10, "start"] : point.model === "Exposure" ? [-10, 22, "end"] : [0, -14, "end"];
  parts.push(`<text x="${cx + dx}" y="${y(point.holdout) + dy}" text-anchor="${anchor}" fill="${colour}" font-weight="600">${label}</text>`);
}
parts.push(`<circle cx="${W - right - 150}" cy="${top + 12}" r="5" fill="#374151"/><text x="${W - right - 140}" y="${top + 16}" fill="#374151">held out</text>`);
parts.push(`<circle cx="${W - right - 78}" cy="${top + 12}" r="4" fill="#ffffff" stroke="#374151" stroke-width="2"/><text x="${W - right - 68}" y="${top + 16}" fill="#374151">fit</text>`);
parts.push(`<text x="${W - right}" y="${H - 2}" text-anchor="end" font-size="10" fill="#6b7280">${benchmark.runtime}, ${benchmark.device}</text>`);
parts.push("</svg>");
writeFileSync(out, `${parts.join("\n")}\n`);
console.log(`Wrote ${path.relative(root, out)} from ${path.relative(root, comparePath)} and ${path.relative(root, benchmarkPath)}.`);
