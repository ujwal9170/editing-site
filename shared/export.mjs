// Export resolution is independent of the edit's canonical 1080-wide canvas.
export function exportProfile(resolution = 720) {
  if (![720, 1080].includes(resolution))
    throw new Error("Choose 720p or 1080p.");
  return {
    width: resolution,
    height: resolution === 720 ? 1280 : 1920,
    fps: 30,
    bitrate: resolution === 720 ? 4_000_000 : 8_000_000,
  };
}

export function exportTimeline(segments) {
  let duration = 0;
  const ranges = segments
    .filter((s) => s.enabled)
    .map((s) => {
      const start = s.startMs / 1000,
        end = s.endMs / 1000;
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
    while (
      segment + 1 < ranges.length &&
      outputTime >= ranges[segment + 1].outputStart - 1e-9
    )
      segment++;
    const range = ranges[segment];
    yield {
      outputTime,
      sourceTime: range.start + outputTime - range.outputStart,
      duration: Math.min(1 / fps, duration - outputTime),
    };
  }
}

// `offset` pans the drawn video around the canvas as a fraction of the canvas
// itself, so one saved edit lands identically at 720p and 1080p. It is applied
// after the crop window is placed, so panning never changes which source pixels
// are visible -- only where that rectangle sits on the background.
export function cropGeometry(
  crop,
  sourceWidth,
  sourceHeight,
  width,
  height,
  offset = { x: 0, y: 0 },
) {
  const sw = Math.max(2, Math.floor((sourceWidth * crop.width) / 2) * 2);
  const sh = Math.max(2, Math.floor((sourceHeight * crop.height) / 2) * 2);
  const left = Math.max(
    0,
    Math.min(sourceWidth - sw, Math.floor((sourceWidth * crop.x) / 2) * 2),
  );
  const top = Math.max(
    0,
    Math.min(sourceHeight - sh, Math.floor((sourceHeight * crop.y) / 2) * 2),
  );
  // Match the latest stable-window crop: fit the full source, then hide its
  // cropped edges without enlarging or re-centering the remaining pixels.
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const panX = Number(offset?.x) || 0,
    panY = Number(offset?.y) || 0;
  return {
    left,
    top,
    width: sw,
    height: sh,
    drawX: (width - sourceWidth * scale) / 2 + left * scale + panX * width,
    drawY: (height - sourceHeight * scale) / 2 + top * scale + panY * height,
    drawWidth: Math.max(2, Math.floor((sw * scale) / 2) * 2),
    drawHeight: Math.max(2, Math.floor((sh * scale) / 2) * 2),
  };
}

// --- Pan gesture feel -------------------------------------------------------
// Dragging the video is meant to favour the centre line without ever locking to
// it. Inside a small window either side of centre the value is eased toward 0
// with a power curve, so a finger that lets go near the middle settles exactly
// on the middle, while a deliberate drag past the window still positions
// freely. The curve is continuous at the window edge, so there is no jump at
// the moment the pull releases.
export const CENTRE_WINDOW = 0.06;
// Roughly three pixels of a 1920-tall canvas: close enough that nobody can see
// the difference, and comfortably wider than the sub-pixel error the even-size
// rounding above leaves behind, so a freshly opened edit reads as centred
// rather than as a pan of three quarters of a pixel.
export const CENTRED_EPSILON = 0.0015;
export function magnetToCentre(value, window = CENTRE_WINDOW) {
  const distance = Math.abs(value);
  if (!(window > 0) || !Number.isFinite(value) || distance >= window)
    return value;
  const eased = window * (distance / window) ** 2.4;
  // Close enough is exactly centred, so a centred edit really is centred rather
  // than off by a rounding error nobody asked for.
  return eased < CENTRED_EPSILON ? 0 : Math.sign(value) * eased;
}
// The smallest share of the drawn video that has to remain on canvas, so a pan
// can nudge the frame off-centre but never lose it off-screen entirely.
export const MIN_VISIBLE = 0.25;
// `box` is the un-panned drawn video in canvas fractions: { x, y, width, height }.
export function clampPan(pan, box) {
  const axis = (value, start, span) => {
    const keep = Math.min(span, Math.max(0.05, span * MIN_VISIBLE));
    const low = keep - start - span,
      high = 1 - keep - start;
    return Math.min(1, Math.max(-1, Math.min(high, Math.max(low, value))));
  };
  return {
    x: axis(Number(pan?.x) || 0, box.x, box.width),
    y: axis(Number(pan?.y) || 0, box.y, box.height),
  };
}
// The pan that puts the drawn video exactly in the middle of the canvas. With a
// crop applied this is NOT zero -- zero leaves the frame wherever the crop left
// it -- so this, not the origin, is the line a drag should be drawn towards.
export function centringPan(box) {
  return {
    x: 0.5 - (box.x + box.width / 2),
    y: 0.5 - (box.y + box.height / 2),
  };
}
