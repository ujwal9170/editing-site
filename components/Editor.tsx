"use client";
import { useEffect, useRef, useState } from "react";
import {
  Play,
  Pause,
  Scissors,
  Trash2,
  Undo2,
  Redo2,
  Download,
  Crop,
  Type,
  Palette,
  Music2,
  Captions,
  Plus,
  LoaderCircle,
  Save,
  ChevronDown,
  Smartphone,
  Server,
} from "lucide-react";
import { api, fileUrl, clock, awaitJob } from "@/lib/api";
import {
  artwork,
  preview,
  fonts,
  textColors,
  bgColors,
  dimensions,
} from "@/lib/canvas";
import type { Edit, Overlay, Project } from "@/lib/types";

export default function Editor({
  initial,
  onError,
  onExport,
  onSaved,
}: {
  initial: Project;
  onError: (e: string) => void;
  onExport: () => void;
  onSaved: (p: Project) => void;
}) {
  const [edit, setEdit] = useState<Edit>(initial.edit),
    [name, setName] = useState(initial.name),
    [caption, setCaption] = useState(initial.caption),
    [tab, setTab] = useState("crop"),
    [time, setTime] = useState(0),
    [playing, setPlaying] = useState(false),
    [selected, setSelected] = useState(0),
    [saving, setSaving] = useState("Saved"),
    [rendering, setRendering] = useState(false);
  const [past, setPast] = useState<Edit[]>([]),
    [future, setFuture] = useState<Edit[]>([]),
    [audioStatus, setAudioStatus] = useState(""),
    [separating, setSeparating] = useState(false),
    [stem, setStem] = useState<{
      url: string;
      blob: Blob;
      mode: string;
    } | null>(null),
    [quality, setQuality] = useState<"1080p" | "720p">("1080p"),
    [destination, setDestination] = useState<"server" | "device">("server"),
    [exportMenuOpen, setExportMenuOpen] = useState(false),
    [deviceSupported, setDeviceSupported] = useState(false),
    [deviceEligible, setDeviceEligible] = useState(false);
  const video = useRef<HTMLVideoElement>(null),
    derived = useRef<HTMLAudioElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    current = useRef(edit),
    revision = useRef(initial.revision),
    saveChain = useRef<Promise<any>>(Promise.resolve()),
    abort = useRef<AbortController | null>(null),
    alive = useRef(true);
  const media = initial.media!,
    duration = media.duration;
  const latest = useRef({ edit, name, caption });
  latest.current = { edit, name, caption };
  const committed = useRef(
    JSON.stringify({
      edit: initial.edit,
      name: initial.name,
      caption: initial.caption,
    }),
  );
  current.current = edit;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      abort.current?.abort();
      const snapshot = latest.current;
      if (JSON.stringify(snapshot) !== committed.current) {
        saveChain.current = saveChain.current
          .catch(() => {})
          .then(async () => {
            if (JSON.stringify(snapshot) === committed.current) return;
            const p = await api<Project>(`/projects/${initial.id}`, {
              method: "PATCH",
              body: JSON.stringify({ ...snapshot, revision: revision.current }),
            });
            revision.current = p.revision;
            committed.current = JSON.stringify(snapshot);
          })
          .catch((e) => onError(e.message));
      }
    };
  }, []);
  useEffect(
    () => () => {
      if (stem) URL.revokeObjectURL(stem.url);
    },
    [stem],
  );
  useEffect(() => {
    import("@/lib/deviceExport").then(({ deviceExportSupported }) =>
      setDeviceSupported(deviceExportSupported()),
    );
  }, []);
  useEffect(() => {
    import("@/lib/deviceExport").then(({ deviceExportEligible }) =>
      setDeviceEligible(deviceExportEligible(edit.audio.mode)),
    );
  }, [edit.audio.mode]);
  useEffect(() => {
    if (destination === "device" && (!deviceSupported || !deviceEligible))
      setDestination("server");
  }, [deviceSupported, deviceEligible]);
  function change(next: Edit) {
    setPast((p) => [...p.slice(-59), edit]);
    setFuture([]);
    setEdit(next);
  }
  function updateOverlay(id: string, changes: Partial<Overlay>) {
    change({
      ...edit,
      textOverlays: edit.textOverlays.map((t) =>
        t.id === id ? { ...t, ...changes } : t,
      ),
    });
  }
  function save(snapshot = { edit, name, caption }) {
    setSaving("Saving…");
    const next = saveChain.current
      .catch(() => {})
      .then(async () => {
        const p = await api<Project>(`/projects/${initial.id}`, {
          method: "PATCH",
          body: JSON.stringify({ ...snapshot, revision: revision.current }),
        });
        revision.current = p.revision;
        committed.current = JSON.stringify(snapshot);
        if (alive.current) {
          setSaving("Saved");
          onSaved({ ...p, media });
        }
        return p;
      });
    saveChain.current = next;
    return next.catch((e) => {
      if (alive.current) {
        setSaving("Save failed");
        onError(e.message);
      }
      throw e;
    });
  }
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setSaving("Unsaved");
    const timer = setTimeout(() => {
      void save().catch(() => {});
    }, 1200);
    return () => clearTimeout(timer);
  }, [edit, name, caption]); // Serialized saves prevent overlapping revision writes.
  useEffect(() => {
    let frame: number;
    const draw = () => {
      const v = video.current,
        ctx = canvas.current?.getContext("2d");
      if (v && ctx) {
        if (!v.paused) {
          const segments = current.current.segments,
            ms = v.currentTime * 1000;
          const s = segments.find(
            (s) => s.enabled && ms >= s.startMs && ms < s.endMs - 20,
          );
          if (!s) {
            const next = segments.find((s) => s.enabled && s.startMs > ms);
            if (next) {
              v.currentTime = next.startMs / 1000;
              if (derived.current) derived.current.currentTime = v.currentTime;
            } else {
              v.pause();
              derived.current?.pause();
              setPlaying(false);
            }
          }
        }
        preview(ctx, v, current.current);
      }
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, []);
  function seek(seconds: number) {
    if (!video.current) return;
    video.current.currentTime = seconds;
    if (derived.current) derived.current.currentTime = seconds;
    setTime(seconds);
  }
  async function toggle() {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      if (v.currentTime >= duration - 0.05)
        seek(edit.segments.find((s) => s.enabled)!.startMs / 1000);
      await v.play();
      if (derived.current && edit.audio.derivativeId) {
        derived.current.currentTime = v.currentTime;
        await derived.current.play();
      }
      setPlaying(true);
    } else {
      v.pause();
      derived.current?.pause();
      setPlaying(false);
    }
  }
  function split() {
    const ms = time * 1000,
      i = edit.segments.findIndex(
        (s) => ms > s.startMs + 100 && ms < s.endMs - 100,
      );
    if (i < 0) return;
    const s = edit.segments[i];
    change({
      ...edit,
      segments: [
        ...edit.segments.slice(0, i),
        { ...s, endMs: ms },
        { ...s, startMs: ms },
        ...edit.segments.slice(i + 1),
      ],
    });
    setSelected(i + 1);
  }
  function preset() {
    const [w, h] = dimensions("9:16"),
      target = w / h,
      source = media.width / media.height;
    const width = target < source ? target / source : 1,
      height = target > source ? source / target : 1;
    change({
      ...edit,
      canvas: { ...edit.canvas, aspectRatio: "9:16" },
      crop: { x: (1 - width) / 2, y: (1 - height) / 2, width, height },
    });
  }
  async function exportOnDevice(p: Project) {
    const { renderOnDevice } = await import("@/lib/deviceExport");
    abort.current = new AbortController();
    const blob = await renderOnDevice({
      videoUrl: fileUrl("media", media.id),
      audioUrl:
        edit.audio.mode === "vocals-only" && edit.audio.derivativeId
          ? fileUrl("audio", edit.audio.derivativeId)
          : null,
      edit,
      quality,
      sourceWidth: media.width,
      sourceHeight: media.height,
      onProgress: (s) => setAudioStatus(s),
      signal: abort.current.signal,
    });
    setAudioStatus("");
    const body = new FormData();
    body.append("file", blob, "export.mp4");
    const { job } = await api(
      `/projects/${initial.id}/renders/device?revision=${p.revision}&quality=${quality}`,
      { method: "POST", body },
    );
    await awaitJob(job.id);
  }
  async function exportVideo() {
    setRendering(true);
    onError("");
    try {
      const p = await save();
      if (destination === "device") {
        if (!deviceSupported || !deviceEligible)
          throw new Error(
            "On-device export isn't available for this edit. Use server export instead.",
          );
        await exportOnDevice(p);
      } else {
        const images = await artwork(edit, quality);
        const { job } = await api(`/projects/${initial.id}/renders`, {
          method: "POST",
          body: JSON.stringify({ ...images, revision: p.revision, quality }),
        });
        await awaitJob(job.id);
      }
      onExport();
    } catch (e: any) {
      onError(e.message);
    } finally {
      setRendering(false);
    }
  }
  async function separate(mode: string) {
    setSeparating(true);
    onError("");
    abort.current = new AbortController();
    try {
      const { separateAudio } = await import("@/lib/audio");
      const blob = await separateAudio(
        fileUrl("media", media.id, "audioFile"),
        mode,
        (s) => setAudioStatus(s),
        abort.current.signal,
      );
      setStem({ blob, url: URL.createObjectURL(blob), mode });
      setAudioStatus("Preview ready. Apply it to your edit.");
    } catch (e: any) {
      if (e.name !== "AbortError") onError(e.message);
      setAudioStatus("");
    } finally {
      setSeparating(false);
    }
  }
  async function applyStem() {
    if (!stem) return;
    setSeparating(true);
    try {
      const body = new FormData();
      body.append("file", stem.blob, "processed.wav");
      const { job } = await api(`/projects/${initial.id}/audio`, {
        method: "POST",
        body,
      });
      const ready = await awaitJob(job.id);
      change({
        ...edit,
        audio: { mode: stem.mode, derivativeId: ready.resultId },
      });
      setAudioStatus("Processed audio applied.");
      setStem(null);
    } catch (e: any) {
      onError(e.message);
    } finally {
      setSeparating(false);
    }
  }
  const effective =
    edit.segments
      .filter((s) => s.enabled)
      .reduce((a, s) => a + s.endMs - s.startMs, 0) / 1000;
  return (
    <section className="editor">
      <div className="editor-heading">
        <div>
          <input
            className="project-name"
            aria-label="Project name"
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
          />
          <span className="save-state">
            {saving} · {clock(effective)} edited length
          </span>
        </div>
        <div className="row">
          <button className="subtle" onClick={() => save().catch(() => {})}>
            <Save size={16} /> Save
          </button>
          <div className="split-button">
            <button
              className="primary"
              disabled={rendering}
              onClick={exportVideo}
            >
              {rendering ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <Download size={17} />
              )}{" "}
              {rendering
                ? "Rendering…"
                : `Export ${quality}${destination === "device" ? " · this device" : ""}`}
            </button>
            <button
              className="primary split-caret"
              disabled={rendering}
              aria-label="Export options"
              aria-haspopup="menu"
              aria-expanded={exportMenuOpen}
              onClick={() => setExportMenuOpen((v) => !v)}
            >
              <ChevronDown size={16} />
            </button>
            {exportMenuOpen && (
              <div className="card-menu-list export-options" role="menu">
                <span className="export-options-label">Quality</span>
                <label className="export-option-row">
                  <input
                    type="radio"
                    name="quality"
                    checked={quality === "1080p"}
                    onChange={() => setQuality("1080p")}
                  />
                  1080p
                </label>
                <label className="export-option-row">
                  <input
                    type="radio"
                    name="quality"
                    checked={quality === "720p"}
                    onChange={() => setQuality("720p")}
                  />
                  720p
                </label>
                <span className="export-options-label">Render using</span>
                <label className="export-option-row">
                  <input
                    type="radio"
                    name="destination"
                    checked={destination === "server"}
                    onChange={() => setDestination("server")}
                  />
                  <Server size={15} /> Server
                </label>
                <label
                  className="export-option-row"
                  title={
                    !deviceSupported
                      ? "Your browser doesn't support on-device export."
                      : !deviceEligible
                        ? "On-device export only supports original audio or instrument removal."
                        : ""
                  }
                >
                  <input
                    type="radio"
                    name="destination"
                    disabled={!deviceSupported || !deviceEligible}
                    checked={destination === "device"}
                    onChange={() => setDestination("device")}
                  />
                  <Smartphone size={15} /> This device
                </label>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="edit-workspace">
        <div className="preview-column">
          <div className="preview-stage">
            <canvas ref={canvas} aria-label="Edited video preview" />
            <video
              ref={video}
              className="source-video"
              src={fileUrl("media", media.id)}
              muted={edit.audio.mode !== "original"}
              playsInline
              preload="auto"
              onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
              onEnded={() => {
                setPlaying(false);
                derived.current?.pause();
              }}
            />
            {edit.audio.derivativeId && (
              <audio
                ref={derived}
                src={fileUrl("audio", edit.audio.derivativeId)}
                muted={["mute", "original"].includes(edit.audio.mode)}
              />
            )}
            <span className="canvas-label">
              {edit.canvas.aspectRatio} ·{" "}
              {dimensions(edit.canvas.aspectRatio).join(" × ")}
            </span>
          </div>
          <div className="playback">
            <span>PREVIEW</span>
            <button
              aria-label={playing ? "Pause video" : "Play video"}
              className="play-button"
              onClick={() => toggle().catch((e) => onError(e.message))}
            >
              {playing ? <Pause size={19} /> : <Play size={19} />}
            </button>
            <span>
              {clock(time)} / {clock(duration)}
            </span>
          </div>
          <div className="timeline">
            <div className="timeline-toolbar">
              <strong>Timeline</strong>
              <div className="row">
                <button
                  aria-label="Undo"
                  disabled={!past.length}
                  onClick={() => {
                    setFuture((f) => [edit, ...f]);
                    setEdit(past.at(-1)!);
                    setPast(past.slice(0, -1));
                  }}
                >
                  <Undo2 size={17} />
                </button>
                <button
                  aria-label="Redo"
                  disabled={!future.length}
                  onClick={() => {
                    setPast((p) => [...p, edit]);
                    setEdit(future[0]);
                    setFuture(future.slice(1));
                  }}
                >
                  <Redo2 size={17} />
                </button>
                <button className="subtle compact" onClick={split}>
                  <Scissors size={15} /> Split
                </button>
                <button
                  aria-label="Remove selected clip"
                  disabled={
                    !edit.segments[selected]?.enabled ||
                    edit.segments.filter((s) => s.enabled).length < 2
                  }
                  onClick={() =>
                    change({
                      ...edit,
                      segments: edit.segments.map((s, i) =>
                        i === selected ? { ...s, enabled: false } : s,
                      ),
                    })
                  }
                >
                  <Trash2 size={17} />
                </button>
              </div>
            </div>
            <input
              aria-label="Timeline playhead"
              type="range"
              min="0"
              max={duration}
              step="0.01"
              value={time}
              onChange={(e) => seek(Number(e.target.value))}
            />
            <div className="clip-track">
              {edit.segments.map((s, i) => (
                <button
                  key={`${s.startMs}-${s.endMs}`}
                  className={`clip ${selected === i ? "selected" : ""} ${!s.enabled ? "removed" : ""}`}
                  style={{ flex: Math.max(0.1, s.endMs - s.startMs) }}
                  title={`${clock(s.startMs / 1000)}–${clock(s.endMs / 1000)}${s.enabled ? "" : " removed; double-click to restore"}`}
                  onClick={() => {
                    setSelected(i);
                    seek(s.startMs / 1000);
                  }}
                  onDoubleClick={() => {
                    if (!s.enabled)
                      change({
                        ...edit,
                        segments: edit.segments.map((seg, n) =>
                          n === i ? { ...seg, enabled: true } : seg,
                        ),
                      });
                  }}
                >
                  <FilmStrip />
                  {s.enabled ? clock((s.endMs - s.startMs) / 1000) : "Removed"}
                </button>
              ))}
            </div>
            <div className="timeline-scale">
              <span>00:00</span>
              <span>{clock(duration / 2)}</span>
              <span>{clock(duration)}</span>
            </div>
            <p className="hint">
              Split at the playhead. Select a clip to remove it; double-click a
              removed clip to restore.
            </p>
          </div>
        </div>
        <aside className="inspector">
          <div className="tool-tabs">
            {[
              ["crop", Crop],
              ["text", Type],
              ["background", Palette],
              ["audio", Music2],
              ["caption", Captions],
            ].map(([key, Icon]: any) => (
              <button
                key={key}
                title={key}
                aria-label={`${key} tools`}
                className={tab === key ? "active" : ""}
                onClick={() => setTab(key)}
              >
                <Icon size={19} />
              </button>
            ))}
          </div>
          <div className="tool-body">
            {tab === "crop" && (
              <>
                <div className="eyebrow">FRAME IT YOUR WAY</div>
                <h2>Crop & canvas</h2>
                <p className="hint">Instagram Reel · 9:16 · 1080 × 1920</p>
                <button className="subtle wide" onClick={preset}>
                  Fill Reel frame
                </button>
                <button
                  className="subtle wide"
                  onClick={() =>
                    change({
                      ...edit,
                      crop: { x: 0, y: 0, width: 1, height: 1 },
                    })
                  }
                >
                  Fit full video
                </button>
                <hr />
                {(["width", "height", "x", "y"] as const).map((key) => (
                  <label key={key}>
                    {
                      {
                        width: "Crop width",
                        height: "Crop height",
                        x: "Horizontal position",
                        y: "Vertical position",
                      }[key]
                    }
                    <input
                      type="range"
                      min={key === "width" || key === "height" ? 0.05 : 0}
                      max={
                        key === "x"
                          ? 1 - edit.crop.width
                          : key === "y"
                            ? 1 - edit.crop.height
                            : 1
                      }
                      step="0.005"
                      value={edit.crop[key]}
                      onChange={(e) => {
                        const crop = {
                          ...edit.crop,
                          [key]: Number(e.target.value),
                        };
                        crop.x = Math.min(crop.x, 1 - crop.width);
                        crop.y = Math.min(crop.y, 1 - crop.height);
                        change({ ...edit, crop });
                      }}
                    />
                  </label>
                ))}
                <p className="hint">
                  Your cropped video fits inside the selected canvas. Any space
                  around it uses your background.
                </p>
              </>
            )}
            {tab === "background" && (
              <>
                <h2>Background</h2>
                <label>
                  Style
                  <select
                    value={edit.canvas.background.type}
                    onChange={(e) =>
                      change({
                        ...edit,
                        canvas: {
                          ...edit.canvas,
                          background: {
                            ...edit.canvas.background,
                            type: e.target.value,
                          },
                        },
                      })
                    }
                  >
                    <option value="solid">Solid color</option>
                    <option value="gradient">Gradient mix</option>
                  </select>
                </label>
                <label>Quick colors</label>
                <div className="swatches">
                  {bgColors.map((c) => (
                    <button
                      key={c}
                      style={{ background: c }}
                      aria-label={`Background ${c}`}
                      className={
                        edit.canvas.background.colors[0] === c ? "selected" : ""
                      }
                      onClick={() =>
                        change({
                          ...edit,
                          canvas: {
                            ...edit.canvas,
                            background: {
                              ...edit.canvas.background,
                              colors: [
                                c,
                                ...edit.canvas.background.colors.slice(1),
                              ],
                            },
                          },
                        })
                      }
                    />
                  ))}
                </div>
                {(edit.canvas.background.type === "gradient"
                  ? edit.canvas.background.colors
                  : edit.canvas.background.colors.slice(0, 1)
                ).map((c, i) => (
                  <label key={i}>
                    Custom color{" "}
                    {edit.canvas.background.type === "gradient" ? i + 1 : ""}
                    <div className="color-input">
                      <input
                        type="color"
                        value={c}
                        onChange={(e) =>
                          change({
                            ...edit,
                            canvas: {
                              ...edit.canvas,
                              background: {
                                ...edit.canvas.background,
                                colors: edit.canvas.background.colors.map(
                                  (x, j) => (i === j ? e.target.value : x),
                                ),
                              },
                            },
                          })
                        }
                      />
                      <span>{c.toUpperCase()}</span>
                    </div>
                  </label>
                ))}
                {edit.canvas.background.type === "gradient" && (
                  <>
                    <label>
                      Angle · {edit.canvas.background.angle}°
                      <input
                        type="range"
                        min="0"
                        max="360"
                        value={edit.canvas.background.angle}
                        onChange={(e) =>
                          change({
                            ...edit,
                            canvas: {
                              ...edit.canvas,
                              background: {
                                ...edit.canvas.background,
                                angle: Number(e.target.value),
                              },
                            },
                          })
                        }
                      />
                    </label>
                    <button
                      className="subtle"
                      onClick={() =>
                        change({
                          ...edit,
                          canvas: {
                            ...edit.canvas,
                            background: {
                              ...edit.canvas.background,
                              colors:
                                edit.canvas.background.colors.length === 2
                                  ? [
                                      ...edit.canvas.background.colors,
                                      "#38BDF8",
                                    ]
                                  : edit.canvas.background.colors.slice(0, 2),
                            },
                          },
                        })
                      }
                    >
                      {edit.canvas.background.colors.length === 2
                        ? "Add third color"
                        : "Remove third color"}
                    </button>
                  </>
                )}
              </>
            )}
            {tab === "text" && (
              <>
                <h2>Text overlays</h2>
                <button
                  className="subtle wide"
                  disabled={edit.textOverlays.length >= 12}
                  onClick={() =>
                    change({
                      ...edit,
                      textOverlays: [
                        ...edit.textOverlays,
                        {
                          id: crypto.randomUUID(),
                          text: "Make it yours.",
                          font: "Inter",
                          color: "#FFFFFF",
                          size: 56,
                          x: 0.5,
                          y: 0.15,
                          startMs: 0,
                          endMs: duration * 1000,
                        },
                      ],
                    })
                  }
                >
                  <Plus size={16} /> Add text
                </button>
                {edit.textOverlays.map((t) => (
                  <div className="text-card" key={t.id}>
                    <label>
                      Text
                      <textarea
                        rows={2}
                        maxLength={500}
                        value={t.text}
                        onChange={(e) =>
                          updateOverlay(t.id, { text: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Font
                      <select
                        value={t.font}
                        onChange={(e) =>
                          updateOverlay(t.id, { font: e.target.value })
                        }
                      >
                        {fonts.map((f) => (
                          <option key={f}>{f}</option>
                        ))}
                      </select>
                    </label>
                    <div className="swatches">
                      {textColors.map((c) => (
                        <button
                          key={c}
                          style={{ background: c }}
                          className={t.color === c ? "selected" : ""}
                          aria-label={`Text ${c}`}
                          onClick={() => updateOverlay(t.id, { color: c })}
                        />
                      ))}
                    </div>
                    {[
                      ["size", "Size", 16, 120],
                      ["x", "Horizontal", 0, 1],
                      ["y", "Vertical", 0, 1],
                    ].map(([key, label, min, max]) => (
                      <label key={key}>
                        {label}
                        <input
                          type="range"
                          min={min}
                          max={max}
                          step={key === "size" ? 1 : 0.01}
                          value={t[key as "size" | "x" | "y"]}
                          onChange={(e) =>
                            updateOverlay(t.id, {
                              [key]: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                    ))}
                    <div className="row">
                      <label>
                        From (sec)
                        <input
                          type="number"
                          min="0"
                          max={t.endMs / 1000 - 0.1}
                          step="0.1"
                          value={t.startMs / 1000}
                          onChange={(e) =>
                            updateOverlay(t.id, {
                              startMs: Number(e.target.value) * 1000,
                            })
                          }
                        />
                      </label>
                      <label>
                        To (sec)
                        <input
                          type="number"
                          min={t.startMs / 1000 + 0.1}
                          max={duration}
                          step="0.1"
                          value={t.endMs / 1000}
                          onChange={(e) =>
                            updateOverlay(t.id, {
                              endMs: Number(e.target.value) * 1000,
                            })
                          }
                        />
                      </label>
                    </div>
                    <button
                      className="subtle"
                      onClick={() =>
                        change({
                          ...edit,
                          textOverlays: edit.textOverlays.filter(
                            (x) => x.id !== t.id,
                          ),
                        })
                      }
                    >
                      <Trash2 size={14} /> Remove text
                    </button>
                  </div>
                ))}
              </>
            )}
            {tab === "caption" && (
              <>
                <h2>Post caption</h2>
                <p className="hint">
                  Saved separately with your edited video, ready to copy into
                  Instagram.
                </p>
                <textarea
                  aria-label="Post caption"
                  rows={12}
                  value={caption}
                  maxLength={8000}
                  onChange={(e) => setCaption(e.target.value)}
                />
                <span className="hint">{caption.length} characters</span>
                <button
                  className="subtle wide"
                  onClick={() =>
                    navigator.clipboard
                      .writeText(caption)
                      .catch((e) => onError(e.message))
                  }
                >
                  Copy caption
                </button>
                <div className="planned">
                  <strong>AI caption assistant</strong>
                  <p>
                    Chat / Rewrite and Analyze video are planned for a later
                    phase.
                  </p>
                </div>
              </>
            )}
            {tab === "audio" && (
              <>
                <h2>Audio</h2>
                <p className="hint">
                  Kim Vocal 2 separates vocals on your device.
                </p>
                <label>
                  Current track
                  <select
                    value={edit.audio.mode}
                    onChange={(e) =>
                      change({
                        ...edit,
                        audio: { ...edit.audio, mode: e.target.value },
                      })
                    }
                  >
                    <option value="original">Original audio</option>
                    <option value="mute">Mute audio</option>
                    {edit.audio.derivativeId && (
                      <option
                        value={
                          edit.audio.mode === "vocals-only"
                            ? "vocals-only"
                            : "remove-vocals"
                        }
                      >
                        Processed audio
                      </option>
                    )}
                  </select>
                </label>
                <hr />
                <button
                  className="subtle wide"
                  disabled={separating}
                  onClick={() => separate("remove-vocals")}
                >
                  <Music2 size={17} /> Remove vocals
                </button>
                <button
                  className="subtle wide"
                  disabled={separating}
                  onClick={() => separate("vocals-only")}
                >
                  Keep vocals only
                </button>
                {audioStatus && (
                  <p role="status" className="hint">
                    {audioStatus}
                  </p>
                )}
                {separating && (
                  <button
                    className="subtle"
                    onClick={() => abort.current?.abort()}
                  >
                    Cancel separation
                  </button>
                )}
                {stem && (
                  <div className="stem-preview">
                    <audio controls src={stem.url} />
                    <button
                      className="primary wide"
                      disabled={separating}
                      onClick={applyStem}
                    >
                      Apply processed audio
                    </button>
                  </div>
                )}
                <p className="hint">
                  Result may vary. The model downloads once (about 67 MB). CPU
                  processing can take a while.
                </p>
              </>
            )}
          </div>
        </aside>
      </div>
      {exportMenuOpen && (
        <div
          className="menu-overlay"
          onClick={() => setExportMenuOpen(false)}
        />
      )}
    </section>
  );
}
function FilmStrip() {
  return (
    <span className="film-strip" aria-hidden="true">
      ▥
    </span>
  );
}
