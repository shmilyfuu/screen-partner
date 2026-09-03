import { AnimationPlayer } from "./core/animation-player.js";
import { PET_STATES } from "./core/normalized-pet.js";
import { loadCodexV1Pet } from "./codex-v1-manifest.js";
import { SpriteRenderer } from "./sprite-renderer.js";

const phase = "phase-1";
const DEFAULT_PET_MANIFEST = "./pets/development/pet.json";

document.documentElement.dataset.screenPartnerPhase = phase;

document.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

const spriteElement = document.querySelector("[data-pet-sprite]");
const emptyStateElement = document.querySelector("[data-empty-state]");
const debugControls = document.querySelector("[data-debug-controls]");
const debugStateSelect = document.querySelector("[data-debug-state]");

const renderer = new SpriteRenderer(spriteElement);
let animationPlayer = null;
let animationFrameRequest = null;

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

    if (await developmentUiEnabled()) {
      debugControls.hidden = false;
      debugStateSelect.addEventListener("change", (event) => {
        requestDebugState(event.currentTarget.value);
      });
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
});

initialize();
