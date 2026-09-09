import { normalizeSettings } from "./core/settings-model.js";

const form = document.querySelector("[data-settings-form]");
const petScale = document.querySelector("[data-setting-pet-scale]");
const alwaysOnTop = document.querySelector("[data-setting-always-on-top]");
const randomBehavior = document.querySelector("[data-setting-random-behavior]");
const systemAwareness = document.querySelector("[data-setting-system-awareness]");
const launchAtStartup = document.querySelector("[data-setting-launch-at-startup]");
const showButton = document.querySelector("[data-action-show]");
const hideButton = document.querySelector("[data-action-hide]");
const recallButton = document.querySelector("[data-action-recall]");
const resetButton = document.querySelector("[data-action-reset]");
const statusOutput = document.querySelector("[data-settings-status]");

let currentSettings = normalizeSettings(null);
let saving = false;
let unlistenSettings = null;

function invoke(command, payload = {}) {
  const tauriInvoke = globalThis.__TAURI__?.core?.invoke;
  if (typeof tauriInvoke !== "function") {
    return Promise.reject(new Error("Tauri invoke is unavailable"));
  }
  return tauriInvoke(command, payload);
}

function setStatus(message = "", kind = "normal") {
  statusOutput.textContent = message;
  statusOutput.dataset.kind = kind;
}

function setBusy(value) {
  saving = value;
  for (const control of form.elements) {
    control.disabled = value;
  }
  resetButton.disabled = value;
}

function renderSettings(rawSettings) {
  currentSettings = normalizeSettings(rawSettings);
  const desktop = currentSettings.desktop;
  petScale.value = String(desktop.petScale);
  alwaysOnTop.checked = desktop.alwaysOnTop;
  randomBehavior.checked = desktop.randomBehaviorEnabled;
  systemAwareness.checked = desktop.systemAwarenessEnabled;
  launchAtStartup.checked = desktop.launchAtStartup;
}

function desktopSettingsFromForm() {
  return {
    petScale: Number(petScale.value),
    alwaysOnTop: alwaysOnTop.checked,
    randomBehaviorEnabled: randomBehavior.checked,
    systemAwarenessEnabled: systemAwareness.checked,
    launchAtStartup: launchAtStartup.checked,
  };
}

async function saveDesktopSettings() {
  if (saving) {
    return;
  }

  setBusy(true);
  setStatus("正在保存…");
  try {
    const settings = await invoke("update_desktop_settings", {
      desktop: desktopSettingsFromForm(),
    });
    renderSettings(settings);
    setStatus("已保存");
  } catch (error) {
    renderSettings(currentSettings);
    setStatus(String(error), "error");
  } finally {
    setBusy(false);
  }
}

async function invokeWindowAction(command) {
  try {
    await invoke(command);
    setStatus("操作已执行");
  } catch (error) {
    setStatus(String(error), "error");
  }
}

async function resetDesktopSettings() {
  if (saving) {
    return;
  }
  if (!globalThis.confirm("恢复宠物大小、置顶、行为开关和开机启动的默认设置？")) {
    return;
  }

  setBusy(true);
  setStatus("正在恢复默认设置…");
  try {
    const settings = await invoke("reset_desktop_settings");
    renderSettings(settings);
    setStatus("已恢复默认设置");
  } catch (error) {
    setStatus(String(error), "error");
  } finally {
    setBusy(false);
  }
}

async function initialize() {
  try {
    renderSettings(await invoke("get_settings"));
    setStatus("");
  } catch (error) {
    setStatus(String(error), "error");
  }

  form.addEventListener("change", () => {
    void saveDesktopSettings();
  });
  showButton.addEventListener("click", () => void invokeWindowAction("show_pet"));
  hideButton.addEventListener("click", () => void invokeWindowAction("hide_pet"));
  recallButton.addEventListener("click", () => void invokeWindowAction("recall_pet"));
  resetButton.addEventListener("click", () => void resetDesktopSettings());

  const listen = globalThis.__TAURI__?.event?.listen;
  if (typeof listen === "function") {
    try {
      unlistenSettings = await listen("settings-changed", (event) => {
        renderSettings(event.payload);
      });
    } catch (error) {
      console.warn("[screen-partner] settings event listener unavailable", error);
    }
  }
}

window.addEventListener("beforeunload", () => {
  if (typeof unlistenSettings === "function") {
    unlistenSettings();
  }
});

void initialize();
