// Tunnel + dev server, poora Node me.
//
// Kyun Node: batch me cloudflared ka output parse karna baar baar toota --
// node "C:\Program Files\..." me hai aur `for /f` ke andar cmd quotes kha jaata
// hai, aur log file ko doosre process se padhne me bhi timing/locking ke issue
// aate hain. Yahan cloudflared seedha child process hai, uska output live padha
// jaata hai, aur woh is process ke saath hi marta hai.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const cloudflared = path.join(root, ".tools", "cloudflared.exe");
const envPath = path.join(root, ".env");
const readEnv = () => (existsSync(envPath) ? readFileSync(envPath, "utf8") : "");
const port = /^\s*WEB_PORT\s*=\s*(\d+)/m.exec(readEnv())?.[1] || "4174";

if (!existsSync(cloudflared)) {
  console.error(`[X] cloudflared nahi mila: ${cloudflared}`);
  process.exit(1);
}

console.log(`    Tunnel khul raha hai -> http://127.0.0.1:${port}`);
const tunnel = spawn(
  cloudflared,
  ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`],
  { windowsHide: true },
);

const URL_PATTERN = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;
let log = "";
let url = null;

function onOutput(chunk) {
  if (url) return;
  // Sirf aakhri thoda output rakhte hain -- tunnel ghanton chal sakta hai.
  log = (log + chunk).slice(-20000);
  const found = log.match(URL_PATTERN);
  if (found) begin(found[0]);
}
tunnel.stdout.on("data", onOutput);
tunnel.stderr.on("data", onOutput);
tunnel.on("error", (error) => {
  console.error(`[X] cloudflared chala hi nahi: ${error.message}`);
  finish(1);
});

const deadline = setTimeout(() => {
  if (url) return;
  console.error("\n[X] Tunnel ka URL nahi mila. cloudflared ne ye kaha:\n");
  console.error(log || "(koi output nahi)");
  finish(1);
}, 60_000);

function finish(code) {
  clearTimeout(deadline);
  if (!tunnel.killed) tunnel.kill();
  process.exit(code);
}

function begin(found) {
  url = found;
  clearTimeout(deadline);

  // PUBLIC_ORIGIN dono taraf chahiye: Fastify isi se origin check karta hai aur
  // cookie pe Secure lagata hai, aur next.config.mjs isi se allowedDevOrigins
  // banata hai. Quick tunnel har run pe naya URL deta hai, isliye har baar
  // likhna padta hai. Baaki lines chhedte nahi -- password wali line waisi rahe.
  if (existsSync(envPath)) {
    if (!existsSync(`${envPath}.bak`)) copyFileSync(envPath, `${envPath}.bak`);
    const kept = readEnv()
      .split(/\r?\n/)
      .filter((line) => line.trim() && !/^\s*PUBLIC_ORIGIN\s*=/.test(line));
    kept.push(`PUBLIC_ORIGIN=${url}`);
    writeFileSync(envPath, `${kept.join("\r\n")}\r\n`);
  }

  console.log("\n============================================");
  console.log("  Phone pe ye link kholo:\n");
  console.log(`      ${url}\n`);
  console.log("============================================\n");
  console.log(`    Laptop pe: http://127.0.0.1:${port}`);
  console.log("    Band karne ke liye is window me Ctrl+C.\n");

  // Laptop ka browser thodi der baad, jab Next compile kar chuka ho.
  setTimeout(() => {
    spawn("cmd", ["/c", "start", "", `http://127.0.0.1:${port}`], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  }, 15_000).unref();

  const dev = spawn(process.execPath, ["scripts/dev.mjs"], { stdio: "inherit" });
  dev.on("exit", (code) => finish(code || 0));
  dev.on("error", (error) => {
    console.error(`[X] Dev server start nahi hua: ${error.message}`);
    finish(1);
  });
}

process.on("SIGINT", () => finish(0));
process.on("SIGTERM", () => finish(0));
