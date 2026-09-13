"use client";
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import Slider from "@/components/Slider";
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
  ChevronLeft,
  Smartphone,
  X,
  Grid3x3,
  RotateCcw,
  Check,
  Move,
  Film,
} from "lucide-react";
import { api, fileUrl, clock, awaitJob } from "@/lib/api";
import {
  preview,
  fonts,
  textColors,
  bgColors,
  dimensions,
  clampCrop,
  MIN_CROP,
  measureOverlay,
  videoBox,
  type Crop as CropRect,
} from "@/lib/canvas";
import {
  centringPan,
  CENTRED_EPSILON,
  clampPan,
  magnetToCentre,
} from "@/shared/export.mjs";
import type { Edit, Overlay, Project } from "@/lib/types";
import type { ExportTask } from "@/lib/useDeviceExports";

export default function Editor({
  initial,
  onError,
  onQueue,
  onSaved,
  onBack,
}: {
  initial: Project;
  onError: (e: string) => void;
  onQueue: (task: ExportTask) => Promise<void>;
  onSaved: (p: Project) => void;
  onBack?: () => void;
}) {
  // Projects saved before panning existed have no offset. Fill it in here
  // rather than making every reader defensive -- the spread order means a
  // stored offset always wins over this default.
  const [edit, setEdit] = useState<Edit>(() => ({
      offset: { x: 0, y: 0 },
      ...initial.edit,
    })),
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
    [exportMenuOpen, setExportMenuOpen] = useState(false),
    [sheetOpen, setSheetOpen] = useState(false),
    [deviceSupported, setDeviceSupported] = useState(false),
    [freehand, setFreehand] = useState(false),
    [liveCrop, setLiveCrop] = useState<CropRect | null>(null),
    [liveTextPos, setLiveTextPos] = useState<{
      id: string;
      x: number;
      y: number;
    } | null>(null),
    [selectedTextId, setSelectedTextId] = useState<string | null>(null),
    [livePan, setLivePan] = useState<{ x: number; y: number } | null>(null),
    [onCentre, setOnCentre] = useState({ x: false, y: false });
  const video = useRef<HTMLVideoElement>(null),
    derived = useRef<HTMLAudioElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    textFrame = useRef<HTMLDivElement>(null),
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
  // The canvas follows an in-flight pan live; `edit` -- and so undo history and
  // autosave -- only moves once, when the finger lifts.
  current.current = livePan ? { ...edit, offset: livePan } : edit;
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
  function change(next: Edit) {
    setPast((p) => [...p.slice(-59), edit]);
    setFuture([]);
    setEdit(next);
  }
  // Leaving Free hand (Done, closing the sheet, switching tools) must never
  // silently drop a drag that was still in flight -- flush whatever was last
  // on screen into the real edit first, so what you saw is what you get.
  function exitFreehand() {
    setLiveCrop((c) => {
      if (c) change({ ...edit, crop: c });
      return null;
    });
    setFreehand(false);
  }
  function updateOverlay(id: string, changes: Partial<Overlay>) {
    change({
      ...edit,
      textOverlays: edit.textOverlays.map((t) =>
        t.id === id ? { ...t, ...changes } : t,
      ),
    });
  }
  function removeOverlay(id: string) {
    change({
      ...edit,
      textOverlays: edit.textOverlays.filter((t) => t.id !== id),
    });
    setSelectedTextId((s) => (s === id ? null : s));
  }
  // Tapping a text's on-canvas handle selects it and brings its card into
  // view in the (short, scrollable) panel, so you don't have to go hunting
  // for the right one among several.
  function selectOverlay(id: string) {
    setSelectedTextId(id);
    document
      .querySelector(`[data-overlay-card="${id}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  // The drag handle's size in canvas fractions, from the text's *actual*
  // measured footprint -- not a guess -- so grabbing it feels like grabbing
  // the rendered text rather than some arbitrary box near it. Measured on
  // the live preview canvas itself (not a fresh offscreen one) so the font
  // is guaranteed already loaded -- it's been drawing text every frame --
  // rather than risking a fallback-font measurement that doesn't match
  // what's actually on screen.
  function overlayBoxFraction(t: Overlay) {
    const [cw, ch] = dimensions(edit.canvas.aspectRatio);
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return { width: 0.3, height: 0.08 };
    const { width, height } = measureOverlay(ctx, t, cw, ch);
    return { width: width / cw, height: height / ch };
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
    let lastEdit: Edit | null = null, lastTime = -1, lastDraw = 0, lastReady = -1;
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
        const now = performance.now();
        if (now - lastDraw >= 32 && (lastEdit !== current.current || lastTime !== v.currentTime || lastReady !== v.readyState)) {
          preview(ctx, v, current.current);
          lastDraw = now;
          lastEdit = current.current;
          lastTime = v.currentTime;
          lastReady = v.readyState;
        }
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
  async function exportVideo() {
    if (!deviceSupported) {
      onError("Device export needs HTTPS and a supported browser with WebCodecs. Update your browser; server rendering is disabled.");
      return;
    }
    setRendering(true);
    onError("");
    try {
      const snapshot = structuredClone({ edit, name, caption });
      const p = await save(snapshot);
      await onQueue({ project: { ...p, media }, quality });
      if (alive.current) setExportMenuOpen(false);
    } catch (e: any) {
      onError(e.message);
    } finally {
      if (alive.current) setRendering(false);
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
  // Where the video currently sits on the canvas, and the pan that would put it
  // dead centre. With a crop applied those differ: an offset of zero leaves the
  // frame wherever cropping left it, which is not the middle.
  const [canvasWidth, canvasHeight] = dimensions(edit.canvas.aspectRatio);
  const frameBox =
    media.width && media.height
      ? videoBox(edit, canvasWidth, canvasHeight, media.width, media.height)
      : null;
  const centre = frameBox ? centringPan(frameBox) : { x: 0, y: 0 };
  // Deliberately not an exact comparison: rounding the drawn frame to even
  // pixels leaves a sub-pixel gap, and offering to "centre" a video that is
  // already centred to within half a pixel just looks broken.
  const panned =
    Math.abs(edit.offset.x - centre.x) > CENTRED_EPSILON ||
    Math.abs(edit.offset.y - centre.y) > CENTRED_EPSILON;
  const effective =
    edit.segments
      .filter((s) => s.enabled)
      .reduce((a, s) => a + s.endMs - s.startMs, 0) / 1000;
  return (
    <section className="editor">
      <div className="editor-heading">
        {onBack && (
          <button
            className="back-button"
            aria-label="Back to projects"
            onClick={onBack}
          >
            <ChevronLeft size={22} />
          </button>
        )}
        <div className="editor-title">
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
          {/* History used to live in the timeline toolbar. With the timeline
              now a tool tab of its own, it belongs somewhere reachable from
              every tab -- and it applies to crop, text and colour too. */}
          <button
            className="subtle history-action"
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
            className="subtle history-action"
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
          <button
            className="subtle save-action"
            onClick={() => save().catch(() => {})}
          >
            <Save size={16} /> <span className="label-text">Save</span>
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
              <span className="export-label-full">
                {rendering
                  ? "Queuing…"
                  : `Export ${quality} · this device`}
              </span>
              <span className="export-label-short">
                {rendering ? "…" : "Export"}
              </span>
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
                    onChange={() => { setQuality("1080p"); setExportMenuOpen(false); }}
                  />
                  1080p
                </label>
                <label className="export-option-row">
                  <input
                    type="radio"
                    name="quality"
                    checked={quality === "720p"}
                    onChange={() => { setQuality("720p"); setExportMenuOpen(false); }}
                  />
                  720p
                </label>
                <p className="hint"><Smartphone size={15} /> This device only. Exports continue while you edit another video.</p>
                {!deviceSupported && <p role="status">Requires HTTPS and a supported WebCodecs browser.</p>}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="edit-workspace">
        <div className="preview-column">
          <div className={`preview-stage${freehand ? " freehand" : ""}`}>
            <canvas
              ref={canvas}
              aria-label="Edited video preview"
              style={freehand ? { display: "none" } : undefined}
            />
            <video
              ref={video}
              className={`source-video${freehand ? " source-video-visible" : ""}`}
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
            {freehand && (
              <CropOverlay
                crop={liveCrop ?? edit.crop}
                sourceWidth={media.width}
                sourceHeight={media.height}
                onChange={setLiveCrop}
                onCommit={() => {
                  setLiveCrop((c) => {
                    if (c) change({ ...edit, crop: c });
                    return null;
                  });
                }}
              />
            )}
            {!freehand && frameBox && (
              <VideoPanLayer
                box={frameBox}
                sizeRef={canvas}
                offset={livePan ?? edit.offset}
                onChange={(pan, centred) => {
                  setLivePan(pan);
                  setOnCentre(centred);
                }}
                onCommit={() => {
                  setOnCentre({ x: false, y: false });
                  setLivePan((pan) => {
                    if (pan) change({ ...edit, offset: pan });
                    return null;
                  });
                }}
                onTap={() => toggle().catch((e) => onError(e.message))}
                guides={livePan ? onCentre : { x: false, y: false }}
              />
            )}
            {tab === "text" && (
              <div
                className="text-drag-frame"
                ref={textFrame}
                aria-hidden="true"
                // Always a 9:16 box, matching the canvas's own fixed shape --
                // without this the frame had no intrinsic size at all and
                // silently stretched to the whole stage, making every drag
                // handle read as a fraction of the wrong, larger box.
                style={{ aspectRatio: "9 / 16" }}
              >
                {edit.textOverlays
                  .filter(
                    (t) =>
                      time * 1000 >= t.startMs && time * 1000 <= t.endMs,
                  )
                  .map((t) => {
                    const pos =
                      liveTextPos?.id === t.id
                        ? liveTextPos
                        : { x: t.x, y: t.y };
                    const box = overlayBoxFraction(t);
                    return (
                      <TextDragHandle
                        key={t.id}
                        x={pos.x}
                        y={pos.y}
                        width={box.width}
                        height={box.height}
                        frameRef={textFrame}
                        selected={selectedTextId === t.id}
                        onTap={() => selectOverlay(t.id)}
                        onDelete={() => removeOverlay(t.id)}
                        onChange={(x, y) =>
                          setLiveTextPos({ id: t.id, x, y })
                        }
                        onCommit={() => {
                          selectOverlay(t.id);
                          setLiveTextPos((p) => {
                            if (p && p.id === t.id)
                              updateOverlay(t.id, { x: p.x, y: p.y });
                            return null;
                          });
                        }}
                      />
                    );
                  })}
              </div>
            )}
          </div>
          {/* One thin transport strip instead of an oversized round button and
              a second scrubber down in the timeline: play, scrub and read the
              time without spending vertical space the video wants. */}
          <div className="player-bar">
            <button
              aria-label={playing ? "Pause video" : "Play video"}
              className="player-play"
              onClick={() => toggle().catch((e) => onError(e.message))}
            >
              {playing ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <input
              className="player-scrub"
              aria-label="Playback position"
              type="range"
              min="0"
              max={duration}
              step="0.01"
              value={time}
              onChange={(e) => seek(Number(e.target.value))}
            />
            <span className="player-time">
              {clock(time)} / {clock(duration)}
            </span>
          </div>
        </div>
        <aside className={`inspector ${sheetOpen ? "sheet-open" : ""}`}>
          <div className="tool-tabs">
            {[
              ["clips", Film, "Clips"],
              ["crop", Crop, "Crop"],
              ["text", Type, "Text"],
              ["background", Palette, "Colour"],
              ["audio", Music2, "Audio"],
              ["caption", Captions, "Caption"],
            ].map(([key, Icon, label]: any) => (
              <button
                key={key}
                title={label}
                aria-label={`${label} tools`}
                className={tab === key ? "active" : ""}
                onClick={() => {
                  // On mobile the same tab acts as a toggle for its sheet,
                  // which is how CapCut/InShot behave; on desktop the panel
                  // is always visible so this only ever switches tabs.
                  if (tab === key) {
                    setSheetOpen((v) => !v);
                    exitFreehand();
                    setLiveTextPos(null);
                    setSelectedTextId(null);
                  } else {
                    setTab(key);
                    setSheetOpen(true);
                    if (key !== "crop") exitFreehand();
                    if (key !== "text") {
                      setLiveTextPos(null);
                      setSelectedTextId(null);
                    }
                  }
                }}
              >
                <Icon size={21} />
                <span className="tool-tab-label">{label}</span>
              </button>
            ))}
          </div>
          <div className="tool-body">
            <div className="sheet-header">
              <span className="sheet-grip" aria-hidden="true" />
              <button
                className="sheet-close"
                aria-label="Close panel"
                onClick={() => {
                  setSheetOpen(false);
                  exitFreehand();
                  setLiveTextPos(null);
                  setSelectedTextId(null);
                }}
              >
                <X size={20} />
              </button>
            </div>
            {tab === "clips" && (
              <>
                <div className="clip-actions">
                  <button className="primary" onClick={split}>
                    <Scissors size={15} /> Split here
                  </button>
                  <button
                    className="subtle"
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
                    <Trash2 size={16} /> Remove clip
                  </button>
                </div>
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
                      {s.enabled
                        ? clock((s.endMs - s.startMs) / 1000)
                        : "Removed"}
                    </button>
                  ))}
                </div>
                <p className="hint clips-hint">
                  Split cuts at the playhead. Tap a clip to select it;
                  double-tap a removed one to bring it back.
                </p>
              </>
            )}
            {tab === "crop" && !freehand && (
              <>
                <button
                  className="primary wide freehand-toggle"
                  onClick={() => setFreehand(true)}
                >
                  <Grid3x3 size={17} /> Free hand crop
                </button>
                <hr />
                {(
                  ["top", "bottom", "left", "right"] as const
                ).map((edge) => {
                  const c = edit.crop;
                  // Each edge is fully independent: it moves only that one
                  // side, holding the opposite side's position fixed --
                  // exactly the same math as dragging that edge in Free
                  // hand, just as a slider + a typed percent.
                  // current: how much is already cropped off this edge.
                  // limit: the most this edge can take before the opposite,
                  // fixed edge would be closer than MIN_CROP away.
                  const current =
                    edge === "left"
                      ? c.x
                      : edge === "right"
                        ? 1 - (c.x + c.width)
                        : edge === "top"
                          ? c.y
                          : 1 - (c.y + c.height);
                  const limit =
                    edge === "left"
                      ? c.x + c.width - MIN_CROP
                      : edge === "right"
                        ? 1 - c.x - MIN_CROP
                        : edge === "top"
                          ? c.y + c.height - MIN_CROP
                          : 1 - c.y - MIN_CROP;
                  const maxPercent = Math.round(Math.max(0, limit) * 100);
                  const percent = Math.round(current * 100);
                  const apply = (p: number) => {
                    const v = Math.min(maxPercent, Math.max(0, p)) / 100;
                    let crop = { ...c };
                    if (edge === "left") {
                      crop.width = c.x + c.width - v;
                      crop.x = v;
                    } else if (edge === "right") {
                      crop.width = 1 - v - c.x;
                    } else if (edge === "top") {
                      crop.height = c.y + c.height - v;
                      crop.y = v;
                    } else {
                      crop.height = 1 - v - c.y;
                    }
                    change({ ...edit, crop: clampCrop(crop) });
                  };
                  const label = edge[0].toUpperCase() + edge.slice(1);
                  return (
                    <label key={edge}>
                      {label}
                      <div className="crop-axis-row">
                        <Slider
                          ariaLabel={`${label} crop percent`}
                          min={0}
                          max={maxPercent}
                          step={1}
                          value={percent}
                          onChange={apply}
                        />
                        <span className="crop-axis-value">
                          <input
                            type="number"
                            aria-label={`${label} crop percent`}
                            min={0}
                            max={maxPercent}
                            value={percent}
                            onChange={(e) => apply(Number(e.target.value))}
                          />
                          %
                        </span>
                      </div>
                    </label>
                  );
                })}
                <hr />
                <button
                  className="subtle wide"
                  disabled={!panned}
                  onClick={() => change({ ...edit, offset: centre })}
                >
                  <Move size={15} /> Centre the video
                </button>
                <p className="hint">
                  Each side crops on its own. Drag the video itself to slide it
                  around the frame -- it pulls towards the centre line as you
                  get close.
                </p>
              </>
            )}
            {tab === "crop" && freehand && (
              <>
                <div className="eyebrow">FREE HAND CROP</div>
                <h2>Drag any edge</h2>
                <p className="hint">
                  Touch an edge or corner on the video and drag to crop from
                  that side.
                </p>
                <button className="primary wide" onClick={exitFreehand}>
                  <Check size={16} /> Done
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
                  <RotateCcw size={15} /> Reset crop
                </button>
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
                      <Slider
                        ariaLabel="Gradient angle"
                        min={0}
                        max={360}
                        value={edit.canvas.background.angle}
                        onChange={(angle) =>
                          change({
                            ...edit,
                            canvas: {
                              ...edit.canvas,
                              background: { ...edit.canvas.background, angle },
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
                  <div
                    className={`text-card${selectedTextId === t.id ? " selected" : ""}`}
                    key={t.id}
                    data-overlay-card={t.id}
                    onFocusCapture={() => setSelectedTextId(t.id)}
                  >
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
                        <Slider
                          ariaLabel={`${label} for this text`}
                          min={Number(min)}
                          max={Number(max)}
                          step={key === "size" ? 1 : 0.01}
                          value={t[key as "size" | "x" | "y"]}
                          onChange={(v) => updateOverlay(t.id, { [key]: v })}
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
                      onClick={() => removeOverlay(t.id)}
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
type DragHandle = "t" | "b" | "l" | "r" | "tl" | "tr" | "bl" | "br";
// Freehand crop: a border with edge and corner handles laid directly over the
// full source frame. Dragging updates a live value on every pointermove but
// only commits one undo step, on release -- otherwise a single drag gesture
// would flood the undo stack with hundreds of intermediate crops.
function CropOverlay({
  crop,
  sourceWidth,
  sourceHeight,
  onChange,
  onCommit,
}: {
  crop: CropRect;
  sourceWidth: number;
  sourceHeight: number;
  onChange: (crop: CropRect) => void;
  onCommit: () => void;
}) {
  // This wrapper is given the source's own aspect ratio and the same
  // max-width/max-height as the visible <video>, so it always lands exactly
  // on the letterboxed video content -- no manual object-fit math needed.
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    handle: DragHandle;
    startX: number;
    startY: number;
    start: CropRect;
    width: number;
    height: number;
  } | null>(null);
  function down(handle: DragHandle) {
    return (e: ReactPointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      const rect = box.current?.getBoundingClientRect();
      if (!rect) return;
      drag.current = {
        handle,
        startX: e.clientX,
        startY: e.clientY,
        start: crop,
        width: rect.width,
        height: rect.height,
      };
    };
  }
  function move(e: ReactPointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / d.width,
      dy = (e.clientY - d.startY) / d.height;
    let { x, y, width, height } = d.start;
    if (d.handle.includes("l")) {
      x += dx;
      width -= dx;
    }
    if (d.handle.includes("r")) width += dx;
    if (d.handle.includes("t")) {
      y += dy;
      height -= dy;
    }
    if (d.handle.includes("b")) height += dy;
    onChange(clampCrop({ x, y, width, height }));
  }
  function up() {
    if (drag.current) onCommit();
    drag.current = null;
  }
  const handles: DragHandle[] = ["t", "b", "l", "r", "tl", "tr", "bl", "br"];
  return (
    <div
      className="crop-overlay"
      ref={box}
      aria-hidden="true"
      style={
        sourceWidth && sourceHeight
          ? { aspectRatio: `${sourceWidth} / ${sourceHeight}` }
          : undefined
      }
    >
      <div
        className="crop-frame"
        style={{
          left: `${crop.x * 100}%`,
          top: `${crop.y * 100}%`,
          width: `${crop.width * 100}%`,
          height: `${crop.height * 100}%`,
        }}
      >
        <span className="crop-grid-line v" style={{ left: "33.333%" }} />
        <span className="crop-grid-line v" style={{ left: "66.666%" }} />
        <span className="crop-grid-line h" style={{ top: "33.333%" }} />
        <span className="crop-grid-line h" style={{ top: "66.666%" }} />
        {handles.map((h) => (
          <span
            key={h}
            className={`crop-handle crop-handle-${h}`}
            onPointerDown={down(h)}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
          />
        ))}
      </div>
    </div>
  );
}
// Shared by both on-canvas drags: under this many pixels of movement the
// gesture was a tap, not a drag, and the two handlers each do something more
// useful with it than repositioning by zero.
const TAP_THRESHOLD = 4;
// Sliding the whole video is the same gesture as moving a text overlay, on
// purpose: press anywhere on the picture and drag. Two details make it work on
// a phone. A press that never passes the tap threshold is a tap, not a
// zero-length drag, so it toggles playback instead -- the video is by far the
// biggest target on screen. And the canvas centre is sticky: the finger's raw
// position is tracked exactly, but the value actually drawn and saved is eased
// towards centre near it, so letting go anywhere close lands exactly centred
// while a deliberate drag still goes wherever you want.
function VideoPanLayer({
  box,
  sizeRef,
  offset,
  guides,
  onChange,
  onCommit,
  onTap,
}: {
  box: { x: number; y: number; width: number; height: number };
  // The composed canvas. This surface may spill into the stage's padding, so
  // the canvas is what a pixel of finger travel has to be measured against for
  // the video to keep up with the finger exactly.
  sizeRef: RefObject<HTMLCanvasElement | null>;
  offset: { x: number; y: number };
  guides: { x: boolean; y: boolean };
  onChange: (
    pan: { x: number; y: number },
    centred: { x: boolean; y: boolean },
  ) => void;
  onCommit: () => void;
  onTap: () => void;
}) {
  const drag = useRef<{
    startX: number;
    startY: number;
    startPanX: number;
    startPanY: number;
    width: number;
    height: number;
    moved: boolean;
  } | null>(null);
  const centre = centringPan(box);
  function down(e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = sizeRef.current?.getBoundingClientRect();
    if (!rect) return;
    drag.current = {
      startX: e.clientX,
      startY: e.clientY,
      startPanX: offset.x,
      startPanY: offset.y,
      width: rect.width,
      height: rect.height,
      moved: false,
    };
  }
  function move(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || d.width <= 0 || d.height <= 0) return;
    const pixelDx = e.clientX - d.startX,
      pixelDy = e.clientY - d.startY;
    if (
      !d.moved &&
      Math.abs(pixelDx) < TAP_THRESHOLD &&
      Math.abs(pixelDy) < TAP_THRESHOLD
    )
      return;
    d.moved = true;
    // Magnetise the *raw* finger position every move rather than the value we
    // last published: pulling from the raw value is what lets the centre let go
    // the moment you drag past the window, instead of the frame staying stuck
    // to a centre it had already snapped to.
    const raw = {
      x: d.startPanX + pixelDx / d.width,
      y: d.startPanY + pixelDy / d.height,
    };
    const pan = clampPan(
      {
        x: centre.x + magnetToCentre(raw.x - centre.x),
        y: centre.y + magnetToCentre(raw.y - centre.y),
      },
      box,
    );
    onChange(pan, { x: pan.x === centre.x, y: pan.y === centre.y });
  }
  function up() {
    if (drag.current?.moved) onCommit();
    else if (drag.current) onTap();
    drag.current = null;
  }
  return (
    <div
      className="video-pan-layer"
      style={{ aspectRatio: "9 / 16" }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      {guides.y && <span className="centre-guide h" aria-hidden="true" />}
      {guides.x && <span className="centre-guide v" aria-hidden="true" />}
    </div>
  );
}
// A text overlay's position, draggable directly on the preview. Position
// only, on purpose -- x/y move together as one drag, nothing else changes
// (no resize, no rotate) so a drag can never do more than reposition it. A
// tap that never moves past the threshold selects the text (so its card
// scrolls into view in the panel) instead of "dragging" it by zero.
function TextDragHandle({
  x,
  y,
  width,
  height,
  frameRef,
  selected,
  onTap,
  onDelete,
  onChange,
  onCommit,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  frameRef: RefObject<HTMLDivElement | null>;
  selected: boolean;
  onTap: () => void;
  onDelete: () => void;
  onChange: (x: number, y: number) => void;
  onCommit: () => void;
}) {
  const drag = useRef<{
    startX: number;
    startY: number;
    startVX: number;
    startVY: number;
    boxWidth: number;
    boxHeight: number;
    moved: boolean;
  } | null>(null);
  function down(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return;
    drag.current = {
      startX: e.clientX,
      startY: e.clientY,
      startVX: x,
      startVY: y,
      boxWidth: rect.width,
      boxHeight: rect.height,
      moved: false,
    };
  }
  function move(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || d.boxWidth <= 0 || d.boxHeight <= 0) return;
    const pixelDx = e.clientX - d.startX,
      pixelDy = e.clientY - d.startY;
    if (
      !d.moved &&
      Math.abs(pixelDx) < TAP_THRESHOLD &&
      Math.abs(pixelDy) < TAP_THRESHOLD
    )
      return;
    d.moved = true;
    onChange(
      Math.min(1, Math.max(0, d.startVX + pixelDx / d.boxWidth)),
      Math.min(1, Math.max(0, d.startVY + pixelDy / d.boxHeight)),
    );
  }
  function up() {
    if (drag.current?.moved) onCommit();
    else if (drag.current) onTap();
    drag.current = null;
  }
  return (
    <div
      className={`text-drag-handle${selected ? " selected" : ""}`}
      style={{
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        width: `${width * 100}%`,
        height: `${height * 100}%`,
      }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      <button
        className="text-drag-delete"
        aria-label="Delete this text"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}
