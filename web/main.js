const phase = "phase-0b";

document.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

document.documentElement.dataset.screenPartnerPhase = phase;
console.info(`[screen-partner] renderer ready: ${phase}`);
