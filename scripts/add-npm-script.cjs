// Tiny helper: add an npm script without fighting shell quoting.
//   node scripts/add-npm-script.cjs <name> <command>
const fs = require("fs");
const [, , name, command] = process.argv;
if (!name || !command) {
  console.error("usage: node scripts/add-npm-script.cjs <name> <command>");
  process.exit(2);
}
const pkgPath = "package.json";
const raw = fs.readFileSync(pkgPath, "utf8").replace(/^﻿/, "");
const pkg = JSON.parse(raw);
if (pkg.scripts[name] === command) {
  console.log(`unchanged: ${name}`);
  process.exit(0);
}
pkg.scripts[name] = command;
// Keep the file's existing 2-space style and trailing newline.
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
console.log(`added: ${name}`);
