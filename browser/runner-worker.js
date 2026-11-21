"use strict";

importScripts("../shared/runtime-path.js?v=2", "https://cjrtnc.leaningtech.com/5.0/loader.js");

const JAVA_VERSION = 8;
let activeRunId = null;
const initialization = initializeRuntime();
let queue = Promise.resolve();

self.addEventListener("message", (event) => {
  const request = event.data;
  if (request?.type !== "run" && request?.type !== "check") return;
  // CheerpJ runs one main method at a time, so requests wait their turn.
  queue = queue.then(() => handle(request)).catch(() => {});
});

async function handle(request) {
  activeRunId = request.runId;
  try {
    await initialization;
    const argumentsForRunner = [
      request.type,
      request.runId,
      request.mainClass || "",
      encodeBase64(request.stdin || ""),
      String((request.programArgs || []).length),
      ...(request.programArgs || []),
    ];
    for (const file of request.files) argumentsForRunner.push(file.name, encodeBase64(file.content));

    const exitCode = await cheerpjRunMain(
      "dev.javalab.Runner",
      JavaLabRuntimePaths.getRunnerClassPath(self.location.href),
      ...argumentsForRunner,
    );

    let jar = null;
    if (request.type === "run") {
      try {
        const blob = await cjFileBlob(`/files/javalab/${request.runId}/javalab.jar`);
        jar = await blob.arrayBuffer();
      } catch {
        // Compilation failures have no downloadable artifact.
      }
    }
    post({ type: "complete", mode: request.type, runId: request.runId, exitCode, jar }, jar ? [jar] : []);
  } catch (error) {
    post({ type: "runner-error", runId: request.runId, message: error instanceof Error ? error.message : String(error) });
  }
}

async function initializeRuntime() {
  await cheerpjInit({
    version: JAVA_VERSION,
    status: "none",
    overrideDocumentBase: new URL("./", self.location.href).href,
    natives: { Java_dev_javalab_Runner_emit },
  });
  post({ type: "ready", version: JAVA_VERSION });
}

function Java_dev_javalab_Runner_emit(_library, channel, value) {
  post({ type: "output", runId: activeRunId, channel: String(channel), value: String(value) });
}

function encodeBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function post(message, transfer = []) {
  self.postMessage(message, transfer);
}
