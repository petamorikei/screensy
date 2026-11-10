// Copies the static files of the website into public/, which Wrangler uploads as the assets of the Worker. The
// "build" script runs the build of the website first, so that public/ never gets an old screensy.js.
import { cpSync, mkdirSync, rmSync } from "node:fs";

const website = new URL("../screensy-website/", import.meta.url);
const out = new URL("./public/", import.meta.url);

rmSync(out, { recursive: true, force: true });
mkdirSync(out);

for (const file of ["screensy.js", "screensy.js.map", "screensy.css", "screensy.css.map"]) {
  cpSync(new URL(file, website), new URL(file, out));
}

cpSync(new URL("translations/", website), new URL("translations/", out), { recursive: true });
