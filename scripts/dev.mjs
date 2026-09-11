import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
if (existsSync(".env")) process.loadEnvFile(".env");
const venv =
  process.platform === "win32"
    ? ".venv/Scripts/python.exe"
    : ".venv/bin/python";
if (!process.env.PYTHON && existsSync(venv))
  process.env.PYTHON = path.resolve(venv);
const production = process.argv.includes("--production");
const children = [
  spawn(process.execPath, ["server/index.mjs"], {
    stdio: "inherit",
    env: process.env,
  }),
  spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      production ? "start" : "dev",
      ...(!production ? ["--webpack"] : []),
      "-p",
      process.env.WEB_PORT || "4174",
      "-H",
      process.env.HOST || "127.0.0.1",
    ],
    { stdio: "inherit", env: process.env },
  ),
];
let closing = false;
function close(code = 0) {
  if (closing) return;
  closing = true;
  children.forEach((c) => c.kill());
  setTimeout(() => process.exit(code), 500);
}
children.forEach((c) => {
  c.on("error", (e) => {
    console.error(e);
    close(1);
  });
  c.on("exit", (c) => close(c || 0));
});
process.on("SIGINT", () => close());
process.on("SIGTERM", () => close());
