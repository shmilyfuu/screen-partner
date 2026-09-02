const phase = "phase-0a";

document.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

document.documentElement.dataset.screenPartnerPhase = phase;
console.info(`[screen-partner] renderer ready: ${phase}`);
