package dev.javalab;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintStream;
import java.io.StringWriter;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.HashMap;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import org.eclipse.jdt.internal.compiler.tool.EclipseCompiler;

/**
 * Compiles a JavaLab project with the Eclipse compiler (ECJ), optionally runs its entry point, and streams
 * text output plus structured diagnostics (for editor underlines) to JavaScript.
 *
 * Arguments: mode runId mainClass stdinBase64 argCount args... (name contentBase64)...
 * mode is "run" (compile, then run) or "check" (compile only, diagnostics only).
 */
public final class Runner {
    private Runner() {}

    private static native void emit(String channel, String value);

    private static JavaCompiler compiler;
    private static final Map<String, String> contents = new HashMap<>();

    public static void main(String[] args) {
        try {
            execute(args);
        } catch (Throwable error) {
            emit("runner", "JavaLab could not process the request: " + error + "\n");
        }
    }

    private static void execute(String[] args) throws IOException {
        if (args.length < 5) {
            emit("runner", "JavaLab received an invalid request.\n");
            return;
        }
        String mode = args[0];
        String runId = args[1];
        String mainClass = args[2];
        String stdin = decode(args[3]);
        int argCount = Integer.parseInt(args[4]);
        String[] programArgs = new String[argCount];
        System.arraycopy(args, 5, programArgs, 0, argCount);

        List<Source> sources = new ArrayList<>();
        for (int index = 5 + argCount; index + 1 < args.length; index += 2) {
            sources.add(new Source(args[index], decode(args[index + 1])));
        }

        Path root = Paths.get("/files/javalab");
        Path projectDirectory = root.resolve(runId);
        Path classesDirectory = projectDirectory.resolve("classes");
        removeOlderRuns(root);
        Files.createDirectories(classesDirectory);

        Path sourceDirectory = projectDirectory.resolve("src");
        Files.createDirectories(sourceDirectory);
        boolean compiled = compile(sources, sourceDirectory, classesDirectory, "check".equals(mode));
        emit("compile-result", compiled ? "success" : "failure");
        if (!compiled || "check".equals(mode)) return;

        runProgram(classesDirectory, mainClass, programArgs, stdin);
    }

    private static String decode(String base64) {
        return new String(Base64.getDecoder().decode(base64), StandardCharsets.UTF_8);
    }

    private static void removeOlderRuns(Path root) throws IOException {
        if (!Files.isDirectory(root)) return;
        try (Stream<Path> children = Files.list(root)) {
            for (Path child : children.collect(Collectors.toList())) {
                try (Stream<Path> paths = Files.walk(child)) {
                    for (Path entry : paths.sorted(Comparator.reverseOrder()).collect(Collectors.toList())) {
                        Files.deleteIfExists(entry);
                    }
                }
            }
        }
    }

    private static boolean compile(List<Source> sources, Path sourceDirectory, Path classesDirectory, boolean quiet) throws IOException {
        // ECJ only accepts sources that exist on disk, so each editor file is written out first.
        contents.clear();
        List<java.io.File> sourceFiles = new ArrayList<>();
        for (Source source : sources) {
            String name = Paths.get(source.fileName).getFileName().toString();
            Path path = sourceDirectory.resolve(name);
            Files.write(path, source.content.getBytes(StandardCharsets.UTF_8));
            contents.put(name, source.content);
            sourceFiles.add(path.toFile());
        }
        if (compiler == null) compiler = new EclipseCompiler();
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        try (StandardJavaFileManager files = compiler.getStandardFileManager(diagnostics, Locale.ENGLISH, StandardCharsets.UTF_8)) {
            List<String> options = new ArrayList<>();
            options.add("-1.8");
            options.add("-proc:none");
            options.add("-nowarn");
            options.add("-g"); // line numbers in stack traces
            options.add("-d");
            options.add(quiet ? "none" : classesDirectory.toString());
            StringWriter extra = new StringWriter();
            boolean ok = compiler.getTask(extra, files, diagnostics, options, null, files.getJavaFileObjectsFromFiles(sourceFiles)).call();
            int errors = 0;
            int warnings = 0;
            for (Diagnostic<? extends JavaFileObject> diagnostic : diagnostics.getDiagnostics()) {
                boolean isError = diagnostic.getKind() == Diagnostic.Kind.ERROR;
                if (isError) errors++;
                else if (diagnostic.getKind() == Diagnostic.Kind.WARNING || diagnostic.getKind() == Diagnostic.Kind.MANDATORY_WARNING) warnings++;
                emitDiagnostic(diagnostic);
                if (!quiet) emit(isError ? "compiler-error" : "compiler", format(diagnostic));
            }
            if (!quiet && !ok && diagnostics.getDiagnostics().isEmpty() && extra.toString().length() > 0) emit("compiler-error", extra.toString());
            if (!quiet && (errors > 0 || warnings > 0)) {
                StringBuilder summary = new StringBuilder();
                if (errors > 0) summary.append(errors).append(errors == 1 ? " error" : " errors");
                if (warnings > 0) {
                    if (summary.length() > 0) summary.append(", ");
                    summary.append(warnings).append(warnings == 1 ? " warning" : " warnings");
                }
                emit(errors > 0 ? "compiler-error" : "compiler", summary + "\n");
            }
            return ok;
        }
    }

    /** The compiler's message, with "java.lang.String" shortened to "String" as students write it. */
    private static String message(Diagnostic<? extends JavaFileObject> diagnostic) {
        return diagnostic.getMessage(Locale.ENGLISH).replaceAll("\\bjava\\.lang\\.(?=[A-Z])", "");
    }

    private static String kindName(Diagnostic.Kind kind) {
        switch (kind) {
            case ERROR: return "error";
            case WARNING:
            case MANDATORY_WARNING: return "warning";
            default: return "note";
        }
    }

    private static String fileName(Diagnostic<? extends JavaFileObject> diagnostic) {
        JavaFileObject source = diagnostic.getSource();
        if (source == null) return "";
        String name = source.getName().replace('\\', '/');
        return name.substring(name.lastIndexOf('/') + 1);
    }

    private static void emitDiagnostic(Diagnostic<? extends JavaFileObject> diagnostic) {
        String json = "{\"file\":" + quote(fileName(diagnostic))
            + ",\"kind\":" + quote(kindName(diagnostic.getKind()))
            + ",\"line\":" + diagnostic.getLineNumber()
            + ",\"column\":" + diagnostic.getColumnNumber()
            + ",\"start\":" + diagnostic.getStartPosition()
            + ",\"position\":" + diagnostic.getPosition()
            + ",\"end\":" + diagnostic.getEndPosition()
            + ",\"message\":" + quote(message(diagnostic)) + "}";
        emit("diagnostic", json);
    }

    /** javac-style text: File.java:12: error: message, then the source line and a caret. */
    private static String format(Diagnostic<? extends JavaFileObject> diagnostic) {
        StringBuilder text = new StringBuilder();
        String file = fileName(diagnostic);
        if (!file.isEmpty()) {
            text.append(file);
            if (diagnostic.getLineNumber() > 0) text.append(':').append(diagnostic.getLineNumber());
            text.append(": ");
        }
        text.append(kindName(diagnostic.getKind())).append(": ").append(message(diagnostic)).append('\n');
        String content = contents.get(file);
        if (content != null && diagnostic.getLineNumber() > 0) {
            String[] lines = content.split("\n", -1);
            int lineIndex = (int) diagnostic.getLineNumber() - 1;
            if (lineIndex < lines.length) {
                String line = lines[lineIndex].replace("\r", "");
                text.append(line).append('\n');
                long column = Math.max(1, diagnostic.getColumnNumber());
                StringBuilder caret = new StringBuilder();
                for (int index = 1; index < column && index <= line.length(); index++) {
                    caret.append(line.charAt(index - 1) == '\t' ? '\t' : ' ');
                }
                text.append(caret).append("^\n");
            }
        }
        return text.toString();
    }

    private static String quote(String value) {
        StringBuilder out = new StringBuilder("\"");
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            switch (character) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (character < 0x20) out.append(String.format("\\u%04x", (int) character));
                    else out.append(character);
            }
        }
        return out.append('"').toString();
    }

    /** Hides JavaLab's own frames so a student's stack trace ends at their main method. */
    private static void trimStackTrace(Throwable error) {
        StackTraceElement[] frames = error.getStackTrace();
        int keep = frames.length;
        for (int index = 0; index < frames.length; index++) {
            String name = frames[index].getClassName();
            if (name.startsWith("sun.reflect.") || name.startsWith("java.lang.reflect.")
                    || name.startsWith("jdk.internal.reflect.") || name.startsWith("dev.javalab.")) {
                keep = index;
                break;
            }
        }
        error.setStackTrace(java.util.Arrays.copyOf(frames, keep));
    }

    private static void runProgram(Path classesDirectory, String mainClass, String[] args, String stdin) throws IOException {
        PrintStream originalOut = System.out;
        PrintStream originalError = System.err;
        java.io.InputStream originalIn = System.in;
        // The streams stay open until the end, so a stack trace printed in a catch block still reaches the console.
        PrintStream output = new PrintStream(new ChannelOutputStream("program"), true, "UTF-8");
        PrintStream errors = new PrintStream(new ChannelOutputStream("program-error"), true, "UTF-8");
        boolean success = false;
        try (URLClassLoader loader = new URLClassLoader(new URL[] { classesDirectory.toUri().toURL() }, Runner.class.getClassLoader())) {
            System.setOut(output);
            System.setErr(errors);
            System.setIn(new ByteArrayInputStream(stdin.getBytes(StandardCharsets.UTF_8)));
            Class<?> entryPoint = Class.forName(mainClass, true, loader);
            Method main = entryPoint.getMethod("main", String[].class);
            main.setAccessible(true);
            main.invoke(null, (Object) args);
            success = true;
        } catch (InvocationTargetException error) {
            Throwable cause = error.getCause() == null ? error : error.getCause();
            trimStackTrace(cause);
            output.flush();
            errors.print("Exception in thread \"main\" ");
            cause.printStackTrace(errors);
        } catch (Throwable error) {
            output.flush();
            error.printStackTrace(errors);
        } finally {
            output.flush();
            errors.flush();
            System.setOut(originalOut);
            System.setErr(originalError);
            System.setIn(originalIn);
        }
        emit("program-result", success ? "success" : "failure");
    }

    /** One editor file: its name and text. */
    private static final class Source {
        final String fileName;
        final String content;

        Source(String fileName, String content) {
            this.fileName = fileName;
            this.content = content;
        }
    }

    private static final class ChannelWriter extends java.io.Writer {
        private final String channel;
        private final StringBuilder buffer = new StringBuilder();

        private ChannelWriter(String channel) { this.channel = channel; }

        @Override public void write(char[] characters, int offset, int length) {
            buffer.append(characters, offset, length);
            int newline;
            while ((newline = buffer.indexOf("\n")) >= 0) {
                emit(channel, buffer.substring(0, newline + 1));
                buffer.delete(0, newline + 1);
            }
        }

        @Override public void flush() {
            if (buffer.length() > 0) {
                emit(channel, buffer.toString());
                buffer.setLength(0);
            }
        }

        @Override public void close() { flush(); }
    }

    private static final class ChannelOutputStream extends OutputStream {
        private final ChannelWriter writer;
        private final java.io.ByteArrayOutputStream pending = new java.io.ByteArrayOutputStream();

        private ChannelOutputStream(String channel) { writer = new ChannelWriter(channel); }

        @Override public void write(int value) {
            pending.write(value);
            if (value == '\n') drain();
        }

        @Override public void write(byte[] values, int offset, int length) {
            pending.write(values, offset, length);
            drain();
        }

        private void drain() {
            String text = new String(pending.toByteArray(), StandardCharsets.UTF_8);
            pending.reset();
            char[] characters = text.toCharArray();
            writer.write(characters, 0, characters.length);
        }

        @Override public void flush() { drain(); writer.flush(); }
        @Override public void close() { flush(); }
    }
}
