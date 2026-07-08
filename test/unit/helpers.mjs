// Shared test helpers for test/unit/*.test.mjs. No framework — plain node.
// The failures counter is a module singleton: every test file's check/
// checkAsync increments it, and the runner (test/unit.mjs) reads it via
// failures() to decide the exit code.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

let failureCount = 0;

export function failures() {
  return failureCount;
}

export function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failureCount++;
    console.error(`FAIL - ${name}`);
    console.error(e instanceof Error ? e.stack : e);
  }
}

export async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failureCount++;
    console.error(`FAIL - ${name}`);
    console.error(e instanceof Error ? e.stack : e);
  }
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? "assertion failed");
}

export function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(
      `${msg ?? "not equal"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
