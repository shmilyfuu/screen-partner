import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const entries = ["main.js", "settings.js"].map((fileName) =>
  fileURLToPath(new URL(`../src/renderer/${fileName}`, import.meta.url)),
);

for (const entry of entries) {
  test(`${entry} parses as valid JavaScript`, () => {
    assert.doesNotThrow(() => {
      execFileSync(process.execPath, ["--check", entry], {
        stdio: "pipe",
      });
    });
  });
}
