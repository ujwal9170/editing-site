import { test } from "node:test";
import assert from "node:assert/strict";
import { createExportQueue } from "../lib/exportQueue.mjs";
import {
  centringPan,
  CENTRED_EPSILON,
  clampPan,
  cropGeometry,
  exportTimeline,
  frameTimes,
  magnetToCentre,
} from "../shared/export.mjs";
const boxOf = (crop, width, height) => {
  const g = cropGeometry(crop, 1920, 1080, width, height);
  return {
    x: g.drawX / width,
    y: g.drawY / height,
    width: g.drawWidth / width,
    height: g.drawHeight / height,
  };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
test("device crop follows latest stable-window positioning at both resolutions", () => {
  for (const width of [720, 1080]) {
    const height = (width * 16) / 9;
    const full = cropGeometry(
      { x: 0, y: 0, width: 1, height: 1 },
      1920,
      1080,
      width,
      height,
    );
    const left = cropGeometry(
      { x: 0.25, y: 0, width: 0.75, height: 1 },
      1920,
      1080,
      width,
      height,
    );
    assert.equal(left.drawX + left.drawWidth, full.drawX + full.drawWidth);
    assert.equal(left.drawY, full.drawY);
    assert.equal(left.drawHeight, full.drawHeight);
  }
});
test("panning moves the whole frame and resolves the same at both qualities", () => {
  const crop = { x: 0.25, y: 0, width: 0.75, height: 1 };
  const placed = [];
  for (const width of [720, 1080]) {
    const height = (width * 16) / 9;
    const still = cropGeometry(crop, 1920, 1080, width, height);
    const panned = cropGeometry(crop, 1920, 1080, width, height, {
      x: -0.1,
      y: 0.25,
    });
    // A pan is a translation only: same source pixels, same drawn size.
    assert.equal(panned.left, still.left);
    assert.equal(panned.top, still.top);
    assert.equal(panned.drawWidth, still.drawWidth);
    assert.equal(panned.drawHeight, still.drawHeight);
    assert.equal(panned.drawX, still.drawX - 0.1 * width);
    assert.equal(panned.drawY, still.drawY + 0.25 * height);
    // An absent or malformed offset has to mean "no pan", not NaN, because
    // that is exactly what every project saved before panning looks like.
    for (const offset of [undefined, {}, { x: null, y: "nope" }])
      assert.equal(
        cropGeometry(crop, 1920, 1080, width, height, offset).drawX,
        still.drawX,
      );
    placed.push(panned.drawX / width, panned.drawY / height);
  }
  assert.deepEqual(placed.slice(0, 2), placed.slice(2));
});

test("centring pan puts a cropped frame in the middle of the canvas", () => {
  // Cropping the top third leaves the picture sitting low; offset zero is not
  // the middle, which is why the drag's magnet has to aim at this value.
  const box = boxOf({ x: 0, y: 0.3, width: 1, height: 0.7 }, 1080, 1920);
  const centre = centringPan(box);
  assert.ok(centre.y < 0, "a low frame must be pulled upwards");
  const middle = box.y + centre.y + box.height / 2;
  assert.ok(Math.abs(middle - 0.5) < 1e-9, `centred at ${middle}`);
  // An uncropped frame is already centred, give or take the half-pixel that
  // rounding the drawn height to an even number leaves over.
  const untouched = centringPan(
    boxOf({ x: 0, y: 0, width: 1, height: 1 }, 1080, 1920),
  );
  assert.ok(
    Math.abs(untouched.y) < CENTRED_EPSILON,
    `untouched frame drifted by ${untouched.y}`,
  );
});

test("the centre magnet pulls near the line, releases past it and never jumps", () => {
  assert.equal(magnetToCentre(0), 0);
  // Inside the window the value is pulled towards centre, never past it.
  for (const v of [0.005, 0.01, 0.02, 0.03, 0.05]) {
    assert.ok(magnetToCentre(v) <= v, `${v} must not be pushed outwards`);
    // Signed zero makes strictEqual unhappy where the pull collapses to centre.
    assert.ok(magnetToCentre(-v) === -magnetToCentre(v), `asymmetric at ${v}`);
  }
  // Close enough is exactly centred, so a "centred" edit really is centred.
  assert.equal(magnetToCentre(CENTRED_EPSILON * 0.5), 0);
  // Outside the window the finger wins completely.
  assert.equal(magnetToCentre(0.2), 0.2);
  // Continuous at the boundary: no visible jump as the pull lets go.
  const window = 0.06;
  assert.ok(Math.abs(magnetToCentre(window) - window) < 1e-12);
  assert.ok(Math.abs(magnetToCentre(window - 1e-9) - window) < 1e-6);
});

test("a pan can leave the frame off-centre but never off-screen", () => {
  const box = boxOf({ x: 0, y: 0.25, width: 1, height: 0.5 }, 1080, 1920);
  for (const wild of [
    { x: 9, y: 9 },
    { x: -9, y: -9 },
  ]) {
    const pan = clampPan(wild, box);
    const top = box.y + pan.y,
      left = box.x + pan.x;
    assert.ok(top + box.height > 0 && top < 1, `vertical ${top}`);
    assert.ok(left + box.width > 0 && left < 1, `horizontal ${left}`);
  }
  // A pan already within bounds is left exactly alone.
  assert.deepEqual(clampPan({ x: 0, y: -0.1 }, box), { x: 0, y: -0.1 });
});

test("cuts share one output frame grid and never include the removed middle", () => {
  const { ranges, duration } = exportTimeline([
    { startMs: 0, endMs: 2000, enabled: true },
    { startMs: 2000, endMs: 4000, enabled: false },
    { startMs: 4000, endMs: 6000, enabled: true },
  ]);
  const times = [...frameTimes(ranges, duration)];
  assert.equal(times.length, 120);
  assert.equal(times[60].sourceTime, 4);
  assert.ok(times.every((t) => t.sourceTime < 2 || t.sourceTime >= 4));
});

test("exports use immutable snapshots and execute strictly serially", async () => {
  const started = [],
    release = [];
  const queue = createExportQueue(async (task) => {
    started.push(task.project.name);
    await new Promise((r) => release.push(r));
    return task.project.name;
  });
  const task = { project: { name: "First" }, quality: "720p" };
  queue.add(task);
  task.project.name = "Changed later";
  queue.add({ project: { name: "Second" }, quality: "1080p" });
  assert.deepEqual(started, ["First"]);
  release.shift()();
  await tick();
  assert.deepEqual(started, ["First", "Second"]);
  release.shift()();
  await tick();
  assert.deepEqual(
    queue.list().map((r) => r.result),
    ["First", "Second"],
  );
});
test("cancel queued work and terminate current work before starting next", async () => {
  const started = [];
  const queue = createExportQueue(async (task, { signal }) => {
    started.push(task.project.name);
    if (task.project.name === "First")
      await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      );
  });
  const first = queue.add({ project: { name: "First" } });
  const second = queue.add({ project: { name: "Second" } });
  queue.add({ project: { name: "Third" } });
  queue.cancel(second);
  queue.cancel(first);
  await tick();
  assert.deepEqual(started, ["First", "Third"]);
  assert.deepEqual(
    queue.list().map((r) => r.status),
    ["cancelled", "cancelled", "done"],
  );
});
test("failure does not block next job and saving cannot be cancelled", async () => {
  let finish;
  const queue = createExportQueue(async (task, control) => {
    if (task.project.name === "Broken") throw new Error("Unsupported codec");
    control.saving();
    await new Promise((r) => (finish = r));
  });
  queue.add({ project: { name: "Broken" } });
  const id = queue.add({ project: { name: "Good" } });
  await tick();
  assert.equal(queue.list()[0].status, "failed");
  assert.equal(queue.cancel(id), false);
  finish();
  await tick();
  assert.equal(queue.list()[1].status, "done");
});
test("sign-out clears tasks and prevents old work starting queued tasks", async () => {
  let count = 0;
  const queue = createExportQueue(async (_, { signal }) => {
    count++;
    await new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason)),
    );
  });
  queue.add({ project: { name: "One" } });
  queue.add({ project: { name: "Two" } });
  queue.clear();
  await tick();
  assert.equal(count, 1);
  assert.deepEqual(queue.list(), []);
});
