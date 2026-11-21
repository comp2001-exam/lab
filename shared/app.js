"use strict";

const STORAGE_KEY = "javalab-project-v2";
const LAYOUT_KEY = "javalab-layout-v2";
const TIMER_KEY = "javalab-timer-v1";
const RUN_TIMEOUT_MS = 5_000;
const BUILD_TIMEOUT_MS = 120_000;
const CHECK_DELAY_MS = 700;
const LIMITS = Object.freeze({ maxFiles: 20, maxFileBytes: 100 * 1024, maxProjectBytes: 500 * 1024, maxStdinBytes: 50 * 1024 });
const DEFAULT_PROJECT = Object.freeze({
  activeFile: "Main.java",
  files: [
    {
      name: "Main.java",
      content: "public class Main\n{\n    public static void main(String[] args)\n    {\n        System.out.println(\"Hello, world!\");\n    }\n}\n",
    },
  ],
  args: "",
  stdin: "",
});
const DEFAULT_LAYOUT = Object.freeze({ position: "right", filesWidth: 210, ioWidth: 440, ioHeight: 300, outputFraction: 0.4 });

const elements = {
  workspace: document.querySelector("#workspace"),
  themeToggle: document.querySelector("#theme-toggle"),
  layoutToggle: document.querySelector("#layout-toggle"),
  fileList: document.querySelector("#file-list"),
  newFile: document.querySelector("#new-file"),
  renameFile: document.querySelector("#rename-file"),
  deleteFile: document.querySelector("#delete-file"),
  resetLayout: document.querySelector("#reset-layout"),
  resetProject: document.querySelector("#reset-project"),
  editorFileName: document.querySelector("#editor-file-name"),
  toggleComment: document.querySelector("#toggle-comment"),
  copyFile: document.querySelector("#copy-file"),
  problemStatus: document.querySelector("#problem-status"),
  programArgs: document.querySelector("#program-args"),
  stdin: document.querySelector("#stdin-input"),
  run: document.querySelector("#run-code"),
  stop: document.querySelector("#stop-code"),
  downloadJar: document.querySelector("#download-jar"),
  clearOutput: document.querySelector("#clear-output"),
  outputSplit: document.querySelector("#output-split"),
  compilerOutput: document.querySelector("#compiler-output"),
  compilerSummary: document.querySelector("#compiler-summary"),
  programOutput: document.querySelector("#program-output"),
  runtimeStatus: document.querySelector("#runtime-status"),
  fileSize: document.querySelector("#file-size"),
  saveStatus: document.querySelector("#save-status"),
  tooltip: document.querySelector("#diag-tooltip"),
  timer: document.querySelector("#timer"),
  timerMinutes: document.querySelector("#timer-minutes"),
  timerDisplay: document.querySelector("#timer-display"),
  timerStart: document.querySelector("#timer-start"),
  timerReset: document.querySelector("#timer-reset"),
};

const editor = CodeMirror.fromTextArea(document.querySelector("#code-editor"), {
  mode: "text/x-java",
  theme: "javalab",
  lineNumbers: true,
  gutters: ["CodeMirror-linenumbers", "cm-diag-gutter"],
  indentUnit: 4,
  tabSize: 4,
  indentWithTabs: false,
  lineWrapping: false,
  matchBrackets: true,
  autoCloseBrackets: true,
  extraKeys: {
    "Ctrl-Enter": runProject,
    "Cmd-Enter": runProject,
    "Ctrl-/": toggleCommentInEditor,
    "Cmd-/": toggleCommentInEditor,
    "Ctrl-S": saveNow,
    "Cmd-S": saveNow,
    Tab(cm) {
      if (cm.somethingSelected()) cm.indentSelection("add");
      else cm.replaceSelection("    ", "end");
    },
    "Shift-Tab": (cm) => cm.indentSelection("subtract"),
  },
});

let project = loadProject();
let layout = loadLayout();
let timer = loadTimer();
let timerInterval = null;
let runner = null;
let runnerReady = false;
let running = false;
let activeRunId = null;
let runState = null;
let timeoutId = null;
let saveTimeout = null;
let suppressEditorChange = false;
let jarUrl = null;

// Live checking: the latest diagnostics for each file, and the editor marks that show them.
let diagnosticsByFile = new Map();
let editorMarks = [];
let checkTimeout = null;
let checkSequence = 0;
let latestCheck = null;
const pendingChecks = new Map();

bindEvents();
applyLayout();
renderProject();
updateThemeToggle();
updateLayoutToggle();
initializeTimer();
createRunner();

function bindEvents() {
  editor.on("change", () => {
    if (suppressEditorChange) return;
    const file = activeFile();
    if (!file) return;
    file.content = editor.getValue();
    invalidateArtifact();
    updateFileSize();
    scheduleSave();
    scheduleCheck();
  });
  elements.themeToggle.addEventListener("click", toggleTheme);
  elements.layoutToggle.addEventListener("click", toggleLayoutPosition);
  elements.newFile.addEventListener("click", createFile);
  elements.renameFile.addEventListener("click", renameActiveFile);
  elements.deleteFile.addEventListener("click", deleteActiveFile);
  elements.resetLayout.addEventListener("click", resetLayout);
  elements.resetProject.addEventListener("click", resetProject);
  // Keep the editor's selection when the button is pressed, then comment the selected lines.
  elements.toggleComment.addEventListener("mousedown", (event) => event.preventDefault());
  elements.toggleComment.addEventListener("click", () => toggleCommentInEditor(editor));
  elements.copyFile.addEventListener("click", copyActiveCode);
  elements.problemStatus.addEventListener("click", jumpToNextProblem);
  elements.run.addEventListener("click", runProject);
  elements.stop.addEventListener("click", () => stopProject("Execution stopped."));
  elements.downloadJar.addEventListener("click", downloadJar);
  elements.clearOutput.addEventListener("click", () => setOutput(elements.programOutput, "", "Run your code to see its output here."));
  elements.compilerOutput.addEventListener("click", (event) => {
    const link = event.target.closest(".diag-link");
    if (link) jumpTo(link.dataset.file, Number(link.dataset.line), Number(link.dataset.column || 1));
  });
  for (const gutter of document.querySelectorAll(".gutter")) bindGutter(gutter);
  bindTooltip();
  window.addEventListener("beforeunload", () => { if (saveTimeout) saveProject(); });
}

/* ---------- Java runtime ---------- */

function createRunner() {
  if (runner) runner.terminate();
  runnerReady = false;
  pendingChecks.clear();
  latestCheck = null;
  elements.run.disabled = true;
  setRuntimeStatus("loading", "Loading Java…");
  setProblemStatus("busy", "Loading Java…");
  runner = new Worker(`./browser/runner-worker.js?v=6&instance=${Date.now()}`);
  runner.addEventListener("message", handleRunnerMessage);
  runner.addEventListener("error", handleRunnerError);
}

function handleRunnerError(event) {
  event?.preventDefault?.();
  if (running) {
    failRun("The Java runtime stopped unexpectedly.");
    return;
  }
  setRuntimeStatus("error", "Java failed to load");
  setProblemStatus("idle", "Checking is off");
  setCompilerError("The browser could not load Java. Check the network connection and reload JavaLab.");
}

function handleRunnerMessage(event) {
  const message = event.data;
  if (!message || typeof message.type !== "string") return;
  if (message.type === "ready") {
    runnerReady = true;
    elements.run.disabled = running;
    setRuntimeStatus("ready", "Java ready");
    requestCheck();
    return;
  }
  if (pendingChecks.has(message.runId)) {
    handleCheckMessage(message);
    return;
  }
  if (!message.runId || message.runId !== activeRunId) return;
  if (message.type === "output") handleRunOutput(message.channel, message.value);
  if (message.type === "complete") finishRun(message);
  if (message.type === "runner-error") failRun(message.message || "The Java runtime stopped unexpectedly.");
}

/* ---------- Live checking and underlines ---------- */

function scheduleCheck() {
  clearTimeout(checkTimeout);
  setProblemStatus("busy", "Checking code…");
  checkTimeout = window.setTimeout(requestCheck, CHECK_DELAY_MS);
}

function requestCheck() {
  clearTimeout(checkTimeout);
  if (!runnerReady) return;
  syncActiveFile();
  if (project.files.some((file) => !isValidFilename(file.name))) return;
  const files = project.files.map((file) => ({ name: file.name, content: file.content }));
  const runId = `check-${++checkSequence}`;
  const check = { runId, files, diagnostics: [] };
  pendingChecks.set(runId, check);
  latestCheck = check;
  setProblemStatus("busy", "Checking code…");
  runner.postMessage({ type: "check", runId, files });
}

function handleCheckMessage(message) {
  const check = pendingChecks.get(message.runId);
  if (message.type === "output" && message.channel === "diagnostic") {
    const diagnostic = parseDiagnostic(message.value);
    if (diagnostic) check.diagnostics.push(diagnostic);
    return;
  }
  if (message.type === "complete" || message.type === "runner-error") {
    pendingChecks.delete(message.runId);
    if (check !== latestCheck) return;
    if (message.type === "runner-error" || Number(message.exitCode) !== 0) {
      setProblemStatus("idle", "Could not check the code");
      return;
    }
    applyDiagnostics(check.files, check.diagnostics);
  }
}

function parseDiagnostic(value) {
  try {
    const diagnostic = JSON.parse(value);
    return diagnostic && typeof diagnostic.message === "string" ? diagnostic : null;
  } catch {
    return null;
  }
}

/** Shows diagnostics, but only for files whose text has not changed since they were compiled. */
function applyDiagnostics(compiledFiles, diagnostics) {
  syncActiveFile();
  const next = new Map();
  let stale = false;
  for (const compiled of compiledFiles) {
    const current = project.files.find((file) => file.name === compiled.name);
    if (!current) continue;
    if (current.content !== compiled.content) {
      stale = true;
      if (diagnosticsByFile.has(compiled.name)) next.set(compiled.name, diagnosticsByFile.get(compiled.name));
      continue;
    }
    const forFile = diagnostics.filter((diagnostic) => diagnostic.file === compiled.name && diagnostic.kind === "error");
    if (forFile.length) next.set(compiled.name, forFile);
  }
  const general = diagnostics.filter((diagnostic) => !diagnostic.file && diagnostic.kind === "error");
  diagnosticsByFile = next;
  renderMarks();
  renderFiles();
  if (stale) return;
  const count = totalProblems() + general.length;
  if (count === 0) setProblemStatus("ok", "No problems");
  else setProblemStatus("errors", `${count} ${count === 1 ? "problem" : "problems"}: click to see the next one`);
}

function totalProblems() {
  let count = 0;
  for (const list of diagnosticsByFile.values()) count += list.length;
  return count;
}

function renderMarks() {
  editor.operation(() => {
    for (const mark of editorMarks) mark.clear();
    editorMarks = [];
    editor.clearGutter("cm-diag-gutter");
    for (let line = 0; line < editor.lineCount(); line++) editor.removeLineClass(line, "background", "cm-diag-line");

    const file = activeFile();
    const diagnostics = (file && diagnosticsByFile.get(file.name)) || [];
    const byLine = new Map();
    for (const diagnostic of diagnostics) {
      const range = diagnosticRange(diagnostic);
      if (!range) continue;
      editorMarks.push(editor.markText(range.from, range.to, {
        className: "cm-diag-error",
        attributes: { "data-message": diagnostic.message },
      }));
      const line = range.from.line;
      if (!byLine.has(line)) byLine.set(line, []);
      byLine.get(line).push(diagnostic.message);
    }
    for (const [line, messages] of byLine) {
      const marker = document.createElement("div");
      marker.className = "cm-diag-marker";
      marker.textContent = "!";
      marker.dataset.message = messages.join("\n");
      editor.setGutterMarker(line, "cm-diag-gutter", marker);
      editor.addLineClass(line, "background", "cm-diag-line");
    }
  });
}

/** ECJ gives character offsets; the end offset is inclusive. Falls back to the line and column. */
function diagnosticRange(diagnostic) {
  const lastLine = editor.lineCount() - 1;
  const length = editor.getValue().length;
  if (diagnostic.start >= 0 && diagnostic.start <= length) {
    let from = editor.posFromIndex(diagnostic.start);
    let to = editor.posFromIndex(Math.min(length, Math.max(diagnostic.end, diagnostic.start) + 1));
    if (to.line !== from.line || to.ch === from.ch) {
      const text = editor.getLine(from.line);
      to = { line: from.line, ch: Math.max(from.ch + 1, to.line === from.line ? to.ch : text.length) };
      if (to.ch > text.length) {
        // An error past the end of a line: underline the last character instead.
        from = { line: from.line, ch: Math.max(0, text.length - 1) };
        to = { line: from.line, ch: text.length };
      }
    }
    return { from, to };
  }
  if (diagnostic.line > 0) {
    const line = Math.min(diagnostic.line - 1, lastLine);
    const text = editor.getLine(line);
    const start = text.search(/\S/);
    return { from: { line, ch: Math.max(0, start) }, to: { line, ch: text.length } };
  }
  return null;
}

function jumpToNextProblem() {
  const ordered = [];
  for (const file of project.files) {
    for (const diagnostic of diagnosticsByFile.get(file.name) || []) ordered.push(diagnostic);
  }
  if (!ordered.length) return;
  const active = activeFile()?.name;
  const cursor = editor.indexFromPos(editor.getCursor());
  const activeIndex = project.files.findIndex((file) => file.name === active);
  const next = ordered.find((diagnostic) => {
    const fileIndex = project.files.findIndex((file) => file.name === diagnostic.file);
    return fileIndex > activeIndex || (fileIndex === activeIndex && diagnostic.start > cursor);
  }) || ordered[0];
  jumpTo(next.file, next.line, next.column);
}

function jumpTo(fileName, line, column = 1) {
  if (!project.files.some((file) => file.name === fileName)) return;
  if (fileName !== project.activeFile) selectFile(fileName);
  const position = { line: Math.max(0, line - 1), ch: Math.max(0, column - 1) };
  editor.focus();
  editor.setCursor(position);
  editor.scrollIntoView(position, 80);
}

function setProblemStatus(state, text) {
  elements.problemStatus.dataset.state = state;
  elements.problemStatus.textContent = text;
}

function bindTooltip() {
  const show = (target, x, y) => {
    elements.tooltip.textContent = target.dataset.message;
    elements.tooltip.hidden = false;
    const box = elements.tooltip.getBoundingClientRect();
    const left = Math.min(x + 12, window.innerWidth - box.width - 8);
    const top = y + 18 + box.height > window.innerHeight ? y - box.height - 10 : y + 18;
    elements.tooltip.style.left = `${Math.max(8, left)}px`;
    elements.tooltip.style.top = `${Math.max(8, top)}px`;
  };
  document.addEventListener("mousemove", (event) => {
    const target = event.target.closest?.(".cm-diag-error[data-message], .cm-diag-marker[data-message]");
    if (target) show(target, event.clientX, event.clientY);
    else elements.tooltip.hidden = true;
  });
  document.addEventListener("scroll", () => { elements.tooltip.hidden = true; }, true);
}

/* ---------- Running ---------- */

function runProject() {
  if (!runnerReady || running) return;
  syncActiveFile();
  saveProject();
  const validation = validateProject();
  if (!validation.ok) {
    clearOutputs();
    setCompilerError(validation.message);
    return;
  }

  let programArgs;
  try {
    programArgs = parseCommandLine(project.args);
  } catch (error) {
    showProgramError(error.message);
    return;
  }

  clearOutputs();
  invalidateArtifact();
  running = true;
  activeRunId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const files = project.files.map((file) => ({ name: file.name, content: file.content }));
  runState = { files, diagnostics: [], compiled: null, programFinished: false };
  elements.run.disabled = true;
  elements.stop.disabled = false;
  elements.compilerSummary.textContent = "Building…";
  elements.compilerSummary.className = "result-chip running";
  setRuntimeStatus("loading", "Compiling and running…");

  runner.postMessage({ type: "run", runId: activeRunId, files, mainClass: validation.mainClass, programArgs, stdin: project.stdin });
  timeoutId = window.setTimeout(() => stopProject("Compilation stopped after 2 minutes. Click Compile & run again."), BUILD_TIMEOUT_MS);
}

function handleRunOutput(channel, value) {
  if (channel === "diagnostic") {
    const diagnostic = parseDiagnostic(value);
    if (diagnostic) runState.diagnostics.push(diagnostic);
    return;
  }
  if (channel === "compiler" || channel === "compiler-error") appendCompilerText(value, channel.endsWith("error"));
  if (channel === "program" || channel === "program-error") appendOutput(elements.programOutput, value, channel.endsWith("error"));
  if (channel === "program-result") runState.programFinished = true;
  if (channel === "compile-result") {
    const passed = value === "success";
    runState.compiled = passed;
    elements.compilerSummary.textContent = passed ? "Compiled" : "Build failed";
    elements.compilerSummary.className = `result-chip ${passed ? "passed" : "failed"}`;
    elements.compilerOutput.classList.toggle("has-error", !passed);
    if (passed && elements.compilerOutput.querySelector(".output-placeholder")) {
      setOutput(elements.compilerOutput, "Compilation completed without errors.\n");
    }
    applyDiagnostics(runState.files, runState.diagnostics);
    clearTimeout(timeoutId);
    timeoutId = passed
      ? window.setTimeout(() => stopProject("Execution stopped after the five-second limit."), RUN_TIMEOUT_MS)
      : null;
    if (passed) setRuntimeStatus("loading", "Running…");
  }
  if (channel === "runner") appendOutput(elements.programOutput, value, true);
}

function finishRun(message) {
  clearTimeout(timeoutId);
  timeoutId = null;
  running = false;
  activeRunId = null;
  elements.stop.disabled = true;
  elements.run.disabled = !runnerReady;
  setRuntimeStatus("ready", "Java ready");
  if (Number(message.exitCode) !== 0 || runState.compiled === null) {
    setCompilerError("Java stopped before the build finished. JavaLab is restarting Java; try again in a moment.");
    createRunner();
    return;
  }
  if (message.jar instanceof ArrayBuffer && message.jar.byteLength > 0) {
    jarUrl = URL.createObjectURL(new Blob([message.jar], { type: "application/java-archive" }));
    elements.downloadJar.disabled = false;
  }
  if (runState.compiled && !elements.programOutput.textContent.trim()) {
    setOutput(elements.programOutput, "Program finished without producing output.");
  }
  // A program that ends with System.exit never reports back; start a fresh Java for the next run.
  if (runState.compiled && !runState.programFinished) createRunner();
}

function failRun(message) {
  clearTimeout(timeoutId);
  timeoutId = null;
  running = false;
  activeRunId = null;
  elements.stop.disabled = true;
  showProgramError(message);
  createRunner();
}

function stopProject(message) {
  if (!running) return;
  clearTimeout(timeoutId);
  timeoutId = null;
  running = false;
  activeRunId = null;
  elements.stop.disabled = true;
  appendOutput(elements.programOutput, `${message}\n`, true);
  if (elements.compilerSummary.textContent === "Building…") setCompilerError(message);
  createRunner();
}

function validateProject() {
  if (project.files.length === 0) return { ok: false, message: "Create at least one Java source file." };
  const size = project.files.reduce((total, file) => total + byteLength(file.content), 0);
  if (size > LIMITS.maxProjectBytes) return { ok: false, message: "The project is limited to 500 KB." };
  for (const file of project.files) {
    if (!isValidFilename(file.name)) return { ok: false, message: `Invalid Java filename: ${file.name}` };
    if (byteLength(file.content) > LIMITS.maxFileBytes) return { ok: false, message: `${file.name} exceeds the 100 KB file limit.` };
  }

  const ordered = [activeFile(), ...project.files].filter((file, index, files) => file && files.indexOf(file) === index);
  const entry = ordered.find((file) => /\bpublic\s+static\s+void\s+main\s*\(\s*(?:final\s+)?String(?:\s*\[\s*\]|\s+\.\.\.)/m.test(stripComments(file.content)));
  if (!entry) return { ok: false, message: "No public static void main(String[] args) method was found." };
  const source = stripComments(entry.content);
  const mainPosition = source.search(/\bpublic\s+static\s+void\s+main\s*\(/m);
  const classMatches = [...source.matchAll(/\b(?:public\s+)?class\s+([A-Za-z_$][\w$]*)/g)].filter((match) => match.index < mainPosition);
  const classMatch = classMatches[classMatches.length - 1];
  if (!classMatch) return { ok: false, message: `Could not determine the main class in ${entry.name}.` };
  const packageMatch = source.match(/^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/m);
  return { ok: true, mainClass: packageMatch ? `${packageMatch[1]}.${classMatch[1]}` : classMatch[1] };
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function parseCommandLine(text) {
  const values = [];
  let value = "";
  let quote = null;
  let escaping = false;
  let started = false;
  for (const character of text || "") {
    if (escaping) { value += character; escaping = false; started = true; continue; }
    if (character === "\\") { escaping = true; started = true; continue; }
    if (quote) {
      if (character === quote) quote = null;
      else value += character;
      started = true;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; started = true; continue; }
    if (/\s/.test(character)) {
      if (started) { values.push(value); value = ""; started = false; }
      continue;
    }
    value += character;
    started = true;
  }
  if (escaping) value += "\\";
  if (quote) throw new Error("Command-line arguments contain an unclosed quote.");
  if (started) values.push(value);
  return values;
}

/* ---------- Files and editor ---------- */

function renderProject() {
  renderFiles();
  renderEditor();
  elements.programArgs.value = project.args || "";
  elements.stdin.value = project.stdin || "";
  updateFileSize();
}

function renderFiles() {
  elements.fileList.replaceChildren(...project.files.map((file) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `file-button${file.name === project.activeFile ? " active" : ""}`;
    button.setAttribute("aria-current", file.name === project.activeFile ? "page" : "false");
    const type = document.createElement("span");
    type.className = "file-type";
    type.textContent = "J";
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = file.name;
    button.append(type, name);
    const problems = diagnosticsByFile.get(file.name)?.length || 0;
    if (problems) {
      const badge = document.createElement("span");
      badge.className = "file-badge";
      badge.textContent = String(problems);
      badge.title = `${problems} ${problems === 1 ? "problem" : "problems"}`;
      button.append(badge);
    }
    button.addEventListener("click", () => selectFile(file.name));
    item.append(button);
    return item;
  }));
  elements.deleteFile.disabled = project.files.length <= 1;
  elements.editorFileName.textContent = project.activeFile || "";
}

function renderEditor() {
  const file = activeFile();
  suppressEditorChange = true;
  editor.setValue(file?.content || "");
  suppressEditorChange = false;
  editor.clearHistory();
  renderMarks();
  window.setTimeout(() => editor.refresh(), 0);
}

function syncActiveFile() {
  const file = activeFile();
  if (file) file.content = editor.getValue();
}

function activeFile() { return project.files.find((file) => file.name === project.activeFile); }

function selectFile(name) {
  if (name === project.activeFile) return;
  syncActiveFile();
  project.activeFile = name;
  renderFiles();
  renderEditor();
  scheduleSave();
}

function toggleCommentInEditor(cm) {
  cm.toggleComment({ indent: true });
  cm.focus();
}

function saveNow() {
  saveProject();
}

function createFile() {
  if (project.files.length >= LIMITS.maxFiles) return setCompilerError("Projects are limited to 20 files.");
  const name = window.prompt("New Java file name", "Helper.java");
  if (name === null) return;
  const trimmed = name.trim();
  if (!isValidFilename(trimmed)) return setCompilerError("Use a Java identifier followed by .java, such as Helper.java.");
  if (project.files.some((file) => file.name === trimmed)) return setCompilerError(`${trimmed} already exists.`);
  syncActiveFile();
  const className = trimmed.slice(0, -5);
  project.files.push({ name: trimmed, content: `public class ${className}\n{\n    \n}\n` });
  project.activeFile = trimmed;
  renderProject();
  invalidateArtifact();
  scheduleSave();
  scheduleCheck();
}

function renameActiveFile() {
  const file = activeFile();
  if (!file) return;
  const name = window.prompt("Rename Java file", file.name);
  if (name === null || name.trim() === file.name) return;
  const trimmed = name.trim();
  if (!isValidFilename(trimmed)) return setCompilerError("Use a Java identifier followed by .java.");
  if (project.files.some((candidate) => candidate.name === trimmed)) return setCompilerError(`${trimmed} already exists.`);
  diagnosticsByFile.delete(file.name);
  file.name = trimmed;
  project.activeFile = trimmed;
  renderFiles();
  invalidateArtifact();
  scheduleSave();
  scheduleCheck();
}

function deleteActiveFile() {
  if (project.files.length <= 1) return;
  const file = activeFile();
  if (!file || !window.confirm(`Delete ${file.name}?`)) return;
  const index = project.files.indexOf(file);
  project.files.splice(index, 1);
  diagnosticsByFile.delete(file.name);
  project.activeFile = project.files[Math.min(index, project.files.length - 1)].name;
  renderProject();
  invalidateArtifact();
  scheduleSave();
  scheduleCheck();
}

async function copyActiveCode() {
  try {
    await navigator.clipboard.writeText(editor.getValue());
    const previous = elements.copyFile.textContent;
    elements.copyFile.textContent = "Copied";
    window.setTimeout(() => { elements.copyFile.textContent = previous; }, 1200);
  } catch {
    elements.copyFile.textContent = "Copy failed";
  }
}

function resetProject() {
  if (!window.confirm("Reset JavaLab and replace every file with the starter project?")) return;
  project = cloneDefaultProject();
  diagnosticsByFile = new Map();
  renderProject();
  clearOutputs();
  invalidateArtifact();
  saveProject();
  scheduleCheck();
}

function downloadJar() {
  if (!jarUrl) return;
  const link = document.createElement("a");
  link.href = jarUrl;
  link.download = "javalab-project.jar";
  link.click();
}

function invalidateArtifact() {
  if (jarUrl) URL.revokeObjectURL(jarUrl);
  jarUrl = null;
  elements.downloadJar.disabled = true;
}

/* ---------- Theme ---------- */

function toggleTheme() {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("javalab-theme", theme); } catch { /* The current tab still changes. */ }
  updateThemeToggle();
  window.setTimeout(() => editor.refresh(), 0);
}

function updateThemeToggle() {
  const dark = document.documentElement.dataset.theme === "dark";
  elements.themeToggle.setAttribute("aria-pressed", String(dark));
  elements.themeToggle.setAttribute("aria-label", `Switch to ${dark ? "light" : "dark"} mode`);
  elements.themeToggle.title = `Switch to ${dark ? "light" : "dark"} mode`;
  elements.themeToggle.querySelector("span").textContent = dark ? "☀" : "☾";
}

/* ---------- Resizable panels ---------- */

function loadLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}");
    return { ...DEFAULT_LAYOUT, ...saved };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

function saveLayout() {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* Layout still applies in this tab. */ }
}

function applyLayout() {
  const root = document.documentElement;
  if (layout.position === "bottom") root.dataset.layout = "bottom";
  else delete root.dataset.layout;
  root.style.setProperty("--files-w", `${layout.filesWidth}px`);
  root.style.setProperty("--io-w", `${layout.ioWidth}px`);
  root.style.setProperty("--io-h", `${layout.ioHeight}px`);
  root.style.setProperty("--output-frac", `${(layout.outputFraction * 100).toFixed(1)}%`);
  editor.refresh();
}

function toggleLayoutPosition() {
  layout.position = layout.position === "bottom" ? "right" : "bottom";
  applyLayout();
  saveLayout();
  updateLayoutToggle();
}

function updateLayoutToggle() {
  const bottom = layout.position === "bottom";
  const label = bottom ? "Move the output panel to the right of the editor" : "Move the output panel below the editor";
  elements.layoutToggle.title = label;
  elements.layoutToggle.setAttribute("aria-label", label);
  elements.layoutToggle.querySelector("span").textContent = bottom ? "◨" : "⬓";
}

function resetLayout() {
  layout = { ...DEFAULT_LAYOUT };
  applyLayout();
  saveLayout();
  updateLayoutToggle();
}

function bindGutter(gutter) {
  const kind = gutter.dataset.resize;
  gutter.addEventListener("dblclick", () => {
    if (kind === "files") layout.filesWidth = DEFAULT_LAYOUT.filesWidth;
    if (kind === "io") { layout.ioWidth = DEFAULT_LAYOUT.ioWidth; layout.ioHeight = DEFAULT_LAYOUT.ioHeight; }
    if (kind === "output") layout.outputFraction = DEFAULT_LAYOUT.outputFraction;
    applyLayout();
    saveLayout();
  });
  gutter.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    gutter.setPointerCapture(event.pointerId);
    gutter.classList.add("dragging");
    const rows = (kind === "io" && layout.position === "bottom") || (kind === "output" && layout.position !== "bottom");
    document.body.classList.add("resizing");
    document.body.classList.toggle("rows", rows);
    const move = (moveEvent) => resizeFromPointer(kind, moveEvent.clientX, moveEvent.clientY);
    const end = () => {
      gutter.classList.remove("dragging");
      document.body.classList.remove("resizing", "rows");
      gutter.removeEventListener("pointermove", move);
      gutter.removeEventListener("pointerup", end);
      gutter.removeEventListener("pointercancel", end);
      saveLayout();
      editor.refresh();
    };
    gutter.addEventListener("pointermove", move);
    gutter.addEventListener("pointerup", end);
    gutter.addEventListener("pointercancel", end);
  });
}

function resizeFromPointer(kind, x, y) {
  const box = elements.workspace.getBoundingClientRect();
  const clamp = (value, low, high) => Math.round(Math.min(Math.max(value, low), Math.max(low, high)));
  if (kind === "files") {
    const otherWidth = layout.position === "bottom" ? 0 : layout.ioWidth;
    layout.filesWidth = clamp(x - box.left, 130, Math.min(420, box.width - otherWidth - 300));
  } else if (kind === "io" && layout.position === "bottom") {
    layout.ioHeight = clamp(box.bottom - y, 140, box.height - 140);
  } else if (kind === "io") {
    layout.ioWidth = clamp(box.right - x, 260, box.width - layout.filesWidth - 300);
  } else if (kind === "output") {
    const split = elements.outputSplit.getBoundingClientRect();
    const fraction = layout.position === "bottom" ? (x - split.left) / split.width : (y - split.top) / split.height;
    layout.outputFraction = Math.min(0.85, Math.max(0.12, fraction));
  }
  applyLayout();
}

/* ---------- Countdown timer ---------- */

function initializeTimer() {
  elements.timerMinutes.value = String(timer.minutes);
  elements.timerStart.addEventListener("click", () => {
    if (timer.state === "idle") startTimer();
    else if (timer.state === "running") pauseTimer();
    else if (timer.state === "paused") resumeTimer();
  });
  elements.timerReset.addEventListener("click", () => {
    if (timer.state === "running" && !window.confirm("Reset the timer?")) return;
    resetTimer();
  });
  elements.timerMinutes.addEventListener("keydown", (event) => { if (event.key === "Enter") startTimer(); });
  renderTimer();
  if (timer.state === "running") timerInterval = window.setInterval(tickTimer, 250);
}

function loadTimer() {
  const fallback = { state: "idle", minutes: 60, totalMs: 0, endAt: 0, remainingMs: 0 };
  try {
    const saved = JSON.parse(localStorage.getItem(TIMER_KEY) || "null");
    if (!saved || typeof saved.state !== "string") return fallback;
    return { ...fallback, ...saved };
  } catch {
    return fallback;
  }
}

function storeTimer() {
  try { localStorage.setItem(TIMER_KEY, JSON.stringify(timer)); } catch { /* The timer still runs in this tab. */ }
}

function startTimer() {
  const minutes = Math.round(Number(elements.timerMinutes.value));
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 600) {
    elements.timerMinutes.focus();
    elements.timerMinutes.select();
    return;
  }
  timer = { state: "running", minutes, totalMs: minutes * 60_000, endAt: Date.now() + minutes * 60_000, remainingMs: minutes * 60_000 };
  storeTimer();
  clearInterval(timerInterval);
  timerInterval = window.setInterval(tickTimer, 250);
  renderTimer();
}

function pauseTimer() {
  timer.remainingMs = Math.max(0, timer.endAt - Date.now());
  timer.state = "paused";
  clearInterval(timerInterval);
  storeTimer();
  renderTimer();
}

function resumeTimer() {
  timer.endAt = Date.now() + timer.remainingMs;
  timer.state = "running";
  clearInterval(timerInterval);
  timerInterval = window.setInterval(tickTimer, 250);
  storeTimer();
  renderTimer();
}

function resetTimer() {
  clearInterval(timerInterval);
  timer = { state: "idle", minutes: timer.minutes, totalMs: 0, endAt: 0, remainingMs: 0 };
  storeTimer();
  renderTimer();
}

function tickTimer() {
  if (timer.state !== "running") return;
  timer.remainingMs = Math.max(0, timer.endAt - Date.now());
  if (timer.remainingMs === 0) {
    timer.state = "done";
    clearInterval(timerInterval);
    storeTimer();
  }
  renderTimer();
}

function renderTimer() {
  if (timer.state === "running") timer.remainingMs = Math.max(0, timer.endAt - Date.now());
  if (timer.state === "running" && timer.remainingMs === 0) timer.state = "done";
  elements.timer.dataset.state = timer.state;
  const remaining = timer.state === "idle" ? timer.minutes * 60_000 : timer.remainingMs;
  const critical = timer.state !== "idle" && remaining <= Math.min(5 * 60_000, timer.totalMs * 0.2);
  elements.timer.dataset.level = critical ? "critical" : "normal";
  elements.timerDisplay.textContent = timer.state === "done" ? "Time's up" : formatDuration(remaining);
  elements.timerStart.textContent = timer.state === "running" ? "Pause" : timer.state === "paused" ? "Resume" : "Start";
  document.title = timer.state === "done" ? "Time's up · JavaLab"
    : timer.state === "running" ? `${formatDuration(remaining)} · JavaLab` : "JavaLab";
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.ceil(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/* ---------- Output panes ---------- */

function clearOutputs() {
  setOutput(elements.compilerOutput, "", "Compiler messages will appear here.");
  setOutput(elements.programOutput, "", "Run your code to see its output here.");
  elements.compilerSummary.textContent = "Not run";
  elements.compilerSummary.className = "result-chip";
}

function setCompilerError(message) {
  setOutput(elements.compilerOutput, `${message}\n`, null, true);
  elements.compilerSummary.textContent = "Check project";
  elements.compilerSummary.className = "result-chip failed";
}

function showProgramError(message) { setOutput(elements.programOutput, `${message}\n`, null, true); }

function setOutput(element, value, placeholder = null, error = false) {
  element.replaceChildren();
  element.classList.toggle("has-error", error);
  if (value) element.append(error ? errorSpan(value) : document.createTextNode(value));
  else if (placeholder) {
    const span = document.createElement("span");
    span.className = "output-placeholder";
    span.textContent = placeholder;
    element.append(span);
  }
}

function errorSpan(value) {
  const span = document.createElement("span");
  span.className = "err";
  span.textContent = value;
  return span;
}

function appendOutput(element, value, error = false) {
  element.querySelector(".output-placeholder")?.remove();
  element.append(error ? errorSpan(value) : document.createTextNode(value));
  if (error) element.classList.add("has-error");
  element.scrollTop = element.scrollHeight;
}

/** Compiler text, with "File.java:12:" turned into a link that jumps to the line. */
function appendCompilerText(value, error) {
  const output = elements.compilerOutput;
  output.querySelector(".output-placeholder")?.remove();
  const match = value.match(/^([A-Za-z_$][\w$]*\.java):(\d+):/);
  const container = error ? errorSpan("") : document.createElement("span");
  if (match) {
    const link = document.createElement("span");
    link.className = "diag-link";
    link.dataset.file = match[1];
    link.dataset.line = match[2];
    const diagnostic = runState?.diagnostics.find((item) => item.file === match[1] && item.line === Number(match[2]));
    if (diagnostic) link.dataset.column = String(diagnostic.column);
    link.textContent = `${match[1]}:${match[2]}`;
    link.title = "Go to this line";
    container.append(link, document.createTextNode(value.slice(match[0].length - 1)));
  } else {
    container.append(document.createTextNode(value));
  }
  output.append(container);
  if (error) output.classList.add("has-error");
  output.scrollTop = output.scrollHeight;
}

function setRuntimeStatus(state, message) {
  elements.runtimeStatus.className = `runtime-status is-${state}`;
  elements.runtimeStatus.querySelector("span:last-child").textContent = message;
}

/* ---------- Saving ---------- */

function loadProject() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved || !Array.isArray(saved.files) || saved.files.length === 0) return cloneDefaultProject();
    const files = saved.files.filter((file) => file && isValidFilename(file.name) && typeof file.content === "string").slice(0, LIMITS.maxFiles);
    if (!files.length) return cloneDefaultProject();
    return {
      files,
      activeFile: files.some((file) => file.name === saved.activeFile) ? saved.activeFile : files[0].name,
      args: typeof saved.args === "string" ? saved.args : "",
      stdin: typeof saved.stdin === "string" ? saved.stdin : "",
    };
  } catch { return cloneDefaultProject(); }
}

function scheduleSave() {
  clearTimeout(saveTimeout);
  elements.saveStatus.textContent = "Saving…";
  saveTimeout = window.setTimeout(saveProject, 250);
}

function saveProject() {
  clearTimeout(saveTimeout);
  saveTimeout = null;
  syncActiveFile();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    elements.saveStatus.textContent = "Saved on this device";
  } catch { elements.saveStatus.textContent = "Could not save: storage is full"; }
}

function updateFileSize() {
  const file = activeFile();
  elements.fileSize.textContent = formatBytes(byteLength(file?.content || ""));
}

function isValidFilename(name) { return /^[A-Za-z_$][\w$]*\.java$/.test(name); }
function byteLength(value) { return new Blob([value]).size; }
function formatBytes(bytes) { return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`; }
function cloneDefaultProject() { return JSON.parse(JSON.stringify(DEFAULT_PROJECT)); }
