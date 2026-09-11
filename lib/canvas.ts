import type { Edit, Overlay } from "./types";
export const fonts = ["Inter", "DM Sans", "Montserrat", "Roboto"];
export const textColors = [
  "#FFFFFF",
  "#111827",
  "#FF4D6D",
  "#FACC15",
  "#38BDF8",
];
export const bgColors = ["#111827", "#FFFFFF", "#7C3AED", "#FF4D6D", "#38BDF8"];
export function dimensions(ratio: string): [number, number] {
  return [1080, 1920];
}
export function background(
  ctx: CanvasRenderingContext2D,
  edit: Edit,
  width: number,
  height: number,
) {
  const bg = edit.canvas.background;
  ctx.fillStyle = bg.colors[0];
  if (bg.type === "gradient") {
    const angle = (bg.angle * Math.PI) / 180,
      dx = Math.sin(angle),
      dy = -Math.cos(angle),
      reach = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
    const gradient = ctx.createLinearGradient(
      width / 2 - dx * reach,
      height / 2 - dy * reach,
      width / 2 + dx * reach,
      height / 2 + dy * reach,
    );
    bg.colors.forEach((color, i) =>
      gradient.addColorStop(i / Math.max(1, bg.colors.length - 1), color),
    );
    ctx.fillStyle = gradient;
  }
  ctx.fillRect(0, 0, width, height);
}
export function text(
  ctx: CanvasRenderingContext2D,
  t: Overlay,
  width: number,
  height: number,
) {
  const scale = width / 1080;
  ctx.font = `700 ${t.size * scale}px "${t.font}"`;
  ctx.fillStyle = t.color;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const lines = t.text.split("\n");
  lines.forEach((line, i) =>
    ctx.fillText(
      line,
      t.x * width,
      t.y * height + i * t.size * scale * 1.25,
      width * 0.94,
    ),
  );
}
export function preview(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  edit: Edit,
) {
  const [width, height] = dimensions(edit.canvas.aspectRatio);
  if (ctx.canvas.width !== width) ctx.canvas.width = width;
  if (ctx.canvas.height !== height) ctx.canvas.height = height;
  background(ctx, edit, width, height);
  if (video.readyState >= 2) {
    const c = edit.crop,
      sw = Math.max(2, Math.floor((video.videoWidth * c.width) / 2) * 2),
      sh = Math.max(2, Math.floor((video.videoHeight * c.height) / 2) * 2);
    const sx = Math.min(
        video.videoWidth - sw,
        Math.floor((video.videoWidth * c.x) / 2) * 2,
      ),
      sy = Math.min(
        video.videoHeight - sh,
        Math.floor((video.videoHeight * c.y) / 2) * 2,
      );
    const scale = Math.min(width / sw, height / sh);
    const w = Math.floor((sw * scale) / 2) * 2,
      h = Math.floor((sh * scale) / 2) * 2;
    ctx.drawImage(
      video,
      sx,
      sy,
      sw,
      sh,
      (width - w) / 2,
      (height - h) / 2,
      w,
      h,
    );
  }
  edit.textOverlays
    .filter(
      (t) =>
        video.currentTime * 1000 >= t.startMs &&
        video.currentTime * 1000 <= t.endMs,
    )
    .forEach((t) => text(ctx, t, width, height));
}
export async function artwork(edit: Edit) {
  await document.fonts.ready;
  const [width, height] = dimensions(edit.canvas.aspectRatio);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  background(ctx, edit, width, height);
  const bg = canvas.toDataURL("image/png");
  const overlays = edit.textOverlays.map((t) => {
    ctx.clearRect(0, 0, width, height);
    text(ctx, t, width, height);
    return canvas.toDataURL("image/png");
  });
  return { background: bg, overlays };
}
