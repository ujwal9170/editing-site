export async function separateAudio(
  url: string,
  mode: string,
  onProgress: (s: string) => void,
  signal: AbortSignal,
): Promise<Blob> {
  const response = await fetch("/models/Kim_Vocal_2.onnx", {
    method: "HEAD",
    signal,
  });
  if (!response.ok)
    throw new Error(
      "Audio model is not installed. Run pnpm setup:audio on the server, then try again.",
    );
  onProgress("Loading source audio…");
  const bytes = await fetch(url, { signal }).then((r) => {
    if (!r.ok) throw new Error("Source audio unavailable");
    return r.arrayBuffer();
  });
  const context = new AudioContext({ sampleRate: 44100 });
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(bytes);
  } finally {
    await context.close();
  }
  const offline = new OfflineAudioContext(
    2,
    Math.ceil(decoded.duration * 44100),
    44100,
  );
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const audio = await offline.startRendering();
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  const left = audio.getChannelData(0).slice(),
    right = audio.getChannelData(1).slice();
  return new Promise((resolve, reject) => {
    const worker = new Worker("/audio/worker.js");
    function stop() {
      worker.terminate();
      signal.removeEventListener("abort", cancel);
    }
    function cancel() {
      stop();
      reject(new DOMException("Cancelled", "AbortError"));
    }
    signal.addEventListener("abort", cancel, { once: true });
    worker.onerror = (e) => {
      stop();
      reject(new Error(e.message));
    };
    worker.onmessage = ({ data }) => {
      if (data.progress) onProgress(data.progress);
      if (data.error) {
        stop();
        reject(new Error(data.error));
      }
      if (data.wav) {
        stop();
        resolve(new Blob([data.wav], { type: "audio/wav" }));
      }
    };
    worker.postMessage({ left, right, mode }, [left.buffer, right.buffer]);
  });
}
