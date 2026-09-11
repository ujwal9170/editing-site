import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  initialEdit,
  validateEdit,
  instagramUrl,
} from "../shared/validation.mjs";
import { createRepository } from "../server/repository.mjs";
import { createApp } from "../server/app.mjs";
import "../public/audio/dsp.js";

test("URL normalization rejects non-Instagram and credential-bearing URLs", () => {
  assert.equal(
    instagramUrl("https://instagram.com/reel/ABC_123/?igsh=123"),
    "https://www.instagram.com/reel/ABC_123/",
  );
  for (const url of [
    "http://instagram.com/reel/ABC123/",
    "https://instagram.com.evil.test/reel/ABC123/",
    "https://user:pass@instagram.com/reel/ABC123/",
    "https://instagram.com:4430/reel/ABC123/",
    "file:///etc/passwd",
    "https://instagram.com/accounts/login/",
  ])
    assert.throws(() => instagramUrl(url));
});
test("edit validation rejects out-of-bounds crops, overlaps and an empty timeline", () => {
  const edit = initialEdit(10000);
  assert.deepEqual(validateEdit(edit, 10000), edit);
  for (const ratio of ["1:1", "4:5", "16:9"]) {
    assert.throws(() =>
      validateEdit(
        { ...edit, canvas: { ...edit.canvas, aspectRatio: ratio } },
        10000,
      ),
    );
  }
  assert.throws(() =>
    validateEdit(
      { ...edit, crop: { x: 0.9, y: 0, width: 0.5, height: 1 } },
      10000,
    ),
  );
  assert.throws(() =>
    validateEdit(
      {
        ...edit,
        segments: [
          { startMs: 0, endMs: 5000, enabled: true },
          { startMs: 4000, endMs: 10000, enabled: true },
        ],
      },
      10000,
    ),
  );
  assert.throws(() =>
    validateEdit(
      { ...edit, segments: [{ startMs: 0, endMs: 10000, enabled: false }] },
      10000,
    ),
  );
});
test("repository persists records across restarts", () => {
  const root = mkdtempSync(path.join(tmpdir(), "frame-test-"));
  let repo = createRepository(root);
  const item = repo.put("project", {
    name: "saved caption",
    caption: "Hinglish test",
  });
  repo.close();
  repo = createRepository(root);
  assert.equal(repo.get("project", item.id).caption, "Hinglish test");
  repo.close();
  rmSync(root, { recursive: true });
});
test("API rejects cross-site mutation, invalid downloads, and unknown assets", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "frame-api-"));
  const app = await createApp({ dataDir: root });
  try {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/downloads",
          headers: { origin: "https://evil.test" },
          payload: {
            url: "https://instagram.com/reel/ABC123",
            confirmed: true,
          },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/downloads",
          payload: { url: "https://example.com" },
        })
      ).statusCode,
      400,
    );
    assert.equal((await app.inject("/api/media")).statusCode, 200);
    assert.equal(
      (
        await app.inject(
          "/api/files/media/00000000-0000-4000-8000-000000000000/file",
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (await app.inject("/api/files/media/../../workspace.sqlite/file"))
        .statusCode,
      404,
    );
  } finally {
    await app.close();
    rmSync(root, { recursive: true });
  }
});
test("workspace password gates API files and issues an HttpOnly session", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "frame-auth-"));
  const original = process.env.WORKSPACE_PASSWORD;
  process.env.WORKSPACE_PASSWORD = "test-only-password";
  const app = await createApp({ dataDir: root });
  try {
    assert.equal((await app.inject("/api/media")).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth",
          payload: { password: "wrong" },
        })
      ).statusCode,
      401,
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/auth",
      payload: { password: "test-only-password" },
    });
    assert.match(login.headers["set-cookie"], /HttpOnly/);
    assert.equal(
      (
        await app.inject({
          url: "/api/media",
          headers: { cookie: login.headers["set-cookie"].split(";")[0] },
        })
      ).statusCode,
      200,
    );
  } finally {
    if (original === undefined) delete process.env.WORKSPACE_PASSWORD;
    else process.env.WORKSPACE_PASSWORD = original;
    await app.close();
    rmSync(root, { recursive: true });
  }
});
test("7680-point FFT roundtrip recovers non-power-of-two input", () => {
  const d = globalThis.AudioDSP,
    n = d.N,
    input = Float64Array.from(
      { length: n },
      (_, i) => Math.sin(i * 0.13) + Math.cos(i * 0.071),
    );
  const real = new Float64Array(n),
    imag = new Float64Array(n),
    result = new Float64Array(n),
    ri = new Float64Array(n);
  const p = d.plan(n);
  d.transform(p, input, new Float64Array(n), 0, 1, real, imag, 0, false);
  d.transform(p, real, imag, 0, 1, result, ri, 0, true);
  assert.ok(result.every((x, i) => Math.abs(x / n - input[i]) < 1e-9));
});
test("STFT/ISTFT preserves stereo low-frequency signal and sample alignment", () => {
  const d = globalThis.AudioDSP,
    l = Float32Array.from(
      { length: d.CHUNK },
      (_, i) => Math.sin((2 * Math.PI * 440 * i) / 44100) * 0.4,
    ),
    r = Float32Array.from(l, (x) => -x * 0.5);
  const [vl, vr] = d.istft(d.stft(l, r));
  let squared = 0;
  for (let i = 4000; i < l.length - 4000; i++) {
    squared += (vl[i] - l[i]) ** 2;
    assert.ok(Math.abs(vr[i] + vl[i] * 0.5) < 1e-6);
  }
  assert.ok(Math.sqrt(squared / (l.length - 8000)) < 0.0001);
  const wav = new DataView(d.wav(vl, vr));
  assert.equal(wav.getUint32(24, true), 44100);
  assert.equal(wav.getUint16(22, true), 2);
});
