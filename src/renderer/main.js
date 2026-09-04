import { AnimationPlayer } from "./core/animation-player.js";
import {
  BehaviorArbiter,
  DECISION_PRIORITY,
} from "./core/behavior-arbiter.js";
import { SystemClock } from "./core/clock.js";
import { PET_STATES } from "./core/normalized-pet.js";
import {
  DEFAULT_SYSTEM_BEHAVIOR_RULES,
  SignalMapper,
  SYSTEM_SIGNAL_KEYS,
} from "./core/signal-mapper.js";
import { loadCodexV1Pet } from "./codex-v1-manifest.js";
import { SpriteRenderer } from "./sprite-renderer.js";

const phase = "phase-4";
const DEFAULT_PET_MANIFEST = "./pets/development/pet.json";
const SYSTEM_METRICS_EVENT = "system-metrics";
const DEBUG_SIGNAL_KEY = "debug-state";
const DEBUG_TRIGGER_LABELS = Object.freeze({
  system_default: "Default",
  system_idle: "User Idle",
  cpu_busy: "CPU",
  gpu_busy: "GPU",
  cpu_gpu_busy: "CPU+GPU",
  memory_pressure: "RAM",
  disk_active: "Disk",
  network_active: "Network",
  disk_network_active: "Disk+Network",
  debug_menu: "Debug",
});

document.documentElement.dataset.screenPartnerPhase = phase;

document.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

const spriteElement = document.querySelector("[data-pet-sprite]");
const emptyStateElement = document.querySelector("[data-empty-state]");
const debugControls = document.querySelector("[data-debug-controls]");
const debugMetricsElement = document.querySelector("[data-debug-metrics]");
const debugCurrentStateElement = document.querySelector("[data-debug-current-state]");
const debugCurrentTriggerElement = document.querySelector("[data-debug-current-trigger]");
const debugStateSelect = document.querySelector("[data-debug-state]");

const renderer = new SpriteRenderer(spriteElement);
const runtimeClock = new SystemClock();
const behaviorArbiter = new BehaviorArbiter({ clock: runtimeClock });
const signalMapper = new SignalMapper({ clock: runtimeClock });
let animationPlayer = null;
let animationFrameRequest = null;
let unlistenSystemMetrics = null;
let latestSystemMetrics = null;
let dragSession = null;
let activeBehavior = null;
let previousGateDiagnostics = null;
let previousArbiterWinner = null;
let diagnosticLoggingEnabled = false;
let diagnosticLogPath = null;
let diagnosticQueue = [];
let diagnosticFlushPromise = null;
let diagnosticFlushTimer = null;

function compactDecision(decision) {
  if (!decision) {
    return null;
  }

  return {
    state: decision.state,
    priority: decision.priority,
    source: decision.source,
    reason: decision.reason,
    requestedAt: decision.requestedAt,
  };
}

function decisionIdentity(decision) {
  if (!decision) {
    return "none";
  }
  return `${decision.state}|${decision.priority}|${decision.source}|${decision.reason}`;
}

function diagnosticLog(type, payload = {}) {
  if (!diagnosticLoggingEnabled) {
    return;
  }

  diagnosticQueue.push(
    JSON.stringify({
      wallTime: new Date().toISOString(),
      runtimeMs: Math.round(runtimeClock.now()),
      type,
      ...payload,
    }),
  );
  scheduleDiagnosticFlush();
}

function scheduleDiagnosticFlush(delayMs = 250) {
  if (!diagnosticLoggingEnabled || diagnosticFlushTimer !== null) {
    return;
  }

  diagnosticFlushTimer = setTimeout(() => {
    diagnosticFlushTimer = null;
    void flushDiagnosticLog();
  }, delayMs);
}

async function flushDiagnosticLog() {
  if (
    !diagnosticLoggingEnabled ||
    diagnosticFlushPromise ||
    diagnosticQueue.length === 0
  ) {
    return;
  }

  const invoke = globalThis.__TAURI__?.core?.invoke;
  if (typeof invoke !== "function") {
    return;
  }

  const lines = diagnosticQueue.splice(0, diagnosticQueue.length);
  diagnosticFlushPromise = invoke("append_diagnostic_log", { lines })
    .catch((error) => {
      diagnosticQueue.unshift(...lines);
      console.warn("[screen-partner] diagnostic log write failed", error);
    })
    .finally(() => {
      diagnosticFlushPromise = null;
      if (diagnosticQueue.length > 0) {
        scheduleDiagnosticFlush(0);
      }
    });

  await diagnosticFlushPromise;
}

async function startDiagnosticLogging() {
  const invoke = globalThis.__TAURI__?.core?.invoke;
  if (typeof invoke !== "function") {
    return;
  }

  try {
    diagnosticLogPath = await invoke("start_diagnostic_log");
    diagnosticLoggingEnabled = true;
    diagnosticLog("session_start", {
      phase,
      logPath: diagnosticLogPath,
      rules: DEFAULT_SYSTEM_BEHAVIOR_RULES,
      currentBehavior: activeBehavior,
      userAgent: navigator.userAgent,
    });
    await flushDiagnosticLog();
    console.info(`[screen-partner] diagnostic log: ${diagnosticLogPath}`);
  } catch (error) {
    console.warn("[screen-partner] diagnostic logging unavailable", error);
  }
}

function showPetError(error) {
  diagnosticLog("pet_error", { message: String(error) });
  renderer.clear();
  spriteElement.hidden = true;
  emptyStateElement.hidden = false;
  console.error("[screen-partner] pet load failed", error);
}

function showPet() {
  emptyStateElement.hidden = true;
  spriteElement.hidden = false;
}

function triggerLabel(source) {
  return DEBUG_TRIGGER_LABELS[source] ?? source ?? "Unknown";
}

function updateCurrentBehavior(state, appliedDecision = null) {
  const now = runtimeClock.now();
  const source = appliedDecision?.source ?? activeBehavior?.source ?? "system_default";
  const reason = appliedDecision?.reason ?? activeBehavior?.reason ?? "initial state";
  const behaviorChanged =
    !activeBehavior || activeBehavior.state !== state || activeBehavior.source !== source;

  if (behaviorChanged && activeBehavior) {
    diagnosticLog("behavior_exit", {
      state: activeBehavior.state,
      source: activeBehavior.source,
      trigger: triggerLabel(activeBehavior.source),
      reason: activeBehavior.reason,
      startedAtWallTime: activeBehavior.startedAtWallTime,
      durationMs: Math.max(0, Math.round(now - activeBehavior.startedAtRuntimeMs)),
      nextState: state,
      nextSource: source,
    });
  }

  if (behaviorChanged) {
    activeBehavior = {
      state,
      source,
      reason,
      startedAtRuntimeMs: now,
      startedAtWallTime: new Date().toISOString(),
    };
    diagnosticLog("behavior_enter", {
      state,
      source,
      trigger: triggerLabel(source),
      reason,
    });
  }

  if (debugCurrentStateElement) {
    debugCurrentStateElement.textContent = state;
  }
  document.documentElement.dataset.petState = state;

  const trigger = triggerLabel(source);
  if (debugCurrentTriggerElement) {
    debugCurrentTriggerElement.textContent = trigger;
  }
  document.documentElement.dataset.petTrigger = trigger;
}

function scheduleAnimationTick() {
  animationFrameRequest = requestAnimationFrame(() => {
    animationPlayer?.tick();
    scheduleAnimationTick();
  });
}

function submitArbiterDecision() {
  if (!animationPlayer) {
    return null;
  }

  const decision = behaviorArbiter.decide();
  if (decision) {
    animationPlayer.requestDecision(decision);
  } else {
    animationPlayer.clearPendingDecision();
  }
  return decision;
}

function logArbiterWinnerChange(decision, context) {
  const currentIdentity = decisionIdentity(decision);
  if (currentIdentity === decisionIdentity(previousArbiterWinner)) {
    return;
  }

  diagnosticLog("arbiter_winner_change", {
    context,
    previous: compactDecision(previousArbiterWinner),
    current: compactDecision(decision),
  });
  previousArbiterWinner = decision;
}

function requestDebugState(state) {
  if (!animationPlayer) {
    return;
  }

  if (state === "auto") {
    behaviorArbiter.clearContinuousSignal(DEBUG_SIGNAL_KEY);
  } else {
    behaviorArbiter.setContinuousSignal(DEBUG_SIGNAL_KEY, {
      state,
      priority: DECISION_PRIORITY.interaction,
      source: "debug_menu",
      reason: "manual_state",
    });
  }

  const winner = submitArbiterDecision();
  logArbiterWinnerChange(winner, "debug_mode_change");
  diagnosticLog("debug_mode_change", {
    mode: state,
    arbiterWinner: compactDecision(winner),
    pendingDecision: compactDecision(animationPlayer.getPendingDecision()),
  });
}

function formatRate(bytesPerSecond) {
  const value = Number(bytesPerSecond);
  if (!Number.isFinite(value) || value < 0) {
    return "--".padStart(7);
  }

  const units = [
    [1024 ** 4, "T"],
    [1024 ** 3, "G"],
    [1024 ** 2, "M"],
    [1024, "K"],
  ];

  for (const [factor, suffix] of units) {
    if (value >= factor) {
      const amount = Math.min(value / factor, 999.9);
      return `${amount.toFixed(1)}${suffix}`.padStart(7);
    }
  }

  return `${Math.min(Math.round(value), 1023)}B`.padStart(7);
}

function formatPercent(value) {
  if (value === null || value === undefined) {
    return "--".padStart(4);
  }

  const number = Number(value);
  const formatted = Number.isFinite(number) ? `${Math.round(number)}%` : "--";
  return formatted.padStart(4);
}

function updateDebugMetrics(metrics) {
  if (!debugMetricsElement || !metrics) {
    return;
  }

  debugMetricsElement.textContent =
    `CPU ${formatPercent(metrics.cpuUsagePercent)}  |  GPU ${formatPercent(metrics.gpuUsagePercent)}  |  RAM ${formatPercent(metrics.memoryUsagePercent)}\n` +
    `D ${formatRate(metrics.diskReadBps)}/${formatRate(metrics.diskWriteBps)}  |  ` +
    `N ${formatRate(metrics.networkRxBps)}/${formatRate(metrics.networkTxBps)}`;
}

function applySystemSignals(snapshot) {
  for (const [name, decision] of Object.entries(snapshot)) {
    const key = SYSTEM_SIGNAL_KEYS[name];
    if (decision) {
      behaviorArbiter.setContinuousSignal(key, decision);
    } else {
      behaviorArbiter.clearContinuousSignal(key);
    }
  }
}

function logGateChanges(diagnostics) {
  if (!diagnostics) {
    return;
  }

  if (diagnostics.resetForSampleGap) {
    diagnosticLog("signal_gates_reset_for_sample_gap", {
      sampleGapMs: diagnostics.sampleGapMs,
    });
  }

  for (const [name, current] of Object.entries(diagnostics.gates)) {
    const previous = previousGateDiagnostics?.[name] ?? null;

    if (!previous) {
      if (current.enterSince !== null) {
        diagnosticLog("gate_enter_timer_started", { gate: name, ...current });
      }
      if (current.active) {
        diagnosticLog("gate_activated", { gate: name, ...current });
      }
      continue;
    }

    if (previous.enterSince === null && current.enterSince !== null) {
      diagnosticLog("gate_enter_timer_started", { gate: name, ...current });
    }
    if (
      previous.enterSince !== null &&
      current.enterSince === null &&
      !current.active &&
      !previous.active
    ) {
      diagnosticLog("gate_enter_timer_reset", {
        gate: name,
        previousElapsedMs: previous.enterElapsedMs,
        ...current,
      });
    }
    if (!previous.active && current.active) {
      diagnosticLog("gate_activated", { gate: name, ...current });
    }
    if (previous.active && !current.active) {
      diagnosticLog("gate_deactivated", {
        gate: name,
        previousExitElapsedMs: previous.exitElapsedMs,
        ...current,
      });
    }
    if (previous.exitSince === null && current.exitSince !== null) {
      diagnosticLog("gate_exit_timer_started", { gate: name, ...current });
    }
    if (
      previous.exitSince !== null &&
      current.exitSince === null &&
      current.active &&
      previous.active
    ) {
      diagnosticLog("gate_exit_timer_reset", {
        gate: name,
        previousElapsedMs: previous.exitElapsedMs,
        ...current,
      });
    }
  }

  previousGateDiagnostics = diagnostics.gates;
}

function handleSystemMetrics(metrics) {
  latestSystemMetrics = metrics;
  document.documentElement.dataset.telemetryReady = "true";
  updateDebugMetrics(metrics);

  try {
    const mappedSignals = signalMapper.update(metrics);
    applySystemSignals(mappedSignals);
    const winner = submitArbiterDecision();
    const diagnostics = signalMapper.getDiagnostics();
    logGateChanges(diagnostics);
    logArbiterWinnerChange(winner, "telemetry_sample");

    const playerSnapshot = animationPlayer?.getSnapshot();
    diagnosticLog("telemetry_sample", {
      telemetryTimestampMs: metrics.timestampMs ?? null,
      sampleGapMs: diagnostics?.sampleGapMs ?? null,
      values: diagnostics?.values ?? null,
      gates: diagnostics?.gates ?? null,
      mappedDecisions: diagnostics?.decisions ?? null,
      arbiterWinner: compactDecision(winner),
      currentState: playerSnapshot?.currentState ?? null,
      activeBehavior,
      pendingDecision: compactDecision(animationPlayer?.getPendingDecision()),
    });
  } catch (error) {
    diagnosticLog("signal_mapping_error", { message: String(error) });
    console.warn("[screen-partner] system signal mapping failed", error);
  }
}

async function subscribeSystemMetrics() {
  const listen = globalThis.__TAURI__?.event?.listen;
  if (typeof listen !== "function") {
    console.warn("[screen-partner] Tauri event listener is unavailable");
    return;
  }

  try {
    unlistenSystemMetrics = await listen(SYSTEM_METRICS_EVENT, (event) => {
      handleSystemMetrics(event.payload);
    });
  } catch (error) {
    diagnosticLog("telemetry_subscription_error", { message: String(error) });
    console.warn("[screen-partner] system metrics subscription failed", error);
  }
}

function dragInvoke(command, payload = {}) {
  const invoke = globalThis.__TAURI__?.core?.invoke;
  if (typeof invoke !== "function") {
    return Promise.reject(new Error("Tauri invoke is unavailable"));
  }
  return invoke(command, payload);
}

async function pumpDragUpdates(session) {
  if (!session.ready || session.pumping) {
    return;
  }

  session.pumping = true;
  try {
    while (session.pendingPoint) {
      const point = session.pendingPoint;
      session.pendingPoint = null;
      await dragInvoke("update_window_drag", {
        screenX: point.screenX,
        screenY: point.screenY,
      });
    }
  } catch (error) {
    console.warn("[screen-partner] window drag update failed", error);
    session.endRequested = true;
  } finally {
    session.pumping = false;
  }

  if (session.endRequested) {
    try {
      await dragInvoke("end_window_drag");
    } catch (error) {
      console.warn("[screen-partner] window drag end failed", error);
    }

    if (dragSession === session) {
      dragSession = null;
    }
    return;
  }

  if (session.pendingPoint) {
    pumpDragUpdates(session);
  }
}

async function beginPetDrag(event) {
  if (event.button !== 0 || dragSession) {
    return;
  }

  event.preventDefault();
  const session = {
    pointerId: event.pointerId,
    ready: false,
    pumping: false,
    pendingPoint: null,
    endRequested: false,
  };
  dragSession = session;

  try {
    spriteElement.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture can be unavailable on some WebView builds; dragging still works while events arrive.
  }

  try {
    await dragInvoke("begin_window_drag", {
      screenX: event.screenX,
      screenY: event.screenY,
    });
    session.ready = true;
    await pumpDragUpdates(session);
  } catch (error) {
    console.warn("[screen-partner] window drag start failed", error);
    session.endRequested = true;
    session.ready = true;
    await pumpDragUpdates(session);
  }
}

function updatePetDrag(event) {
  const session = dragSession;
  if (!session || event.pointerId !== session.pointerId) {
    return;
  }

  event.preventDefault();
  session.pendingPoint = {
    screenX: event.screenX,
    screenY: event.screenY,
  };
  pumpDragUpdates(session);
}

function endPetDrag(event) {
  const session = dragSession;
  if (!session || event.pointerId !== session.pointerId) {
    return;
  }

  event.preventDefault();
  session.pendingPoint = {
    screenX: event.screenX,
    screenY: event.screenY,
  };
  session.endRequested = true;

  try {
    spriteElement.releasePointerCapture(event.pointerId);
  } catch {
    // Capture may already have been released by the WebView.
  }

  pumpDragUpdates(session);
}

function installPetDragging() {
  spriteElement.addEventListener("pointerdown", beginPetDrag);
  spriteElement.addEventListener("pointermove", updatePetDrag);
  spriteElement.addEventListener("pointerup", endPetDrag);
  spriteElement.addEventListener("pointercancel", endPetDrag);
}

async function developmentUiEnabled() {
  try {
    return Boolean(
      await globalThis.__TAURI__?.core?.invoke("development_ui_enabled"),
    );
  } catch (error) {
    console.warn("[screen-partner] development UI check failed", error);
    return false;
  }
}

function handleActionBoundary({
  state,
  nextState,
  appliedDecision,
  actionCycleId,
  completedAt,
}) {
  diagnosticLog("action_boundary", {
    completedState: state,
    nextState,
    actionCycleId,
    completedAtRuntimeMs: completedAt,
    appliedDecision: compactDecision(appliedDecision),
  });

  updateCurrentBehavior(nextState, appliedDecision);
  behaviorArbiter.consumeDecision(appliedDecision);
  const winner = submitArbiterDecision();
  logArbiterWinnerChange(winner, "action_boundary");
}

async function initialize() {
  try {
    const { pet, spritesheetUrl } = await loadCodexV1Pet(DEFAULT_PET_MANIFEST);

    renderer.loadPet(pet, spritesheetUrl);
    animationPlayer = new AnimationPlayer({
      clock: runtimeClock,
      onFrame: (frameEvent) => renderer.renderFrame(frameEvent),
      onActionBoundary: handleActionBoundary,
    });
    animationPlayer.loadPet(pet);
    animationPlayer.start("idle");
    updateCurrentBehavior("idle", {
      source: "system_default",
      reason: "initial state",
    });
    showPet();
    installPetDragging();

    const devUiEnabled = await developmentUiEnabled();
    if (devUiEnabled) {
      debugControls.hidden = false;
      debugStateSelect.addEventListener("change", (event) => {
        requestDebugState(event.currentTarget.value);
      });
      updateDebugMetrics(latestSystemMetrics);
      await startDiagnosticLogging();
    }

    await subscribeSystemMetrics();

    document.addEventListener("visibilitychange", () => {
      diagnosticLog("visibility_change", {
        visibilityState: document.visibilityState,
        currentState: animationPlayer?.getSnapshot().currentState ?? null,
        pendingDecision: compactDecision(animationPlayer?.getPendingDecision()),
      });

      if (document.visibilityState === "hidden") {
        animationPlayer?.suspend();
        void flushDiagnosticLog();
      } else {
        animationPlayer?.resume();
      }
    });

    scheduleAnimationTick();
    diagnosticLog("renderer_ready", {
      petId: pet.id,
      stateCount: PET_STATES.length,
    });
    console.info(
      `[screen-partner] renderer ready: ${phase}; pet=${pet.id}; states=${PET_STATES.length}`,
    );
  } catch (error) {
    showPetError(error);
  }
}

window.addEventListener("beforeunload", () => {
  diagnosticLog("session_end", {
    currentBehavior: activeBehavior,
    currentState: animationPlayer?.getSnapshot().currentState ?? null,
    pendingDecision: compactDecision(animationPlayer?.getPendingDecision()),
  });
  void flushDiagnosticLog();

  if (diagnosticFlushTimer !== null) {
    clearTimeout(diagnosticFlushTimer);
    diagnosticFlushTimer = null;
  }

  if (animationFrameRequest !== null) {
    cancelAnimationFrame(animationFrameRequest);
  }

  if (typeof unlistenSystemMetrics === "function") {
    unlistenSystemMetrics();
  }

  if (dragSession) {
    dragSession.endRequested = true;
    pumpDragUpdates(dragSession);
  }
});

initialize();
