// Assemble the Android app's web bundle (mobile/www) from the DESKTOP renderer — one code base:
//   src/renderer/{index.html, app.js, style.css} + src/config.json + assets/fonts
//   + mobile/web/{mobile-shim.js, mobile.js, mobile.css} and a generated version.js.
// index.html gets the phone viewport and the three extra tags; nothing else is changed.
// Usage: node mobile/build-www.mjs   (then: npx cap sync android, inside mobile/)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const out = path.join(here, "www");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "fonts"), { recursive: true });

const copy = (from, to) => fs.copyFileSync(path.join(root, from), path.join(out, to));
copy("src/renderer/app.js", "app.js");
copy("src/config.json", "config.json");
for (const f of fs.readdirSync(path.join(root, "assets/fonts"))) copy(`assets/fonts/${f}`, `fonts/${f}`);
for (const f of ["mobile-shim.js", "mobile.js", "mobile.css"]) fs.copyFileSync(path.join(here, "web", f), path.join(out, f));
fs.writeFileSync(path.join(out, "version.js"), `window.TD_MOBILE = { version: ${JSON.stringify(pkg.version)}, platform: "android" };\n`);

// Fonts sit next to the page in the bundle, not two folders up as in the desktop tree.
const css = fs.readFileSync(path.join(root, "src/renderer/style.css"), "utf8");
const css2 = css.replaceAll("../../assets/fonts/", "fonts/");
if (css2 === css) throw new Error("style.css font paths not found — update build-www.mjs");
fs.writeFileSync(path.join(out, "style.css"), css2);

let html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
const swap = (from, to) => {
  if (!html.includes(from)) throw new Error(`index.html: "${from}" not found — update build-www.mjs`);
  html = html.replace(from, to);
};
swap('<meta name="viewport" content="width=device-width, initial-scale=1.0">',
  '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">');
swap('<link rel="stylesheet" href="style.css">', '<link rel="stylesheet" href="style.css">\n  <link rel="stylesheet" href="mobile.css">');
swap('<script src="app.js"></script>',
  '<script src="version.js"></script>\n  <script src="mobile-shim.js"></script>\n  <script src="app.js"></script>\n  <script src="mobile.js"></script>');
swap('<html lang="id">', '<html lang="id" class="td-mobile">');
fs.writeFileSync(path.join(out, "index.html"), html);

// Gradle only looks at ANDROID_HOME or android/local.properties. Without either, point it at the default
// Windows SDK folder so `npm run apk:*` works from a plain shell (local.properties is machine-local, never packed).
const localProps = path.join(here, "android", "local.properties");
const defaultSdk = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Android", "Sdk");
if (!process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT && !fs.existsSync(localProps)
    && defaultSdk && fs.existsSync(defaultSdk) && fs.existsSync(path.dirname(localProps))) {
  fs.writeFileSync(localProps, `sdk.dir=${defaultSdk.replaceAll("\\", "/")}\n`);
  console.log(`android/local.properties -> sdk.dir=${defaultSdk}`);
}

const files = fs.readdirSync(out, { recursive: true }).filter((f) => fs.statSync(path.join(out, f)).isFile());
const kb = files.reduce((n, f) => n + fs.statSync(path.join(out, f)).size, 0) / 1024;
console.log(`mobile/www ready — TryDesk ${pkg.version}, ${files.length} files, ${kb.toFixed(0)} KB`);
