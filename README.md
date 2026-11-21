# COMP 2001 Java lab

A browser-only Java editor for COMP 2001, built from JavaLab. It compiles with ECJ and runs with CheerpJ in the browser; nothing is sent to a server.

Features: live compiler checks with red underlines, a countdown timer, a toggle-comment button (Ctrl+/ or Cmd+/), resizable panels with the output on the right or below, and light and dark Memorial University themes.

Allow these in LockDown Browser: this site, cjrtnc.leaningtech.com (the CheerpJ runtime) and cdn.jsdelivr.net (the editor).

The runner (`browser/runtime/javalab-runner-2.jar`) is built from `runner-src/` with `./build-runner.sh`. Give the jar a new name when it changes, because GitHub Pages caches it.

The Memorial University logo in `img/` belongs to Memorial University of Newfoundland.
