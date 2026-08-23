#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const vsixPath = path.join(root, `opencode-sidebar-tui-${version}.vsix`);
if (!existsSync(vsixPath)) {
  process.stderr.write(`missing ${vsixPath}\n`);
  process.exit(1);
}
const listing = execFileSync("unzip", ["-Z1", vsixPath], { encoding: "utf8" });
if (!/extension\/node_modules\/node-pty\//.test(listing)) {
  process.stderr.write("VSIX is missing node-pty; never package with --no-dependencies\n");
  process.exit(1);
}
if (!/node-pty\/(?:prebuilds|build|lib)\//.test(listing)) {
  process.stderr.write("VSIX node-pty is missing native/prebuild files\n");
  process.exit(1);
}
process.stdout.write(`ok: ${vsixPath} contains node-pty\n`);
