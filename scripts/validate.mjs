import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRepository } from "./lib/pipeline.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

try {
  const { publicArchive } = validateRepository(root);
  console.log(`Validation passed: ${publicArchive.dates.length} public edition(s), latest ${publicArchive.dates[0]}.`);
} catch (error) {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
}
