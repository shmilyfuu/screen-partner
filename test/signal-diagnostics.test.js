import assert from "node:assert/strict";
import test from "node:test";

import { FakeClock } from "../src/renderer/core/clock.js";
import { SignalMapper } from "../src/renderer/core/signal-mapper.js";

function metrics(overrides = {}) {
  return {
    timestampMs: 0,
    cpuUsagePercent: 10,
    gpuUsagePercent: null,
    memoryUsagePercent: 50,
    diskReadBps: 0,
    diskWriteBps: 0,
    networkRxBps: 0,
    networkTxBps: 0,
    userIdleSeconds: null,
    ...overrides,
  };
}

test("diagnostics expose aggregate disk throughput and exit dwell progress", () => {
  const clock = new FakeClock();
  const mapper = new SignalMapper({ clock });

  mapper.update(metrics({ diskReadBps: 2_100_000, diskWriteBps: 2_000_000 }));
  for (let second = 0; second < 3; second += 1) {
    clock.advance(1_000);
    mapper.update(metrics({ diskReadBps: 2_100_000, diskWriteBps: 2_000_000 }));
  }

  let diagnostics = mapper.getDiagnostics();
  assert.equal(diagnostics.values.diskTotalBps, 4_100_000);
  assert.equal(diagnostics.gates.disk.active, true);
  assert.equal(diagnostics.gates.disk.exitCondition, false);

  clock.advance(1_000);
  mapper.update(metrics({ diskReadBps: 1_400_000, diskWriteBps: 1_400_000 }));
  diagnostics = mapper.getDiagnostics();
  assert.equal(diagnostics.values.diskTotalBps, 2_800_000);
  assert.equal(diagnostics.gates.disk.exitCondition, true);
  assert.equal(diagnostics.gates.disk.exitElapsedMs, 0);

  clock.advance(1_000);
  mapper.update(metrics({ diskReadBps: 1_400_000, diskWriteBps: 1_400_000 }));
  diagnostics = mapper.getDiagnostics();
  assert.equal(diagnostics.gates.disk.active, true);
  assert.equal(diagnostics.gates.disk.exitElapsedMs, 1_000);
});

test("diagnostics report when a long telemetry gap resets dwell gates", () => {
  const clock = new FakeClock();
  const mapper = new SignalMapper({ clock });

  mapper.update(metrics({ cpuUsagePercent: 80 }));
  clock.advance(3_000);
  mapper.update(metrics({ cpuUsagePercent: 80 }));

  const diagnostics = mapper.getDiagnostics();
  assert.equal(diagnostics.sampleGapMs, 3_000);
  assert.equal(diagnostics.resetForSampleGap, true);
  assert.equal(diagnostics.gates.cpu.active, false);
  assert.equal(diagnostics.gates.cpu.enterElapsedMs, 0);
}
);
