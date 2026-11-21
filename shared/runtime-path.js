"use strict";

(function exposeRuntimePaths(scope) {
  function getRunnerClassPath(workerUrl) {
    const deploymentPath = new URL("./", workerUrl).pathname.replace(/\/+$/, "");
    const runtimePath = `/app${deploymentPath}/runtime`;
    return `${runtimePath}/javalab-runner-2.jar:${runtimePath}/ecj.jar`;
  }

  scope.JavaLabRuntimePaths = Object.freeze({ getRunnerClassPath });
})(typeof self === "undefined" ? globalThis : self);
