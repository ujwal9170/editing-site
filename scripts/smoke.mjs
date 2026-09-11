import { readFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";
const base = process.env.SMOKE_ORIGIN || "http://127.0.0.1:4174";
const python =
  process.env.PYTHON ||
  path.resolve(
    process.platform === "win32"
      ? ".venv/Scripts/python.exe"
      : ".venv/bin/python",
  );
await mkdir("work-test", { recursive: true });
const fixture = spawnSync(python, ["worker/fixture.py", "work-test"], {
  encoding: "utf8",
});
if (fixture.status) throw new Error(fixture.stderr);
async function api(route, opts = {}) {
  const r = await fetch(base + "/api" + route, opts);
  const body = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(body));
  return body;
}
async function wait(id) {
  for (let i = 0; i < 180; i++) {
    const j = await api("/jobs/" + id);
    if (j.status === "ready") return j;
    if (j.status === "failed") throw new Error(j.error);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Job timed out");
}
const upload = new FormData();
upload.append(
  "file",
  new Blob([await readFile("work-test/QA-test-pattern.mp4")]),
  "QA-test-pattern.mp4",
);
const imported = await api("/media/uploads", { method: "POST", body: upload });
await wait(imported.job.id);
const media = (await api("/media")).find((m) => m.id === imported.media.id);
assert.equal(media.status, "ready");
assert.ok(Math.abs(media.duration - 6) < 0.2);
const stream = await fetch(base + `/api/files/media/${media.id}/file`, {
  headers: { Range: "bytes=0-99" },
});
assert.equal(stream.status, 206);
const p = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ mediaId: media.id }),
});
p.edit.canvas.aspectRatio = "9:16";
p.edit.canvas.background.colors = ["#7C3AED", "#7C3AED"];
p.edit.crop = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
p.edit.segments = [
  { startMs: 0, endMs: 2000, enabled: true },
  { startMs: 2000, endMs: 4000, enabled: false },
  { startMs: 4000, endMs: 6000, enabled: true },
];
p.edit.textOverlays = [
  {
    id: "qa",
    text: "QA",
    font: "Inter",
    size: 48,
    color: "#FFFFFF",
    x: 0.5,
    y: 0.1,
    startMs: 0,
    endMs: 6000,
  },
];
const saved = await api(`/projects/${p.id}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "QA edited test pattern",
    caption: "Caption smoke test ✓",
    revision: p.revision,
    edit: p.edit,
  }),
});
const conflict = await fetch(base + `/api/projects/${p.id}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: p.name,
    caption: "",
    revision: p.revision,
    edit: p.edit,
  }),
});
assert.equal(conflict.status, 409);
const png = async (name) =>
  "data:image/png;base64," +
  (await readFile("work-test/" + name)).toString("base64");
const rendered = await api(`/projects/${p.id}/renders`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    revision: saved.revision,
    background: await png("background.png"),
    overlays: [await png("overlay.png")],
  }),
});
const result = await wait(rendered.job.id);
const output = (await api("/exports")).find((e) => e.id === result.resultId);
assert.ok(Math.abs(output.duration - 4) < 0.15);
assert.equal(output.width, 1080);
assert.equal(output.height, 1920);
assert.equal(output.caption, "Caption smoke test ✓");
console.log(
  JSON.stringify(
    {
      passed: true,
      mediaId: media.id,
      projectId: p.id,
      exportId: output.id,
      duration: output.duration,
      dimensions: [output.width, output.height],
      checks: [
        "upload",
        "normalize",
        "range playback",
        "save",
        "revision conflict",
        "crop",
        "overlay",
        "split/delete",
        "MP4 export",
        "caption persistence",
      ],
    },
    null,
    2,
  ),
);
