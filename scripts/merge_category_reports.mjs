import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeEditionTransactionally, PRODUCTION_SCHEMA, validateDate } from "./lib/pipeline.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
if (args.length !== 1) {
  console.error("Usage: node scripts/merge_category_reports.mjs YYYY-MM-DD");
  process.exitCode = 2;
} else {
  try {
    const date = validateDate(args[0]);
    const result = mergeEditionTransactionally({ root, date });
    console.log(result.changed
      ? `Merged schema ${PRODUCTION_SCHEMA} edition ${date} transactionally.`
      : `No changes: schema ${PRODUCTION_SCHEMA} edition ${date} is already current.`);
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  }
}
