"use strict";

const STORAGE_KEY = "comp2001-tt2-project-v1";
const RUN_TIMEOUT_MS = 5_000;
const BUILD_TIMEOUT_MS = 120_000;
const LIMITS = Object.freeze({ maxFiles: 20, maxFileBytes: 100 * 1024, maxProjectBytes: 500 * 1024, maxStdinBytes: 50 * 1024 });
const DEFAULT_PROJECT = Object.freeze({
  activeFile: "Equipment.java",
  files: [
  {
    "name": "Equipment.java",
    "content": "// Given class. Use it as written.\npublic class Equipment\n{\n    private String name;\n    private int dailyRate;\n\n    public Equipment(String name, int dailyRate)\n    {\n        this.name = name;\n        this.dailyRate = dailyRate;\n    }\n\n    public String getName()\n    {\n        return name;\n    }\n\n    public int getDailyRate()\n    {\n        return dailyRate;\n    }\n}\n"
  },
  {
    "name": "Kayak.java",
    "content": "// Part 2, Question 1: write the Kayak class here.\npublic class Kayak\n{\n\n}\n"
  },
  {
    "name": "RentalShop.java",
    "content": "// Part 2, Question 2: write the RentalShop class here.\npublic class RentalShop\n{\n\n}\n"
  },
  {
    "name": "RentalDemo.java",
    "content": "// Part 2, Question 3: write the RentalDemo class here.\n// Run and test all your classes from this main method.\npublic class RentalDemo\n{\n    public static void main(String[] args)\n    {\n\n    }\n}\n"
  }
],
  args: "",
  stdin: "",
});

const elements = {
  themeToggle: document.querySelector("#theme-toggle"),
  fileList: document.querySelector("#file-list"),
  newFile: document.querySelector("#new-file"),
  renameFile: document.querySelector("#rename-file"),
  deleteFile: document.querySelector("#delete-file"),
  pasteSource: document.querySelector("#paste-source"),
  resetProject: document.querySelector("#reset-project"),
  copyFile: document.querySelector("#copy-file"),
  programArgs: document.querySelector("#program-args"),
  stdin: document.querySelector("#stdin-input"),
  run: document.querySelector("#run-code"),
  stop: document.querySelector("#stop-code"),
  downloadJar: document.querySelector("#download-jar"),
  clearOutput: document.querySelector("#clear-output"),
  compilerOutput: document.querySelector("#compiler-output"),
  compilerSummary: document.querySelector("#compiler-summary"),
  programOutput: document.querySelector("#program-output"),
  runtimeStatus: document.querySelector("#runtime-status"),
  fileSize: document.querySelector("#file-size"),
  saveStatus: document.querySelector("#save-status"),
};

const editor = CodeMirror.fromTextArea(document.querySelector("#code-editor"), {
  mode: "text/x-java",
  theme: document.documentElement.dataset.theme === "dark" ? "material-darker" : "default",
  lineNumbers: true,
  indentUnit: 4,
  tabSize: 4,
  indentWithTabs: false,
  lineWrapping: false,
  matchBrackets: true,
  autoCloseBrackets: true,
  extraKeys: {
    "Ctrl-Enter": runProject,
    "Cmd-Enter": runProject,
    Tab(cm) {
      if (cm.somethingSelected()) cm.indentSelection("add");
      else cm.replaceSelection("    ", "end");
    },
  },
});

let project = loadProject();
let runner = null;
let runnerReady = false;
let running = false;
let activeRunId = null;
let timeoutId = null;
let saveTimer = null;
let suppressEditorChange = false;
let jarUrl = null;

bindEvents();
renderProject();
updateThemeToggle();
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
  });
  elements.themeToggle.addEventListener("click", toggleTheme);
  elements.newFile.addEventListener("click", createFile);
  elements.renameFile.addEventListener("click", renameActiveFile);
  elements.deleteFile.addEventListener("click", deleteActiveFile);
  elements.pasteSource.addEventListener("click", pasteSource);
  elements.resetProject.addEventListener("click", resetProject);
  elements.copyFile.addEventListener("click", copyActiveCode);
  elements.programArgs.addEventListener("input", () => { project.args = elements.programArgs.value; scheduleSave(); });
  elements.stdin.addEventListener("input", () => {
    if (byteLength(elements.stdin.value) > LIMITS.maxStdinBytes) {
      elements.stdin.value = project.stdin;
      showProgramError("Standard input is limited to 50 KB.");
      return;
    }
    project.stdin = elements.stdin.value;
    scheduleSave();
  });
  elements.run.addEventListener("click", runProject);
  elements.stop.addEventListener("click", () => stopProject("Execution stopped."));
  elements.downloadJar.addEventListener("click", downloadJar);
  elements.clearOutput.addEventListener("click", clearOutputs);
  window.addEventListener("beforeunload", () => { if (saveTimer) saveProject(); });
}

function createRunner() {
  if (runner) runner.terminate();
  runnerReady = false;
  elements.run.disabled = true;
  setRuntimeStatus("loading", "Loading Java 8…");
  runner = new Worker(`./browser/runner-worker.js?v=3&instance=${Date.now()}`);
  runner.addEventListener("message", handleRunnerMessage);
  runner.addEventListener("error", handleRunnerError);
}

function handleRunnerError() {
  if (running) {
    failRun("The Java runtime stopped unexpectedly.");
    return;
  }
  setRuntimeStatus("error", "Java runtime failed to load");
  setCompilerError("The browser could not load the Java runtime. Check the network connection and reload JavaLab.");
}

function handleRunnerMessage(event) {
  const message = event.data;
  if (!message || typeof message.type !== "string") return;
  if (message.type === "ready") {
    runnerReady = true;
    elements.run.disabled = running;
    setRuntimeStatus("ready", "Java 8 ready");
    return;
  }
  if (message.runId && message.runId !== activeRunId) return;
  if (message.type === "output") handleOutput(message.channel, message.value);
  if (message.type === "complete") finishRun(message);
  if (message.type === "runner-error") failRun(message.message || "The Java runtime stopped unexpectedly.");
}

function handleOutput(channel, value) {
  if (channel === "compiler" || channel === "compiler-error") appendOutput(elements.compilerOutput, value, channel.endsWith("error"));
  if (channel === "program" || channel === "program-error") appendOutput(elements.programOutput, value, channel.endsWith("error"));
  if (channel === "compile-result") {
    const passed = value === "success";
    elements.compilerSummary.textContent = passed ? "Compiled" : "Build failed";
    elements.compilerSummary.className = `result-chip ${passed ? "passed" : "failed"}`;
    elements.compilerOutput.classList.toggle("has-error", !passed);
    elements.compilerOutput.classList.toggle("has-warning", passed && !elements.compilerOutput.querySelector(".output-placeholder"));
    if (passed && elements.compilerOutput.querySelector(".output-placeholder")) {
      setOutput(elements.compilerOutput, "Compilation completed without errors.\n");
    }
    clearTimeout(timeoutId);
    timeoutId = passed
      ? window.setTimeout(() => stopProject("Execution stopped after the five-second limit."), RUN_TIMEOUT_MS)
      : null;
  }
  if (channel === "runner") appendOutput(elements.programOutput, value, true);
}

function runProject() {
  if (!runnerReady || running) return;
  syncActiveFile();
  const validation = validateProject();
  if (!validation.ok) {
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
  elements.run.disabled = true;
  elements.stop.disabled = false;
  elements.compilerSummary.textContent = "Building…";
  elements.compilerSummary.className = "result-chip running";
  setRuntimeStatus("loading", "Compiling and running…");

  runner.postMessage({
    type: "run",
    runId: activeRunId,
    files: project.files.map((file) => ({ name: file.name, content: file.content })),
    mainClass: validation.mainClass,
    programArgs,
    stdin: project.stdin,
  });
  timeoutId = window.setTimeout(() => stopProject("Compilation stopped after 2 minutes. Click Compile & run again."), BUILD_TIMEOUT_MS);
}

function finishRun(message) {
  clearTimeout(timeoutId);
  timeoutId = null;
  running = false;
  elements.stop.disabled = true;
  if (Number(message.exitCode) !== 0) {
    setCompilerError(`The Java runner could not start (exit code ${message.exitCode}). Reload JavaLab and try again.`);
    showProgramError("Execution did not start because the Java runtime could not load the compiler.");
    createRunner();
    return;
  }
  if (elements.compilerSummary.textContent === "Building…") {
    setCompilerError("The Java runner finished without returning a compiler result. Reload JavaLab and try again.");
    createRunner();
    return;
  }
  if (message.jar instanceof ArrayBuffer && message.jar.byteLength > 0) {
    jarUrl = URL.createObjectURL(new Blob([message.jar], { type: "application/java-archive" }));
    elements.downloadJar.disabled = false;
  }
  if (!elements.programOutput.textContent.trim()) setOutput(elements.programOutput, "Program finished without producing output.");
  // Each execution gets a fresh virtual /str filesystem so replacing a source
  // file cannot leave a duplicate public class behind in CheerpJ.
  createRunner();
}

function failRun(message) {
  clearTimeout(timeoutId);
  timeoutId = null;
  running = false;
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
  if (elements.compilerSummary.textContent === "Building…") {
    setCompilerError(message);
  }
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
  const entry = ordered.find((file) => /\bpublic\s+static\s+void\s+main\s*\(\s*String(?:\s*\[\s*\]|\s+\.\.\.)/m.test(stripComments(file.content)));
  if (!entry) return { ok: false, message: "No public static void main(String[] args) method was found." };
  const source = stripComments(entry.content);
  const mainPosition = source.search(/\bpublic\s+static\s+void\s+main\s*\(/m);
  const classMatches = [...source.matchAll(/\b(?:public\s+)?class\s+([A-Za-z_$][\w$]*)/g)]
    .filter((match) => match.index < mainPosition);
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
  for (const character of text) {
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
    type.textContent = "Jv";
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = file.name;
    button.append(type, name);
    button.addEventListener("click", () => selectFile(file.name));
    item.append(button);
    return item;
  }));
  elements.deleteFile.disabled = project.files.length <= 1;
}

function renderEditor() {
  const file = activeFile();
  suppressEditorChange = true;
  editor.setValue(file?.content || "");
  suppressEditorChange = false;
  editor.clearHistory();
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

function createFile() {
  if (project.files.length >= LIMITS.maxFiles) return setCompilerError("Projects are limited to 20 files.");
  const name = window.prompt("New Java filename", "Helper.java");
  if (name === null) return;
  if (!isValidFilename(name)) return setCompilerError("Use a Java identifier followed by .java, such as Helper.java.");
  if (project.files.some((file) => file.name === name)) return setCompilerError(`${name} already exists.`);
  syncActiveFile();
  const className = name.slice(0, -5);
  project.files.push({ name, content: `public class ${className} {\n    \n}\n` });
  project.activeFile = name;
  renderProject();
  invalidateArtifact();
  scheduleSave();
}

function renameActiveFile() {
  const file = activeFile();
  if (!file) return;
  const name = window.prompt("Rename Java file", file.name);
  if (name === null || name === file.name) return;
  if (!isValidFilename(name)) return setCompilerError("Use a Java identifier followed by .java.");
  if (project.files.some((candidate) => candidate.name === name)) return setCompilerError(`${name} already exists.`);
  file.name = name;
  project.activeFile = name;
  renderFiles();
  invalidateArtifact();
  scheduleSave();
}

function deleteActiveFile() {
  if (project.files.length <= 1) return;
  const file = activeFile();
  if (!file || !window.confirm(`Delete ${file.name}?`)) return;
  const index = project.files.indexOf(file);
  project.files.splice(index, 1);
  project.activeFile = project.files[Math.min(index, project.files.length - 1)].name;
  renderProject();
  invalidateArtifact();
  scheduleSave();
}

async function pasteSource() {
  try {
    const source = await navigator.clipboard.readText();
    if (!source) throw new Error("The clipboard does not contain text.");
    if (byteLength(source) > LIMITS.maxFileBytes) throw new Error("Clipboard source exceeds the 100 KB file limit.");
    editor.setValue(source);
    elements.saveStatus.textContent = "Clipboard source pasted";
  } catch (error) {
    elements.saveStatus.textContent = "Click the editor and use Ctrl/Cmd+V to paste";
  }
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
  renderProject();
  clearOutputs();
  invalidateArtifact();
  saveProject();
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

function toggleTheme() {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("javalab-theme", theme); } catch { /* The current tab still changes. */ }
  editor.setOption("theme", theme === "dark" ? "material-darker" : "default");
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
  element.classList.remove("has-warning");
  if (value) element.textContent = value;
  else if (placeholder) {
    const span = document.createElement("span");
    span.className = "output-placeholder";
    span.textContent = placeholder;
    element.append(span);
  }
}

function appendOutput(element, value, error = false) {
  const placeholder = element.querySelector(".output-placeholder");
  if (placeholder) placeholder.remove();
  element.append(document.createTextNode(value));
  if (error) element.classList.add("has-error");
  element.scrollTop = element.scrollHeight;
}

function setRuntimeStatus(state, message) {
  elements.runtimeStatus.className = `runtime-status is-${state}`;
  elements.runtimeStatus.querySelector("span:last-child").textContent = message;
}

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
  clearTimeout(saveTimer);
  elements.saveStatus.textContent = "Saving…";
  saveTimer = window.setTimeout(saveProject, 250);
}

function saveProject() {
  clearTimeout(saveTimer);
  saveTimer = null;
  syncActiveFile();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    elements.saveStatus.textContent = "Saved on this device";
  } catch { elements.saveStatus.textContent = "Could not save — storage is full"; }
}

function updateFileSize() {
  const file = activeFile();
  elements.fileSize.textContent = formatBytes(byteLength(file?.content || ""));
}

function isValidFilename(name) { return /^[A-Za-z_$][\w$]*\.java$/.test(name); }
function byteLength(value) { return new Blob([value]).size; }
function formatBytes(bytes) { return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`; }
function cloneDefaultProject() { return JSON.parse(JSON.stringify(DEFAULT_PROJECT)); }
