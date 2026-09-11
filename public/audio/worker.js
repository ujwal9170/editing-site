importScripts("/vendor/ort/ort.webgpu.min.js", "/audio/dsp.js");
const MODEL_HASH =
  "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b";
const report = (progress) => postMessage({ progress });
async function modelBytes() {
  let db;
  try {
    db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("frame-models", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("models");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const cached = await new Promise((resolve) => {
      const r = db.transaction("models").objectStore("models").get(MODEL_HASH);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
    });
    if (cached) return cached;
  } catch {
    /* Storage can be unavailable; inference still works. */
  }
  report("Downloading Kim Vocal 2…");
  const response = await fetch("/models/Kim_Vocal_2.onnx");
  if (!response.ok) throw new Error("Audio model download failed.");
  const buffer = await response.arrayBuffer();
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
  if (digest !== MODEL_HASH)
    throw new Error("Model checksum mismatch. Re-run setup:audio.");
  if (db) {
    try {
      db.transaction("models", "readwrite")
        .objectStore("models")
        .put(buffer, MODEL_HASH);
    } catch {}
  }
  return buffer;
}
self.onmessage = async ({ data }) => {
  let session;
  try {
    const { left, right, mode } = data,
      { CHUNK, BINS, FRAMES } = AudioDSP;
    const threads = crossOriginIsolated
      ? Math.max(
          1,
          Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2)),
        )
      : 1;
    ort.env.wasm.numThreads = threads;
    ort.env.wasm.wasmPaths = "/vendor/ort/";
    const bytes = await modelBytes();
    let gpu = false;
    if (navigator.gpu)
      try {
        report("Initializing WebGPU…");
        session = await ort.InferenceSession.create(bytes, {
          executionProviders: ["webgpu", "wasm"],
        });
        gpu = true;
      } catch {
        report("WebGPU unavailable. Switching to CPU…");
      }
    if (!session)
      session = await ort.InferenceSession.create(bytes, {
        executionProviders: ["wasm"],
      });
    const output = [
        new Float32Array(left.length),
        new Float32Array(left.length),
      ],
      weights = new Float32Array(left.length);
    const step = Math.floor(CHUNK * 0.75),
      overlap = CHUNK - step;
    const total = Math.max(
      1,
      Math.ceil(Math.max(0, left.length - CHUNK) / step) + 1,
    );
    const started = performance.now();
    async function infer(input) {
      const tensor = new ort.Tensor("float32", input, [1, 4, BINS, FRAMES]);
      try {
        const result = await session.run({ [session.inputNames[0]]: tensor });
        const out = result[session.outputNames[0]];
        if (out.data.length !== input.length)
          throw new Error("Unexpected model output shape.");
        const copy = Float32Array.from(out.data);
        Object.values(result).forEach((t) => t.dispose());
        return copy;
      } finally {
        tensor.dispose();
      }
    }
    for (let chunk = 0; chunk < total; chunk++) {
      const offset = chunk * step;
      report(
        `${gpu ? "WebGPU preferred" : `WASM · ${threads} threads`} · clip ${chunk + 1}/${total} · ${Math.round((performance.now() - started) / 1000)}s`,
      );
      const l = new Float32Array(CHUNK),
        r = new Float32Array(CHUNK);
      l.set(left.subarray(offset, offset + CHUNK));
      r.set(right.subarray(offset, offset + CHUNK));
      const input = AudioDSP.stft(l, r);
      let positive;
      try {
        positive = await infer(input);
      } catch (error) {
        if (!gpu) throw error;
        await session.release();
        session = await ort.InferenceSession.create(bytes, {
          executionProviders: ["wasm"],
        });
        gpu = false;
        report(
          `GPU inference failed. Retrying with WASM · ${threads} threads…`,
        );
        positive = await infer(input);
      }
      for (let i = 0; i < input.length; i++) input[i] = -input[i];
      const negative = await infer(input);
      for (let i = 0; i < positive.length; i++)
        positive[i] = (positive[i] - negative[i]) * 0.5;
      const [vl, vr] = AudioDSP.istft(positive);
      for (let i = 0; i < CHUNK && offset + i < left.length; i++) {
        let weight = 1;
        if (chunk > 0 && i < overlap)
          weight *= 0.5 - 0.5 * Math.cos((Math.PI * i) / overlap);
        if (chunk < total - 1 && i >= CHUNK - overlap)
          weight *= 0.5 - 0.5 * Math.cos((Math.PI * (CHUNK - i)) / overlap);
        output[0][offset + i] += vl[i] * weight;
        output[1][offset + i] += vr[i] * weight;
        weights[offset + i] += weight;
      }
    }
    for (let i = 0; i < left.length; i++)
      for (let channel = 0; channel < 2; channel++) {
        const vocal = output[channel][i] / Math.max(1e-9, weights[i]);
        output[channel][i] =
          mode === "vocals-only"
            ? vocal
            : (channel ? right[i] : left[i]) - vocal;
      }
    const wav = AudioDSP.wav(...output);
    postMessage({ wav }, [wav]);
  } catch (error) {
    postMessage({ error: error.message || String(error) });
  } finally {
    await session?.release();
  }
};
