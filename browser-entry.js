"use strict";

globalThis.JavaLabDeployment = Object.freeze({
  target: "browser",
  executionPolicy: "browser-only",
  persistence: "local",
});

loadApplication();

function loadApplication() {
  const script = document.createElement("script");
  script.src = "./bootstrap.js?v=5";
  script.onerror = () => {
    const status = document.querySelector("#runtime-status span:last-child");
    if (status) status.textContent = "Application failed to load";
  };
  document.body.append(script);
}
