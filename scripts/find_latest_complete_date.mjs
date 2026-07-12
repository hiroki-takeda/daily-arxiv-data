import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const required = ["hep-th", "gr-qc", "quant-ph"];
const names = readdirSync(resolve("data/reports"));
const dates = new Map();

for (const name of names) {
  const match = name.match(/^(\d{4}-\d{2}-\d{2})-(hep-th|gr-qc|quant-ph)\.json$/);
  if (!match) continue;
  try {
    const report = JSON.parse(readFileSync(resolve("data/reports", name), "utf8"));
    const root = report.categoryData ?? report.category ?? report;
    if (String(report.schemaVersion ?? root.schemaVersion) !== "1.2") continue;
  } catch {
    continue;
  }
  const [, date, category] = match;
  if (!dates.has(date)) dates.set(date, new Set());
  dates.get(date).add(category);
}

const requested = process.argv[2];
const complete = [...dates.entries()]
  .filter(([date, categories]) => (!requested || date === requested) && required.every((category) => categories.has(category)))
  .map(([date]) => date)
  .sort()
  .at(-1);

if (complete) process.stdout.write(complete);
