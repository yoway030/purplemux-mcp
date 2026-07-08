// Unit test runner. The actual tests live in test/unit/*.test.mjs, one file
// per target module; shared check/assert helpers (and the singleton failures
// counter) live in test/unit/helpers.mjs.
//
// Files are imported SEQUENTIALLY with dynamic await import() — NOT static
// imports: static imports would interleave the files' top-level awaits, which
// breaks boot.test.mjs's process.env.HOME redirect isolation. Each import is
// wrapped in try/catch so one crashing file counts as a failure but never
// stops the remaining files from running.
import { failures } from "./unit/helpers.mjs";

const testFiles = [
  "./unit/profiles.test.mjs",
  "./unit/pane.test.mjs",
  "./unit/paths.test.mjs",
  "./unit/agents.test.mjs",
  "./unit/boot.test.mjs",
  "./unit/guide.test.mjs",
];

let importFailures = 0;
for (const file of testFiles) {
  try {
    await import(file);
  } catch (e) {
    importFailures++;
    console.error(`FAIL - ${file} threw during import`);
    console.error(e instanceof Error ? e.stack : e);
  }
}

const totalFailures = failures() + importFailures;
if (totalFailures > 0) {
  console.error(`\n${totalFailures} test(s) failed`);
  process.exit(1);
} else {
  console.log("\nall unit tests passed");
}
