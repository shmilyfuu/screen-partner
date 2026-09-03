import { AnimationPlayer } from "./core/animation-player.js";
import { PET_STATES } from "./core/normalized-pet.js";
import { loadCodexV1Pet } from "./codex-v1-manifest.js";
import { SpriteRenderer } from "./sprite-renderer.js";

const phase = "phase-3b";
const DEFAULT_PET_MANIFEST = "./pets/development/pet.json";
const SYSTEM_METRICS_EVENT = "system-metrics";

document.documentElement.dataset.screenPartnerPhase = phase;

document.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

const spriteElement = document.querySelector("[data-pet-sprite]");
const emptyStateElement = document.querySelector("[data-empty-state]");
const debugControls = document.querySelector("[data-debug-controls]");
const debugMetricsElement = document.querySelector("[data-debug-metrics]");
const debugStateSelect = document.querySelector("[data-debug-state]");

const renderer = new SpriteRenderer(spriteElement);
let animationPlayer = null;
let animationFrameRequest = null;
let unlistenSystemMetrics = null;
let latestSystemMetrics = null;
let dragSession = null;

function showPetError(error) {
  renderer.clear();
  spriteElement.hidden = true;
  emptyStateElement.hidden = false;
  console.error("[screen-partner] pet load failed", error);
}

function showPet() {
  emptyStateElement.hidden = true;
  spriteElement.hidden = false;
}

function scheduleAnimationTick() {
  animationFrameRequest = requestAnimationFrame(() => {
    animationPlayer?.tick();
    scheduleAnimationTick();
  });
}

function requestDebugState(state) {
  if (!animationPlayer) {
    return;
  }

  const nextState = state === "auto" ? "idle" : state;
  animationPlayer.requestDecision({
    state: nextState,
    priority: 0,
    source: "debug_menu",
    reason: state === "auto" ? "restore_auto" : "manual_state",
    requestedAt: performance.now(),
  });
}

function formatRate(bytesPerSecond) {
  const value = Number(bytesPerSecond);
  if (!Number.isFinite(value) || value < 0) {
    return "--";
  }

  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)}M`;
  }

  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)}K`;
  }

  return `${Math.round(value)}B`;
}

function formatPercent(value) {
  if (value === null || value === undefined) {
    return "--";
  }

  const number = Number(value);
  return Number.isFinite(number) ? `${Math.round(number)}%` : "--";
}

function updateDebugMetrics(metrics) {
  if (!debugMetricsElement || !metrics) {
    return;
  }

  debugMetricsElement.textContent =
    `CPU ${formatPercent(metrics.cpuUsagePercent)} · GPU ${formatPercent(metrics.gpuUsagePercent)} · RAM ${formatPercent(metrics.memoryUsagePercent)}\n` +
    `D ${formatRate(metrics.diskReadBps)}/${formatRate(metrics.diskWriteBps)} · ` +
    `N ${formatRate(metrics.networkRxBps)}/${formatRate(metrics.networkTxBps)}`;
}

function handleSystemMetrics(metrics) {
  latestSystemMetrics = metrics;
  document.documentElement.dataset.telemetryReady = "true";
  updateDebugMetrics(metrics);
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

async function initialize() {
  try {
    const { pet, spritesheetUrl } = await loadCodexV1Pet(DEFAULT_PET_MANIFEST);

    renderer.loadPet(pet, spritesheetUrl);
    animationPlayer = new AnimationPlayer({
      onFrame: (frameEvent) => renderer.renderFrame(frameEvent),
      onActionBoundary: ({ nextState }) => {
        debugStateSelect.dataset.currentState = nextState;
      },
    });
    animationPlayer.loadPet(pet);
    animationPlayer.start("idle");
    showPet();
    installPetDragging();

    await subscribeSystemMetrics();

    if (await developmentUiEnabled()) {
      debugControls.hidden = false;
      debugStateSelect.addEventListener("change", (event) => {
        requestDebugState(event.currentTarget.value);
      });
      updateDebugMetrics(latestSystemMetrics);
    }

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        animationPlayer?.suspend();
      } else {
        animationPlayer?.resume();
      }
    });

    scheduleAnimationTick();
    console.info(
      `[screen-partner] renderer ready: ${phase}; pet=${pet.id}; states=${PET_STATES.length}`,
    );
  } catch (error) {
    showPetError(error);
  }
}

window.addEventListener("beforeunload", () => {
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
