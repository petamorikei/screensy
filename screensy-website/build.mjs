// Bundles the browser client (src/, the shared protocol and Zod) into screensy.js, a classic script that the pages
// load with a plain <script>. Type checking is separate: `pnpm typecheck` runs tsc.
import { build } from "esbuild";

// LibreJS reads this notice at the top of the script. The source map carries the sources (sourcesContent).
const banner = `/**
 * @source  ./screensy.js.map
 *
 * @licstart  The following is the entire license notice for the JavaScript
 * code in this page.
 *
 * Copyright (C) 2021  Stef Gijsberts, Marijn van Wezel
 *
 * The JavaScript code in this page is free software: you can redistribute it
 * and/or modify it under the terms of the GNU General Public License (GNU GPL)
 * as published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.  The code is distributed
 * WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU GPL for more details.
 *
 * As additional permission under GNU GPL version 3 section 7, you may
 * distribute non-source (e.g., minimized or compacted) forms of that code
 * without the copy of the GNU GPL normally required by section 4, provided you
 * include this license notice and a URL through which recipients can access
 * the Corresponding Source.
 *
 * @licend  The above is the entire license notice for the JavaScript code in
 * this page.
 */`;

await build({
  entryPoints: ["src/main.ts"],
  outfile: "screensy.js",
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  sourcemap: true,
  banner: { js: banner },
  logLevel: "warning",
});
