import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const rendererEntry = fileURLToPath(
  new URL("../src/renderer/main.js", import.meta.url),
);

test("renderer entry parses as valid JavaScript", () => {
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ["--check", rendererEntry], {
      stdio: "pipe",
    });
  });
});
