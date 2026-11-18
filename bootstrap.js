"use strict";

const CODEMIRROR_VERSION = "5.65.16";
const CDN_BASE = `https://cdn.jsdelivr.net/npm/codemirror@${CODEMIRROR_VERSION}/`;
const LOCAL_BASE = "./vendor/codemirror/";
const FORCE_LOCAL = new URLSearchParams(window.location.search).has("localAssets");
const scripts = [
  "lib/codemirror.js",
  "mode/clike/clike.js",
  "addon/edit/matchbrackets.js",
  "addon/edit/closebrackets.js",
];

initialize();

async function initialize() {
  try {
    for (const path of scripts) await loadWithFallback(path);
    await loadScript("./shared/app.js?v=3");
  } catch (error) {
    const status = document.querySelector("#runtime-status span:last-child");
    if (status) status.textContent = "Editor failed to load";
    console.error(error);
  }
}

async function loadWithFallback(path) {
  if (!FORCE_LOCAL) {
    try {
      await loadScript(`${CDN_BASE}${path}`);
      return;
    } catch {
      // Continue with the pinned local asset.
    }
  }
  await loadScript(`${LOCAL_BASE}${path}`);
}

function loadScript(source) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = source;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${source}`));
    document.head.append(script);
  });
}
