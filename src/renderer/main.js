import { AnimationPlayer } from "./core/animation-player.js";
import {
  BehaviorArbiter,
  DECISION_PRIORITY,
} from "./core/behavior-arbiter.js";
import { SystemClock } from "./core/clock.js";
import { PET_STATES } from "./core/normalized-pet.js";
import {
  DEFAULT_RANDOM_BEHAVIOR_RULES,
  RandomBehavior,
  RANDOM_SIGNAL_KEY,
} from "./core/random-behavior.js";
import {
  DEFAULT_SYSTEM_BEHAVIOR_RULES,
  SignalMapper,
  SYSTEM_SIGNAL_KEYS,
} from "./core/signal-mapper.js";
import { normalizeSettings } from "./core/settings-model.js";
import { loadCodexV1Pet } from "./codex-v1-manifest.js";
import { SpriteRenderer } from "./sprite-renderer.js";

const phase = "phase-6";
const DEFAULT_PET_MANIFEST = "./pets/development/pet.json";
const SYSTEM_METRICS_EVENT = "system-metrics";
const SETTINGS_CHANGED_EVENT = "settings-changed";
const DEBUG_SIGNAL_KEY = "debug-state";
const DRAG_SIGNAL_KEY = "dragging";
const DRAG_THRESHOLD_PX = 4;
const DOUBLE_CLICK_WINDOW_MS = 300;
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
  random_behavior: "Random",
  dragging: "Drag",
  single_click: "Click",
  double_click: "Double Click",
  debug_menu: "Debug",
});

document.documentElement.dataset.screenPartnerPhase = phase;

document.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  void openSettingsWindow();
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
let signalMapper = new SignalMapper({ clock: runtimeClock });
const randomBehavior = new RandomBehavior({ clock: runtimeClock });
let appSettings = normalizeSettings(null);
let animationPlayer = null;
let animationFrameRequest = null;
let unlistenSystemMetrics = null;
let unlistenSettings = null;
let latestSystemMetrics = null;
let dragSession = null;
let pendingSingleClickTimer = null;
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
      randomRules: DEFAULT_RANDOM_BEHAVIOR_RULES,
      settings: appSettings,
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
  const priority =
    appliedDecision?.priority ?? activeBehavior?.priority ?? DECISION_PRIORITY.idle;
  const behaviorChanged =
    !activeBehavior || activeBehavior.state !== state || activeBehavior.source !== source;

  if (behaviorChanged && activeBehavior) {
    diagnosticLog("behavior_exit", {
      state: activeBehavior.state,
      priority: activeBehavior.priority,
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
      priority,
      source,
      reason,
      startedAtRuntimeMs: now,
      startedAtWallTime: new Date().toISOString(),
    };
    diagnosticLog("behavior_enter", {
      state,
      priority,
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

function submitArbiterDecision() {
  if (!animationPlayer) {
    return null;
  }

  if (dragSession?.isDragging && dragSession.dragDecision) {
    animationPlayer.requestDecision(dragSession.dragDecision);
    return dragSession.dragDecision;
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

function currentRandomBlocker() {
  if (dragSession) {
    return {
      priority: DECISION_PRIORITY.interaction,
      source: "dragging",
      reason: "pet pointer interaction",
    };
  }

  if (pendingSingleClickTimer !== null) {
    return {
      priority: DECISION_PRIORITY.interaction,
      source: "single_click",
      reason: "waiting for double-click window",
    };
  }

  const arbiterWinner = behaviorArbiter.decide();
  if (arbiterWinner?.priority < DECISION_PRIORITY.random) {
    return arbiterWinner;
  }

  if (activeBehavior?.priority < DECISION_PRIORITY.random) {
    return activeBehavior;
  }

  return null;
}

function rescheduleRandomBehavior() {
  if (!appSettings.desktop.randomBehaviorEnabled) {
    randomBehavior.reset();
    return null;
  }
  return randomBehavior.reschedule();
}

function suppressPendingRandom(context) {
  const blocker = currentRandomBlocker();
  if (!blocker) {
    return false;
  }

  const cleared = behaviorArbiter.clearLatchedSignal(RANDOM_SIGNAL_KEY);
  if (!cleared) {
    return false;
  }

  const nextDueAt = rescheduleRandomBehavior();
  const winner = submitArbiterDecision();
  logArbiterWinnerChange(winner, `${context}_random_suppressed`);
  diagnosticLog("random_behavior_suppressed", {
    context,
    blocker: compactDecision(blocker),
    nextDueAt,
    arbiterWinner: compactDecision(winner),
    pendingDecision: compactDecision(animationPlayer?.getPendingDecision()),
  });
  return true;
}

function pollRandomBehavior() {
  if (!animationPlayer || !appSettings.desktop.randomBehaviorEnabled) {
    return;
  }

  const blocker = currentRandomBlocker();
  const event = randomBehavior.poll({ blocked: Boolean(blocker) });
  if (!event) {
    return;
  }

  if (event.type === "decision") {
    const decision = behaviorArbiter.latchSignal(
      RANDOM_SIGNAL_KEY,
      event.decision,
      event.latchTtlMs,
    );
    const winner = submitArbiterDecision();
    logArbiterWinnerChange(winner, "random_behavior");
    diagnosticLog("random_behavior_requested", {
      scheduledFor: event.scheduledFor,
      nextDueAt: event.nextDueAt,
      decision: compactDecision(decision),
      arbiterWinner: compactDecision(winner),
      pendingDecision: compactDecision(animationPlayer.getPendingDecision()),
    });
    return;
  }

  diagnosticLog(`random_behavior_${event.type}`, {
    scheduledFor: event.scheduledFor,
    nextDueAt: event.nextDueAt,
    blocker: compactDecision(blocker),
  });
}

function scheduleAnimationTick() {
  animationFrameRequest = requestAnimationFrame(() => {
    pollRandomBehavior();
    animationPlayer?.tick();
    scheduleAnimationTick();
  });
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
    suppressPendingRandom("debug_mode_change");
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

function makeDefaultDecision(reason) {
  return {
    state: "idle",
    priority: DECISION_PRIORITY.idle,
    source: "system_default",
    reason,
    requestedAt: runtimeClock.now(),
  };
}

function resetSystemSignals(reason) {
  for (const key of Object.values(SYSTEM_SIGNAL_KEYS)) {
    behaviorArbiter.clearContinuousSignal(key);
  }
  behaviorArbiter.setContinuousSignal(
    SYSTEM_SIGNAL_KEYS.fallback,
    makeDefaultDecision(reason),
  );
  signalMapper = new SignalMapper({ clock: runtimeClock });
  previousGateDiagnostics = null;
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

  if (!appSettings.desktop.systemAwarenessEnabled) {
    diagnosticLog("telemetry_sample", {
      telemetryTimestampMs: metrics.timestampMs ?? null,
      systemAwarenessEnabled: false,
      currentState: animationPlayer?.getSnapshot().currentState ?? null,
      activeBehavior,
    });
    return;
  }

  try {
    const mappedSignals = signalMapper.update(metrics);
    applySystemSignals(mappedSignals);
    suppressPendingRandom("telemetry_sample");
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
      randomBehavior: randomBehavior.getDiagnostics(),
      systemAwarenessEnabled: true,
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

function clearPendingClickTimer() {
  if (pendingSingleClickTimer === null) {
    return;
  }

  clearTimeout(pendingSingleClickTimer);
  pendingSingleClickTimer = null;
}

function makeInteractionDecision(state, source, reason) {
  return {
    state,
    priority: DECISION_PRIORITY.interaction,
    source,
    reason,
    requestedAt: runtimeClock.now(),
  };
}

function applyImmediateBehavior(decision, context) {
  if (!animationPlayer) {
    return null;
  }

  const before = animationPlayer.getSnapshot();
  const after = animationPlayer.interruptState(decision.state);
  updateCurrentBehavior(decision.state, decision);
  diagnosticLog("immediate_behavior_change", {
    context,
    interruptedState: before.currentState,
    interruptedFrameIndex: before.currentFrameIndex,
    interruptedActionCycleId: before.actionCycleId,
    decision: compactDecision(decision),
    nextActionCycleId: after.actionCycleId,
  });
  return after;
}

function requestPointerInteraction(state, source, reason) {
  if (!animationPlayer) {
    return null;
  }

  const decision = makeInteractionDecision(state, source, reason);
  const randomCleared = behaviorArbiter.clearLatchedSignal(RANDOM_SIGNAL_KEY);
  const nextRandomDueAt = rescheduleRandomBehavior();
  applyImmediateBehavior(decision, source);

  const restoreDecision = behaviorArbiter.decide() ?? makeDefaultDecision(`${source} completed`);
  animationPlayer.requestDecision(restoreDecision);
  logArbiterWinnerChange(restoreDecision, `${source}_restore_target`);
  diagnosticLog("pointer_interaction_started", {
    interaction: source,
    decision: compactDecision(decision),
    restoreDecision: compactDecision(restoreDecision),
    randomCleared,
    nextRandomDueAt,
  });
  return decision;
}

function queuePetClick() {
  if (pendingSingleClickTimer !== null) {
    clearPendingClickTimer();
    requestPointerInteraction(
      "jumping",
      "double_click",
      "pet double clicked",
    );
    return;
  }

  pendingSingleClickTimer = setTimeout(() => {
    pendingSingleClickTimer = null;
    requestPointerInteraction(
      "waving",
      "single_click",
      "pet clicked",
    );
  }, DOUBLE_CLICK_WINDOW_MS);
}

function dragInvoke(command, payload = {}) {
  const invoke = globalThis.__TAURI__?.core?.invoke;
  if (typeof invoke !== "function") {
    return Promise.reject(new Error("Tauri invoke is unavailable"));
  }
  return invoke(command, payload);
}

function setDragAnimation(session, state, context) {
  if (!session.isDragging || session.dragState === state) {
    return;
  }

  session.dragState = state;
  session.dragDecision = behaviorArbiter.setContinuousSignal(DRAG_SIGNAL_KEY, {
    state,
    priority: DECISION_PRIORITY.interaction,
    source: "dragging",
    reason: context,
  });
  applyImmediateBehavior(session.dragDecision, context);
  diagnosticLog("drag_direction_change", {
    state,
    context,
    screenX: session.lastScreenX,
    screenY: session.lastScreenY,
  });
}

function trackPetDragMotion(session, screenX, screenY) {
  const totalDx = screenX - session.startScreenX;
  const totalDy = screenY - session.startScreenY;
  const stepDx = screenX - session.lastScreenX;

  if (!session.isDragging && Math.hypot(totalDx, totalDy) >= DRAG_THRESHOLD_PX) {
    session.isDragging = true;
    clearPendingClickTimer();
    const initialState = totalDx < 0 ? "running-left" : "running-right";
    setDragAnimation(session, initialState, "drag_start");
    diagnosticLog("drag_started", {
      totalDx,
      totalDy,
      state: initialState,
    });
  } else if (session.isDragging && stepDx !== 0) {
    setDragAnimation(
      session,
      stepDx < 0 ? "running-left" : "running-right",
      "drag_direction",
    );
  }

  session.lastScreenX = screenX;
  session.lastScreenY = screenY;
}

function restoreBehaviorAfterDrag(session) {
  behaviorArbiter.clearContinuousSignal(DRAG_SIGNAL_KEY);
  behaviorArbiter.clearLatchedSignal(RANDOM_SIGNAL_KEY);
  const nextRandomDueAt = rescheduleRandomBehavior();
  const winner = behaviorArbiter.decide() ?? makeDefaultDecision("drag released");
  const consumedLatched = behaviorArbiter.consumeDecision(winner);

  applyImmediateBehavior(winner, "drag_release");
  const nextWinner = submitArbiterDecision();
  logArbiterWinnerChange(nextWinner, "drag_release");
  diagnosticLog("drag_finished", {
    dragState: session.dragState,
    restoredDecision: compactDecision(winner),
    consumedLatched,
    nextArbiterWinner: compactDecision(nextWinner),
    nextRandomDueAt,
  });
}

function finalizeCancelledPointerSession() {
  behaviorArbiter.clearContinuousSignal(DRAG_SIGNAL_KEY);
  behaviorArbiter.clearLatchedSignal(RANDOM_SIGNAL_KEY);
  const nextRandomDueAt = rescheduleRandomBehavior();
  const winner = submitArbiterDecision();
  logArbiterWinnerChange(winner, "pointer_cancel");
  diagnosticLog("pointer_interaction_cancelled", {
    arbiterWinner: compactDecision(winner),
    nextRandomDueAt,
  });
}

function finalizePetPointerSession(session) {
  if (dragSession === session) {
    dragSession = null;
  }

  if (session.isDragging) {
    restoreBehaviorAfterDrag(session);
  } else if (session.cancelled) {
    finalizeCancelledPointerSession();
  } else {
    queuePetClick();
  }
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

    finalizePetPointerSession(session);
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
    startScreenX: event.screenX,
    startScreenY: event.screenY,
    lastScreenX: event.screenX,
    lastScreenY: event.screenY,
    isDragging: false,
    dragState: null,
    dragDecision: null,
    cancelled: false,
    ready: false,
    pumping: false,
    pendingPoint: null,
    endRequested: false,
  };
  dragSession = session;
  suppressPendingRandom("pointer_interaction_start");

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
    session.cancelled = true;
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
  trackPetDragMotion(session, event.screenX, event.screenY);
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
  session.cancelled = event.type === "pointercancel";
  trackPetDragMotion(session, event.screenX, event.screenY);
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

function installPetInteractions() {
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

async function loadAppSettings() {
  const invoke = globalThis.__TAURI__?.core?.invoke;
  if (typeof invoke !== "function") {
    return normalizeSettings(null);
  }

  try {
    return normalizeSettings(await invoke("get_settings"));
  } catch (error) {
    console.warn("[screen-partner] settings load failed", error);
    return normalizeSettings(null);
  }
}

async function openSettingsWindow() {
  const invoke = globalThis.__TAURI__?.core?.invoke;
  if (typeof invoke !== "function") {
    return;
  }

  try {
    await invoke("show_settings_window");
  } catch (error) {
    console.warn("[screen-partner] settings window failed", error);
  }
}

function applyRuntimeSettings(rawSettings, { initial = false } = {}) {
  const previous = appSettings;
  const next = normalizeSettings(rawSettings);
  appSettings = next;

  renderer.setScale(next.desktop.petScale);
  document.documentElement.style.setProperty(
    "--pet-scale",
    String(next.desktop.petScale),
  );

  if (initial) {
    resetSystemSignals(
      next.desktop.systemAwarenessEnabled
        ? "system awareness initializing"
        : "system awareness disabled",
    );
    if (next.desktop.randomBehaviorEnabled) {
      randomBehavior.start();
    } else {
      randomBehavior.reset();
    }
    return;
  }

  if (
    previous.desktop.randomBehaviorEnabled !==
    next.desktop.randomBehaviorEnabled
  ) {
    behaviorArbiter.clearLatchedSignal(RANDOM_SIGNAL_KEY);
    if (next.desktop.randomBehaviorEnabled) {
      randomBehavior.start();
    } else {
      randomBehavior.reset();
    }
    const winner = submitArbiterDecision();
    logArbiterWinnerChange(winner, "settings_random_behavior");
  }

  if (
    previous.desktop.systemAwarenessEnabled !==
    next.desktop.systemAwarenessEnabled
  ) {
    resetSystemSignals(
      next.desktop.systemAwarenessEnabled
        ? "system awareness re-enabled"
        : "system awareness disabled",
    );
    const winner = submitArbiterDecision();
    logArbiterWinnerChange(winner, "settings_system_awareness");
  }

  diagnosticLog("settings_changed", {
    previous,
    current: next,
  });
}

async function subscribeSettingsChanges() {
  const listen = globalThis.__TAURI__?.event?.listen;
  if (typeof listen !== "function") {
    return;
  }

  try {
    unlistenSettings = await listen(SETTINGS_CHANGED_EVENT, (event) => {
      applyRuntimeSettings(event.payload);
    });
  } catch (error) {
    console.warn("[screen-partner] settings event subscription failed", error);
  }
}

async function refreshRuntimeSettings() {
  applyRuntimeSettings(await loadAppSettings());
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
    appSettings = await loadAppSettings();
    renderer.setScale(appSettings.desktop.petScale);
    document.documentElement.style.setProperty(
      "--pet-scale",
      String(appSettings.desktop.petScale),
    );

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
      priority: DECISION_PRIORITY.idle,
      source: "system_default",
      reason: "initial state",
    });
    applyRuntimeSettings(appSettings, { initial: true });
    showPet();
    installPetInteractions();

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
    await subscribeSettingsChanges();

    document.addEventListener("visibilitychange", () => {
      diagnosticLog("visibility_change", {
        visibilityState: document.visibilityState,
        currentState: animationPlayer?.getSnapshot().currentState ?? null,
        pendingDecision: compactDecision(animationPlayer?.getPendingDecision()),
      });

      if (document.visibilityState === "hidden") {
        clearPendingClickTimer();
        behaviorArbiter.clearContinuousSignal(DRAG_SIGNAL_KEY);
        const randomCleared = behaviorArbiter.clearLatchedSignal(RANDOM_SIGNAL_KEY);
        randomBehavior.reset();
        if (randomCleared) {
          const winner = submitArbiterDecision();
          logArbiterWinnerChange(winner, "visibility_hidden_random_cleared");
        }
        animationPlayer?.suspend();
        void flushDiagnosticLog();
      } else {
        if (appSettings.desktop.randomBehaviorEnabled) {
          randomBehavior.start();
        }
        animationPlayer?.resume();
        void refreshRuntimeSettings();
      }
    });

    scheduleAnimationTick();
    diagnosticLog("renderer_ready", {
      petId: pet.id,
      stateCount: PET_STATES.length,
      settings: appSettings,
      randomBehavior: randomBehavior.getDiagnostics(),
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
    settings: appSettings,
    randomBehavior: randomBehavior.getDiagnostics(),
  });
  void flushDiagnosticLog();

  clearPendingClickTimer();
  behaviorArbiter.clearContinuousSignal(DRAG_SIGNAL_KEY);

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
  if (typeof unlistenSettings === "function") {
    unlistenSettings();
  }

  if (dragSession) {
    dragSession.cancelled = true;
    dragSession.endRequested = true;
    pumpDragUpdates(dragSession);
  }
});

initialize();
