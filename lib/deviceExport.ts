import {
  Input,
  ALL_FORMATS,
  BlobSource,
  Output,
  Mp4OutputFormat,
  BufferTarget,
  CanvasSource,
  VideoSampleSink,
  AudioSampleSink,
  AudioSampleSource,
  QUALITY_HIGH,
} from "mediabunny";
import type { InputAudioTrack } from "mediabunny";
import { dimensions, compose } from "./canvas";
import type { Edit } from "./types";

export function deviceExportSupported() {
  return (
    typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined"
  );
}

// The only restriction left is audio mode -- crop, background and text
// overlays are all composited on-device now via the same canvas functions
// the live preview uses. Keep this in sync with the server route's check.
export function deviceExportEligible(audioMode: string) {
  return ["original", "vocals-only"].includes(audioMode);
}

export async function renderOnDevice({
  videoUrl,
  audioUrl,
  edit,
  quality,
  sourceWidth,
  sourceHeight,
  onProgress,
  signal,
}: {
  videoUrl: string;
  audioUrl: string | null;
  edit: Edit;
  quality: "1080p" | "720p";
  sourceWidth: number;
  sourceHeight: number;
  onProgress: (s: string) => void;
  signal: AbortSignal;
}): Promise<Blob> {
  await document.fonts.ready;
  const [width, height] = dimensions(edit.canvas.aspectRatio, quality);
  const enabled = edit.segments.filter((s) => s.enabled);
  if (!enabled.length) throw new Error("Keep at least one clip.");

  onProgress("Loading source video…");
  const videoBlob = await fetch(videoUrl, { signal }).then((r) => {
    if (!r.ok) throw new Error("Source video unavailable");
    return r.blob();
  });
  const videoInput = new Input({
    source: new BlobSource(videoBlob),
    formats: ALL_FORMATS,
  });
  const videoTrack = await videoInput.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error("No video track found in the source.");

  let audioInput: Input | null = null;
  let audioTrack: InputAudioTrack | null = null;
  if (audioUrl) {
    onProgress("Loading processed audio…");
    const audioBlob = await fetch(audioUrl, { signal }).then((r) => {
      if (!r.ok) throw new Error("Processed audio unavailable");
      return r.blob();
    });
    audioInput = new Input({
      source: new BlobSource(audioBlob),
      formats: ALL_FORMATS,
    });
    audioTrack = await audioInput.getPrimaryAudioTrack();
  } else {
    audioTrack = await videoInput.getPrimaryAudioTrack();
  }

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;

  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const videoSource = new CanvasSource(canvas, {
    codec: "avc",
    quality: QUALITY_HIGH,
  });
  output.addVideoTrack(videoSource);
  const audioSource = audioTrack
    ? new AudioSampleSource({ codec: "aac", quality: QUALITY_HIGH })
    : null;
  if (audioSource) output.addAudioTrack(audioSource);

  await output.start();

  const videoSink = new VideoSampleSink(videoTrack);
  const audioSink = audioTrack ? new AudioSampleSink(audioTrack) : null;

  const totalDuration =
    enabled.reduce((t, s) => t + (s.endMs - s.startMs), 0) / 1000;
  let outputOffset = 0;

  for (const segment of enabled) {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const startSec = segment.startMs / 1000,
      endSec = segment.endMs / 1000;
    onProgress(
      `Rendering… ${Math.min(99, Math.round((outputOffset / totalDuration) * 100))}%`,
    );
    for await (const sample of videoSink.samples(startSec, endSec)) {
      const image = sample.toCanvasImageSource();
      compose(
        ctx,
        edit,
        width,
        height,
        image,
        sample.displayWidth,
        sample.displayHeight,
        sample.timestamp * 1000,
      );
      const outTimestamp = outputOffset + Math.max(0, sample.timestamp - startSec);
      await videoSource.add(outTimestamp, sample.duration);
      sample.close();
    }
    if (audioSink && audioSource) {
      for await (const sample of audioSink.samples(startSec, endSec)) {
        sample.setTimestamp(outputOffset + Math.max(0, sample.timestamp - startSec));
        await audioSource.add(sample);
        sample.close();
      }
    }
    outputOffset += endSec - startSec;
  }

  onProgress("Finalizing…");
  await output.finalize();
  videoInput.dispose();
  audioInput?.dispose();
  if (!target.buffer) throw new Error("Export failed to produce output.");
  return new Blob([target.buffer], { type: "video/mp4" });
}
