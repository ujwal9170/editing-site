"use client";
import { useEffect, useState, useRef } from "react";
import {
  Film,
  Download,
  FolderOpen,
  Scissors,
  Sparkles,
  Plus,
  ArrowUpRight,
  LoaderCircle,
  Check,
  Search,
  Upload,
  X,
  Trash2,
  Captions,
  Music2,
} from "lucide-react";
import { api, fileUrl, clock, size } from "@/lib/api";
import type { Media, Project, Export, Job } from "@/lib/types";
import Editor from "@/components/Editor";
import CaptionPreview from "@/components/CaptionPreview";
import ProjectCard from "@/components/ProjectCard";
import { useWebMCP } from "@/lib/useWebMCP";

export default function Studio() {
  const [view, setView] = useState("media"),
    [media, setMedia] = useState<Media[]>([]),
    [projects, setProjects] = useState<Project[]>([]),
    [exports, setExports] = useState<Export[]>([]),
    [jobs, setJobs] = useState<Job[]>([]);
  const [project, setProject] = useState<Project | null>(null),
    [query, setQuery] = useState(""),
    [importing, setImporting] = useState(false),
    [url, setUrl] = useState(""),
    [permission, setPermission] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [authed, setAuthed] = useState<boolean | null>(null),
    [password, setPassword] = useState(""),
    [caption, setCaption] = useState<Media | null>(null),
    [captionPreview, setCaptionPreview] = useState<Export | null>(null),
    [watch, setWatch] = useState<Export | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useWebMCP(media, authed);
  async function refresh() {
    const [m, p, e, j] = await Promise.all([
      api<Media[]>("/media"),
      api<Project[]>("/projects"),
      api<Export[]>("/exports"),
      api<Job[]>("/jobs"),
    ]);
    setMedia(m);
    setProjects(p);
    setExports(e);
    setJobs(j);
  }
  useEffect(() => {
    api("/auth")
      .then((a) => setAuthed(a.authenticated))
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!authed) return;
    refresh().catch((e) => setError(e.message));
    const timer = setInterval(() => refresh().catch(() => {}), 2500);
    return () => clearInterval(timer);
  }, [authed]);
  async function attempt(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function upload(file?: File) {
    if (!file) return;
    await attempt(async () => {
      const body = new FormData();
      body.append("file", file);
      await api("/media/uploads", { method: "POST", body });
      setImporting(false);
      await refresh();
    });
  }
  async function openProject(id: string) {
    await attempt(async () => {
      const p = await api<Project>(`/projects/${id}`);
      setProject(p);
      setView("editor");
    });
  }
  async function editMedia(item: Media) {
    await attempt(async () => {
      const p = await api<Project>("/projects", {
        method: "POST",
        body: JSON.stringify({ mediaId: item.id }),
      });
      setProject({ ...p, media: item });
      setView("editor");
    });
  }
  const active = jobs.filter((j) => ["running", "queued"].includes(j.status));
  async function deleteMedia(item: Media) {
    const linked = projects.filter((p) => p.mediaId === item.id);
    const message = linked.length
      ? `Delete "${item.name}" and its ${linked.length} saved edit(s)? This cannot be undone. Exported videos will stay.`
      : `Delete "${item.name}" from Media library? This cannot be undone. Exported videos will stay.`;
    if (!confirm(message)) return;
    await attempt(async () => {
      await api(
        `/media/${item.id}${linked.length ? `?deleteEdits=true&expectedEdits=${linked.length}` : ""}`,
        { method: "DELETE" },
      );
      if (project?.mediaId === item.id) setProject(null);
      await refresh();
    });
  }
  async function deleteProject(item: Project) {
    if (
      !confirm(
        `Delete edit "${item.name}"? Its saved changes and processed audio will be removed. The source video and exported videos will stay. This cannot be undone.`,
      )
    )
      return;
    await attempt(async () => {
      await api(`/projects/${item.id}`, { method: "DELETE" });
      if (project?.id === item.id) setProject(null);
      await refresh();
    });
  }
  if (authed === false)
    return (
      <main className="login">
        <div className="brand">
          <Film /> frame<span>/</span>
        </div>
        <h1>Your editing workspace</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            attempt(async () => {
              await api("/auth", {
                method: "POST",
                body: JSON.stringify({ password }),
              });
              setAuthed(true);
            });
          }}
        >
          <label>
            Workspace password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="primary" disabled={busy}>
            Open workspace <ArrowUpRight size={18} />
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
      </main>
    );
  return (
    <div className="studio">
      <aside className="sidebar">
        <a href="/" className="brand">
          <Film size={26} /> frame<span>/</span>
        </a>
        <span className="eyebrow">WORKSPACE</span>
        <nav>
          {[
            ["media", "Media library", FolderOpen],
            ["editor", "Editor", Scissors],
            ["exports", "Edited videos", Film],
          ].map(([key, label, Icon]: any) => (
            <button
              key={key}
              className={view === key ? "nav active" : "nav"}
              onClick={() => {
                if (key === "editor") setProject(null);
                setView(key);
              }}
            >
              <Icon size={19} />
              {label}
              {key === "media" && <span className="count">{media.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <Music2 size={20} />
          <strong>A little less noise.</strong>
          <p>Vocal separation lives right inside your editor.</p>
        </div>
        <div className="workspace-id">
          <span>U</span>
          <div>
            Your workspace<small>Development · shared library</small>
          </div>
        </div>
      </aside>
      <div className="main">
        <header>
          <div className="crumb">
            Workspace <span>/</span>{" "}
            {view === "media"
              ? "Media library"
              : view === "editor"
                ? "Editor"
                : "Edited videos"}
          </div>
          <div className="header-right">
            <span className="local-label">Local workspace</span>
            <button className="avatar" aria-label="Workspace owner">
              U
            </button>
          </div>
        </header>
        {error && (
          <div role="alert" className="notice error">
            {error}
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {active.length > 0 && (
          <div className="notice">
            <LoaderCircle className="spin" size={16} />
            {active.length} {active.length === 1 ? "job" : "jobs"} processing —{" "}
            {active[0].type}. You can keep editing.
          </div>
        )}
        {view === "editor" && project ? (
          <Editor
            key={project.id}
            initial={project}
            onError={setError}
            onExport={() => {
              setView("exports");
              refresh();
            }}
            onSaved={(p) => setProject(p)}
          />
        ) : (
          <section className="library">
            <div className="page-heading">
              <div>
                <div className="eyebrow">YOUR CREATIVE DESK</div>
                <h1>
                  {view === "media"
                    ? "All your footage."
                    : view === "exports"
                      ? "Ready for the feed."
                      : "Pick up where you left off."}
                </h1>
                <p>
                  {view === "media"
                    ? "Bring a clip in. Make it yours."
                    : view === "exports"
                      ? "Your finished edits, with captions saved alongside."
                      : "Open a saved project or start with a clip from Media."}
                </p>
              </div>
              <button className="primary" onClick={() => setImporting(true)}>
                <Plus size={18} /> Import video
              </button>
            </div>
            {view === "media" && (
              <div className="import-strip">
                <div className="import-icon">
                  <Download size={23} />
                </div>
                <div>
                  <strong>Bring a video link to your workspace</strong>
                  <p>
                    Instagram, YouTube or TikTok — with its caption when
                    available.
                  </p>
                </div>
                <button className="subtle" onClick={() => setImporting(true)}>
                  Paste a link <ArrowUpRight size={16} />
                </button>
              </div>
            )}
            <div className="toolbar">
              <div className="tabs">
                <button className="selected">
                  {view === "media"
                    ? "All media"
                    : view === "exports"
                      ? "Exports"
                      : "Projects"}{" "}
                  <span>
                    {view === "media"
                      ? media.length
                      : view === "exports"
                        ? exports.length
                        : projects.length}
                  </span>
                </button>
              </div>
              <label className="search">
                <Search size={17} />
                <input
                  aria-label="Search videos"
                  placeholder="Search videos…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
            </div>
            <div className="media-grid">
              {view === "media" &&
                media
                  .filter((m) =>
                    m.name.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((m) => (
                    <article className="media-card" key={m.id}>
                      <button
                        className="thumbnail"
                        onClick={() => m.status === "ready" && editMedia(m)}
                        disabled={m.status !== "ready"}
                      >
                        {m.status === "ready" ? (
                          <img
                            src={fileUrl("media", m.id, "thumbnail")}
                            alt={m.name}
                          />
                        ) : (
                          <div className="placeholder">
                            <Film />
                            <span>{m.status}</span>
                          </div>
                        )}
                        <span className="source-tag">
                          {(
                            {
                              instagram: "Instagram",
                              youtube: "YouTube",
                              tiktok: "TikTok",
                            } as Record<string, string>
                          )[m.source] || "Uploaded"}
                        </span>
                        {m.duration && (
                          <span className="duration">{clock(m.duration)}</span>
                        )}
                        <span className="edit-hover">
                          <Scissors size={18} /> Open in editor
                        </span>
                      </button>
                      <div className="card-body">
                        <h3>{m.name}</h3>
                        <div className="meta">
                          {m.width
                            ? `${m.width} × ${m.height}`
                            : "Preparing media"}{" "}
                          <span>·</span> {size(m.size)}
                        </div>
                        <div className="card-footer">
                          <span>
                            {m.expiresAt
                              ? `${Math.max(0, Math.ceil((m.expiresAt - Date.now()) / 86400_000))} days left`
                              : m.status}
                          </span>
                          <div>
                            <button
                              aria-label={`Caption for ${m.name}`}
                              onClick={() => setCaption(m)}
                            >
                              <Captions size={17} />
                            </button>
                            {m.status === "ready" && (
                              <a
                                aria-label={`Download ${m.name}`}
                                href={fileUrl("media", m.id, "file", true)}
                              >
                                <Download size={17} />
                              </a>
                            )}
                            <button
                              aria-label={`Delete ${m.name}`}
                              disabled={busy || m.status === "processing"}
                              onClick={() => deleteMedia(m)}
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </div>
                      </div>
                    </article>
                  ))}
              {view === "media" && (
                <button
                  className="upload-card"
                  onClick={() => input.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    upload(e.dataTransfer.files[0]);
                  }}
                >
                  <span>
                    <Plus size={25} />
                  </span>
                  <strong>Add your next clip</strong>
                  <p>Drop a video here or browse files</p>
                  <small>Up to 300 MB · 15 minutes</small>
                </button>
              )}
              {view === "editor" &&
                projects
                  .filter((p) =>
                    p.name.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((p) => (
                    <ProjectCard
                      key={p.id}
                      project={p}
                      media={media.find((m) => m.id === p.mediaId)}
                      busy={busy}
                      onOpen={() => openProject(p.id)}
                      onDelete={() => deleteProject(p)}
                    />
                  ))}
              {view === "exports" &&
                exports
                  .filter((x) =>
                    x.name.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((x) => (
                    <article className="media-card" key={x.id}>
                      <button className="thumbnail" onClick={() => setWatch(x)}>
                        <img
                          src={fileUrl("export", x.id, "thumbnail")}
                          alt={x.name}
                        />
                        <span className="source-tag finished">
                          <Check size={12} /> Exported
                        </span>
                        <span className="duration">{clock(x.duration)}</span>
                      </button>
                      <div className="card-body">
                        <h3>{x.name}</h3>
                        <p className="caption-preview">
                          {x.caption || "No caption added"}
                        </p>
                        <div className="card-footer">
                          <span>{size(x.size)}</span>
                          <div>
                            <button
                              title="Preview caption"
                              aria-label={`Preview caption for ${x.name}`}
                              onClick={() => setCaptionPreview(x)}
                            >
                              <Captions size={18} />
                            </button>
                            <a
                              title="Download MP4"
                              href={fileUrl("export", x.id, "file", true)}
                            >
                              <Download size={18} />
                            </a>
                            <button
                              aria-label="Delete export"
                              onClick={() => {
                                if (
                                  confirm(
                                    "Delete this export? Your source and project will stay.",
                                  )
                                )
                                  attempt(async () => {
                                    await api(`/exports/${x.id}`, {
                                      method: "DELETE",
                                    });
                                    await refresh();
                                  });
                              }}
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </div>
                      </div>
                    </article>
                  ))}
            </div>
            {view !== "media" &&
              !(view === "exports" ? exports : projects).length && (
                <div className="empty">
                  <Film size={36} />
                  <h2>
                    {view === "exports"
                      ? "Your next edit belongs here."
                      : "Start with a video."}
                  </h2>
                  <p>
                    {view === "exports"
                      ? "Export a project to save your finished video and caption."
                      : "Choose a clip from the Media library to begin."}
                  </p>
                  <button className="subtle" onClick={() => setView("media")}>
                    Go to Media <ArrowUpRight size={16} />
                  </button>
                </div>
              )}
            {jobs.some((j) => j.status === "failed") && (
              <details className="job-errors">
                <summary>Recent processing issues</summary>
                {jobs
                  .filter((j) => j.status === "failed")
                  .slice(0, 5)
                  .map((j) => (
                    <p key={j.id}>
                      {j.type}: {j.error}
                    </p>
                  ))}
              </details>
            )}
          </section>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => {
          upload(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {importing && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Import video"
            className="modal"
          >
            <button
              className="close"
              aria-label="Close import"
              onClick={() => setImporting(false)}
            >
              <X />
            </button>
            <div className="modal-icon">
              <Download />
            </div>
            <h2>Bring your footage in.</h2>
            <p>
              Paste a public Instagram, YouTube or TikTok video link, or upload
              a video. Up to 15 minutes and 300 MB.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                attempt(async () => {
                  await api("/downloads", {
                    method: "POST",
                    body: JSON.stringify({ url, confirmed: permission }),
                  });
                  setImporting(false);
                  setUrl("");
                  await refresh();
                });
              }}
            >
              <label>
                Video link
                <input
                  type="url"
                  required
                  placeholder="Instagram, YouTube or TikTok URL"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={permission}
                  onChange={(e) => setPermission(e.target.checked)}
                  required
                />
                I own this content or have permission to use it.
              </label>
              <button className="primary" disabled={busy}>
                {busy ? (
                  <LoaderCircle className="spin" size={18} />
                ) : (
                  <Download size={18} />
                )}{" "}
                Import to Media
              </button>
            </form>
            <div className="divider">or</div>
            <button
              className="subtle wide"
              onClick={() => input.current?.click()}
              disabled={busy}
            >
              <Upload size={18} /> Upload from device
            </button>
            {error && (
              <p role="alert" className="inline-error">
                {error}
              </p>
            )}
          </section>
        </div>
      )}
      {caption && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Edit caption"
          >
            <button
              className="close"
              aria-label="Close caption"
              onClick={() => setCaption(null)}
            >
              <X />
            </button>
            <h2>Original caption</h2>
            <label>
              Video name
              <input
                value={caption.name}
                onChange={(e) =>
                  setCaption({ ...caption, name: e.target.value })
                }
              />
            </label>
            <label>
              Caption
              <textarea
                rows={8}
                value={caption.caption}
                onChange={(e) =>
                  setCaption({ ...caption, caption: e.target.value })
                }
              />
            </label>
            <button
              className="primary"
              onClick={() =>
                attempt(async () => {
                  await api(`/media/${caption.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({
                      name: caption.name,
                      caption: caption.caption,
                    }),
                  });
                  setCaption(null);
                  await refresh();
                })
              }
            >
              Save caption
            </button>
          </section>
        </div>
      )}
      {captionPreview && (
        <CaptionPreview
          key={captionPreview.id}
          item={captionPreview}
          onClose={() => setCaptionPreview(null)}
        />
      )}
      {watch && (
        <div className="modal-backdrop">
          <section
            className="modal video-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Preview export"
          >
            <button
              className="close"
              aria-label="Close preview"
              onClick={() => setWatch(null)}
            >
              <X />
            </button>
            <video src={fileUrl("export", watch.id)} controls autoPlay />
            <h3>{watch.name}</h3>
            <p>{watch.caption}</p>
          </section>
        </div>
      )}
    </div>
  );
}
