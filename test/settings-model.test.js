import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_DESKTOP_SETTINGS,
  PET_SCALE_OPTIONS,
  SETTINGS_SCHEMA_VERSION,
  normalizeDesktopSettings,
  normalizeSettings,
} from "../src/renderer/core/settings-model.js";

test("desktop settings defaults are release-facing Phase 6 defaults", () => {
  assert.deepEqual(PET_SCALE_OPTIONS, [0.75, 1, 1.25, 1.5]);
  assert.deepEqual(DEFAULT_DESKTOP_SETTINGS, {
    petScale: 1,
    alwaysOnTop: true,
    randomBehaviorEnabled: true,
    systemAwarenessEnabled: true,
    launchAtStartup: false,
  });
});

test("settings normalization preserves supported desktop choices", () => {
  const normalized = normalizeSettings({
    schemaVersion: 1,
    window: { x: -120, y: 45 },
    desktop: {
      petScale: 1.25,
      alwaysOnTop: false,
      randomBehaviorEnabled: false,
      systemAwarenessEnabled: true,
      launchAtStartup: true,
    },
  });

  assert.equal(normalized.schemaVersion, SETTINGS_SCHEMA_VERSION);
  assert.deepEqual(normalized.window, { x: -120, y: 45 });
  assert.deepEqual(normalized.desktop, {
    petScale: 1.25,
    alwaysOnTop: false,
    randomBehaviorEnabled: false,
    systemAwarenessEnabled: true,
    launchAtStartup: true,
  });
});

test("unsupported or malformed values fall back per field", () => {
  assert.deepEqual(
    normalizeDesktopSettings({
      petScale: 3,
      alwaysOnTop: "false",
      randomBehaviorEnabled: null,
      systemAwarenessEnabled: false,
      launchAtStartup: true,
    }),
    {
      petScale: 1,
      alwaysOnTop: true,
      randomBehaviorEnabled: true,
      systemAwarenessEnabled: false,
      launchAtStartup: true,
    },
  );
});
