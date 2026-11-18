"use strict";

importScripts("../shared/runtime-path.js", "https://cjrtnc.leaningtech.com/4.3/loader.js");

let initialized = false;
let activeRunId = null;
const initialization = initializeRuntime();

self.addEventListener("message", async (event) => {
  if (event.data?.type !== "run") return;
  const request = event.data;
  activeRunId = request.runId;

  try {
    await initialization;
    for (const file of request.files) {
      const path = `/str/${file.name}`;
      try { cheerpOSRemoveStringFile(path); } catch { /* The first run has nothing to remove. */ }
      cheerpOSAddStringFile(path, file.content);
    }

    const argumentsForRunner = [
      request.runId,
      request.mainClass,
      encodeBase64(request.stdin),
      String(request.programArgs.length),
      ...request.programArgs,
      ...request.files.map((file) => `/str/${file.name}`),
    ];
    const exitCode = await cheerpjRunMain(
      "dev.javalab.Runner",
      JavaLabRuntimePaths.getRunnerClassPath(self.location.href),
      ...argumentsForRunner,
    );

    let jar = null;
    try {
      const blob = await cjFileBlob(`/files/javalab/${request.runId}/javalab.jar`);
      jar = await blob.arrayBuffer();
    } catch {
      // Compilation failures intentionally have no downloadable artifact.
    }
    post({ type: "complete", runId: request.runId, exitCode, jar }, jar ? [jar] : []);
  } catch (error) {
    post({ type: "runner-error", runId: request.runId, message: error instanceof Error ? error.message : String(error) });
  }
});

async function initializeRuntime() {
  if (initialized) return;
  await cheerpjInit({
    version: 8,
    status: "none",
    overrideDocumentBase: new URL("./", self.location.href).href,
    natives: { Java_dev_javalab_Runner_emit },
  });
  initialized = true;
  post({ type: "ready" });
}

function Java_dev_javalab_Runner_emit(_library, channel, value) {
  post({ type: "output", runId: activeRunId, channel: String(channel), value: String(value) });
}

function encodeBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function post(message, transfer = []) {
  self.postMessage(message, transfer);
}
