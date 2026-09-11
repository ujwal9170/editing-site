import { spawn } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import path from "node:path";

export function createQueue(repo, root) {
  const pending = [];
  let busy = false;
  const python = process.env.PYTHON || "python";
  const worker = path.resolve("worker/media.py");
  for (const job of repo.list("job"))
    if (["queued", "running"].includes(job.status))
      repo.put("job", {
        ...job,
        status: "failed",
        error: "Server restarted. Please submit this operation again.",
      });
  async function drain() {
    if (busy || !pending.length) return;
    busy = true;
    const { job, payload, done, failed } = pending.shift();
    const specPath = path.join(root, `${job.id}.job.json`);
    try {
      repo.put("job", { ...job, status: "running", progress: 5 });
      await writeFile(specPath, JSON.stringify(payload));
      const result = await new Promise((resolve, reject) => {
        const proc = spawn(python, [worker, specPath], { windowsHide: true });
        let output = "",
          error = "";
        const timeout = setTimeout(() => {
          proc.kill();
          reject(new Error("Processing timed out. Try a shorter video."));
        }, 30 * 60_000);
        proc.stdout.on("data", (b) => {
          output = (output + b).slice(-100_000);
        });
        proc.stderr.on("data", (b) => {
          error = (error + b).slice(-3000);
        });
        proc.on("error", (e) => {
          clearTimeout(timeout);
          reject(e);
        });
        proc.on("close", (code) => {
          clearTimeout(timeout);
          if (code !== 0)
            reject(new Error(error || "Media processing failed."));
          else {
            try {
              resolve(JSON.parse(output.trim().split("\n").at(-1)));
            } catch {
              reject(new Error("Invalid worker response"));
            }
          }
        });
      });
      const resultId = await done(result);
      repo.put("job", { ...job, status: "ready", progress: 100, resultId });
    } catch (e) {
      await failed?.();
      repo.put("job", {
        ...job,
        status: "failed",
        error: String(e.message).slice(-1200),
        progress: 0,
      });
    } finally {
      await rm(specPath, { force: true });
      busy = false;
      void drain();
    }
  }
  return {
    add(type, payload, done, failed) {
      const job = repo.put("job", { type, status: "queued", progress: 0 });
      pending.push({ job, payload, done, failed });
      void drain();
      return job;
    },
    get busy() {
      return busy || pending.length > 0;
    },
  };
}
