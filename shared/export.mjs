// Export resolution is independent of the edit's canonical 1080-wide canvas.
export function exportProfile(resolution = 720) {
  if (![720, 1080].includes(resolution)) throw new Error("Choose 720p or 1080p.");
  return { width: resolution, height: resolution === 720 ? 1280 : 1920, fps: 30,
    bitrate: resolution === 720 ? 4_000_000 : 8_000_000 };
}

export function exportTimeline(segments) {
  let duration = 0;
  const ranges = segments.filter((s) => s.enabled).map((s) => {
    const start = s.startMs / 1000, end = s.endMs / 1000;
    const range = { start, end, outputStart: duration };
    duration += end - start;
    return range;
  });
  return { ranges, duration };
}

// A single output frame grid avoids accumulating rounding errors at cuts.
export function* frameTimes(ranges, duration, fps = 30) {
  let segment = 0;
  for (let frame = 0; frame < Math.ceil(duration * fps - 1e-7); frame++) {
    const outputTime = frame / fps;
    while (segment + 1 < ranges.length && outputTime >= ranges[segment + 1].outputStart - 1e-9) segment++;
    const range = ranges[segment];
    yield { outputTime, sourceTime: range.start + outputTime - range.outputStart,
      duration: Math.min(1 / fps, duration - outputTime) };
  }
}

export function cropGeometry(crop, sourceWidth, sourceHeight, width, height) {
  const sw = Math.max(2, Math.floor(sourceWidth * crop.width / 2) * 2);
  const sh = Math.max(2, Math.floor(sourceHeight * crop.height / 2) * 2);
  const left = Math.max(0, Math.min(sourceWidth - sw, Math.floor(sourceWidth * crop.x / 2) * 2));
  const top = Math.max(0, Math.min(sourceHeight - sh, Math.floor(sourceHeight * crop.y / 2) * 2));
  // Match the latest stable-window crop: fit the full source, then hide its
  // cropped edges without enlarging or re-centering the remaining pixels.
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  return { left, top, width: sw, height: sh,
    drawX: (width - sourceWidth * scale) / 2 + left * scale,
    drawY: (height - sourceHeight * scale) / 2 + top * scale,
    drawWidth: Math.max(2, Math.floor(sw * scale / 2) * 2),
    drawHeight: Math.max(2, Math.floor(sh * scale / 2) * 2) };
}
