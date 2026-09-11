import Fastify from "fastify";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import {
  randomBytes,
  randomUUID,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { createRepository } from "./repository.mjs";
import { createQueue } from "./jobs.mjs";
import { videoLink, initialEdit, validateEdit } from "../shared/validation.mjs";
import { cleanVideoName } from "../shared/names.mjs";

export async function createApp({
  dataDir = process.env.DATA_DIR || "runtime",
  logger = false,
  queueFactory = createQueue,
} = {}) {
  const root = path.resolve(dataDir);
  await mkdir(root, { recursive: true });
  const repo = createRepository(root),
    queue = queueFactory(repo, root);
  for (const kind of ["media", "project", "export"]) {
    for (const item of repo.list(kind)) {
      const name = cleanVideoName(item.name);
      if (name && name !== item.name)
        repo.put(kind, {
          ...item,
          name,
          ...(kind === "project" ? { revision: item.revision + 1 } : {}),
        });
    }
  }
  // Protect the async upload/artwork preparation window before a job is queued.
  const preparingProjects = new Map();
  const projectOperation = (handler) => async (req, reply) => {
    const id = req.params.id;
    preparingProjects.set(id, (preparingProjects.get(id) || 0) + 1);
    try {
      return await handler(req, reply);
    } finally {
      const count = preparingProjects.get(id) - 1;
      if (count) preparingProjects.set(id, count);
      else preparingProjects.delete(id);
    }
  };
  // One-time migration for development projects saved before Reel-only canvases.
  for (const project of repo.list("project")) {
    if (project.edit?.canvas?.aspectRatio !== "9:16") {
      project.edit.canvas.aspectRatio = "9:16";
      repo.put("project", { ...project, revision: project.revision + 1 });
    }
  }
  const app = Fastify({ logger, bodyLimit: 24 * 1024 * 1024 });
  const ttl =
    Math.max(1, Number(process.env.SOURCE_RETENTION_DAYS) || 7) * 86400_000;
  const sessions = new Map(),
    attempts = new Map();
  const password = process.env.WORKSPACE_PASSWORD;
  const host = process.env.HOST || "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && !password)
    throw new Error("WORKSPACE_PASSWORD is required for remote access.");
  await app.register(multipart, {
    limits: { fileSize: 300 * 1024 * 1024, files: 1, fields: 4 },
  });
  await app.register(staticPlugin, { root, serve: false });
  app.addHook("onRequest", async (req, reply) => {
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header("Cache-Control", "no-store");
    const origin = req.headers.origin;
    const allowed = [
      process.env.PUBLIC_ORIGIN || "http://localhost:4174",
      "http://127.0.0.1:4174",
    ];
    if (origin && !allowed.includes(origin))
      return reply.code(403).send({ error: "Origin not allowed" });
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.headers["sec-fetch-site"] === "cross-site"
    )
      return reply.code(403).send({ error: "Cross-site request rejected" });
    if (req.url.startsWith("/api/auth") || req.url === "/api/health") return;
    const token = /(?:^|;\s*)studio_session=([^;]+)/.exec(
      req.headers.cookie || "",
    )?.[1];
    if (password && (!token || (sessions.get(token) || 0) < Date.now()))
      return reply.code(401).send({ error: "Sign in to the workspace." });
  });
  app.setErrorHandler((err, req, reply) => {
    reply.code(err.statusCode || (err instanceof z.ZodError ? 400 : 400)).send({
      error: err instanceof z.ZodError ? err.issues[0].message : err.message,
    });
  });
  function get(kind, id) {
    const item = repo.get(kind, z.string().uuid().parse(id));
    if (!item) throw Object.assign(new Error("Not found"), { statusCode: 404 });
    return item;
  }
  function mediaReady(id) {
    const item = get("media", id);
    if (item.status !== "ready" || !existsSync(path.join(root, item.file)))
      throw new Error("Source is unavailable or expired.");
    return item;
  }
  app.get("/api/health", () => ({
    ok: true,
    phase: "development",
    storage: "sqlite-local",
  }));
  app.get("/api/auth", (req) => {
    const t = /(?:^|;\s*)studio_session=([^;]+)/.exec(
      req.headers.cookie || "",
    )?.[1];
    return {
      authenticated: !password || (sessions.get(t) || 0) > Date.now(),
      required: Boolean(password),
    };
  });
  app.post("/api/auth", (req, reply) => {
    const a = attempts.get(req.ip) || { count: 0, until: Date.now() + 60_000 };
    if (a.until < Date.now()) {
      a.count = 0;
      a.until = Date.now() + 60_000;
    }
    a.count++;
    attempts.set(req.ip, a);
    if (a.count > 8)
      return reply.code(429).send({ error: "Try again in a minute." });
    const hash = (v) =>
      createHash("sha256")
        .update(String(v || ""))
        .digest();
    if (password && !timingSafeEqual(hash(password), hash(req.body?.password)))
      return reply.code(401).send({ error: "Incorrect workspace password." });
    const token = randomBytes(32).toString("hex");
    sessions.set(token, Date.now() + 86400_000);
    reply.header(
      "Set-Cookie",
      `studio_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${process.env.PUBLIC_ORIGIN?.startsWith("https:") ? "; Secure" : ""}`,
    );
    return { authenticated: true };
  });
  app.get("/api/media", () => repo.list("media"));
  app.get("/api/jobs", () => repo.list("job").slice(0, 30));
  app.get("/api/jobs/:id", (req) => get("job", req.params.id));
  app.get("/api/projects", () => repo.list("project"));
  app.get("/api/exports", () => repo.list("export"));
  async function upload(req, extension) {
    const part = await req.file();
    if (!part) throw new Error("Choose a file.");
    const name = `${randomUUID()}${extension}`;
    const file = path.join(root, name);
    try {
      await pipeline(part.file, createWriteStream(file));
      if (part.file.truncated)
        throw new Error("File exceeds the 300 MB limit.");
    } catch (e) {
      await rm(file, { force: true });
      throw e;
    }
    return { name, originalName: part.filename.slice(0, 200) };
  }
  function importJob(item, payload) {
    return queue.add(
      "import",
      { ...payload, root, id: item.id },
      async (result) => {
        repo.put("media", {
          ...item,
          ...result,
          status: "ready",
          expiresAt: Date.now() + ttl,
        });
        return item.id;
      },
      async () => {
        repo.put("media", { ...item, status: "failed" });
        if (payload.input)
          await rm(path.join(root, payload.input), { force: true });
      },
    );
  }
  app.post("/api/media/uploads", async (req, reply) => {
    const file = await upload(req, ".upload");
    const media = repo.put("media", {
      name: file.originalName.replace(/\.[^.]+$/, ""),
      caption: "",
      source: "upload",
      status: "processing",
    });
    const job = importJob(media, { action: "import", input: file.name });
    return reply.code(202).send({ job, media });
  });
  app.post("/api/downloads", (req, reply) => {
    const { url, source, label } = videoLink(req.body?.url);
    if (req.body?.confirmed !== true)
      throw new Error("Confirm permission to use this video.");
    if (
      repo.list("job").filter((j) => ["queued", "running"].includes(j.status))
        .length >= 10
    )
      return reply.code(429).send({ error: "Queue is full. Please wait." });
    const media = repo.put("media", {
      name: `${label} video`,
      caption: "",
      source,
      sourceUrl: url,
      status: "processing",
    });
    const job = importJob(media, { action: "download", url, platform: source });
    return reply.code(202).send({ job, media });
  });
  app.patch("/api/media/:id", (req) => {
    const item = get("media", req.params.id);
    const data = z
      .object({
        name: z.string().min(1).max(200),
        caption: z.string().max(8000),
      })
      .parse(req.body);
    return repo.put("media", { ...item, ...data });
  });
  app.delete("/api/media/:id", async (req) => {
    const item = get("media", req.params.id);
    const linked = repo.list("project").filter((p) => p.mediaId === item.id);
    if (item.status === "processing" || linked.some((p) => projectBusy(p.id)))
      throw Object.assign(
        new Error(
          "This video has processing in progress. Wait for it to finish before deleting.",
        ),
        { statusCode: 409 },
      );
    if (linked.length && req.query.deleteEdits !== "true")
      throw Object.assign(
        new Error(
          `This video has ${linked.length} saved edit(s). Confirm deletion of the video and linked edits, or delete those edits in Editor first. Exported videos will stay.`,
        ),
        { statusCode: 409 },
      );
    if (linked.length && Number(req.query.expectedEdits) !== linked.length)
      throw Object.assign(
        new Error(
          "The linked edits changed. Refresh the library and confirm deletion again.",
        ),
        { statusCode: 409 },
      );
    const records = [{ kind: "media", ...item }, ...editRecords(linked)];
    await removeRecords(records);
    return { ok: true, deletedEdits: linked.length };
  });
  function projectBusy(id) {
    return (
      preparingProjects.has(id) ||
      repo
        .list("job")
        .some(
          (j) =>
            ["queued", "running"].includes(j.status) &&
            (j.projectId === id ||
              (!j.projectId && ["render", "audio"].includes(j.type))),
        )
    );
  }
  function editRecords(projects) {
    const ids = new Set(projects.map((p) => p.id));
    return [
      ...projects.map((p) => ({ kind: "project", ...p })),
      ...repo
        .list("audio")
        .filter((a) => ids.has(a.projectId))
        .map((a) => ({ kind: "audio", ...a })),
    ];
  }
  async function removeRecords(records) {
    // Remove references atomically before yielding; a stale autosave cannot recreate them.
    repo.removeMany(records);
    for (const item of records)
      for (const key of ["file", "audioFile", "thumbnail"]) {
        if (item[key])
          await rm(path.join(root, item[key]), { force: true }).catch(
            (error) => {
              // The record is deleted even if Windows temporarily holds a file open.
              app.log.warn(
                { error, file: item[key] },
                "Deferred orphan-file cleanup required",
              );
            },
          );
      }
  }
  app.delete("/api/projects/:id", async (req) => {
    const project = get("project", req.params.id);
    if (projectBusy(project.id))
      throw Object.assign(
        new Error(
          "This edit is processing. Wait for it to finish before deleting.",
        ),
        { statusCode: 409 },
      );
    await removeRecords(editRecords([project]));
    return { ok: true };
  });
  app.post("/api/projects", (req) => {
    const media = mediaReady(req.body?.mediaId);
    return repo.put("project", {
      mediaId: media.id,
      name: `${media.name} · edit`,
      caption: media.caption,
      edit: initialEdit(media.duration * 1000),
      revision: 1,
    });
  });
  app.get("/api/projects/:id", (req) => {
    const project = get("project", req.params.id);
    const media = mediaReady(project.mediaId);
    repo.put("media", { ...media, expiresAt: Date.now() + ttl });
    return { ...project, media };
  });
  app.patch("/api/projects/:id", (req) => {
    const item = get("project", req.params.id),
      media = mediaReady(item.mediaId);
    const data = z
      .object({
        name: z.string().min(1).max(200),
        caption: z.string().max(8000),
        revision: z.number().int(),
        edit: z.unknown(),
      })
      .parse(req.body);
    if (data.revision !== item.revision)
      throw Object.assign(
        new Error(
          "This project changed in another tab. Reopen it before saving.",
        ),
        { statusCode: 409 },
      );
    const edit = validateEdit(data.edit, media.duration * 1000);
    if (edit.audio.derivativeId) {
      const a = get("audio", edit.audio.derivativeId);
      if (a.projectId !== item.id || a.status !== "ready")
        throw new Error("Audio is not ready for this project.");
    }
    return repo.put("project", {
      ...item,
      ...data,
      edit,
      revision: item.revision + 1,
    });
  });
  app.post(
    "/api/projects/:id/audio",
    projectOperation(async (req, reply) => {
      const project = get("project", req.params.id),
        media = mediaReady(project.mediaId);
      const file = await upload(req, ".audio-upload");
      const audio = repo.put("audio", {
        projectId: project.id,
        status: "processing",
      });
      const job = queue.add(
        "audio",
        {
          action: "audio",
          projectId: project.id,
          mediaId: media.id,
          root,
          input: file.name,
          id: audio.id,
          duration: media.duration,
        },
        (result) => {
          repo.put("audio", { ...audio, ...result, status: "ready" });
          return audio.id;
        },
        () => rm(path.join(root, file.name), { force: true }),
      );
      return reply.code(202).send({ job });
    }),
  );
  app.post(
    "/api/projects/:id/renders",
    projectOperation(async (req, reply) => {
      const project = get("project", req.params.id),
        media = mediaReady(project.mediaId);
      const spec = validateEdit(project.edit, media.duration * 1000);
      const enabledDuration = spec.segments
        .filter((s) => s.enabled)
        .reduce((t, s) => t + s.endMs - s.startMs, 0);
      if (enabledDuration < 3000)
        throw new Error("Keep at least 3 seconds for the Instagram export.");
      const data = z
        .object({
          revision: z.number().int(),
          background: z.string().max(8_000_000),
          overlays: z.array(z.string().max(8_000_000)).max(12),
        })
        .parse(req.body);
      if (data.revision !== project.revision)
        throw new Error("Save the latest edit before rendering.");
      if (data.overlays.length !== spec.textOverlays.length)
        throw new Error("Overlay count does not match project.");
      const id = randomUUID();
      const files = [];
      for (const [i, png] of [data.background, ...data.overlays].entries()) {
        if (!png.startsWith("data:image/png;base64,"))
          throw new Error("Expected PNG artwork.");
        const file = `${id}-art-${i}.png`;
        await writeFile(
          path.join(root, file),
          Buffer.from(png.split(",")[1], "base64"),
        );
        files.push(file);
      }
      let audioFile = null;
      if (["remove-vocals", "vocals-only"].includes(spec.audio.mode)) {
        const audio = get("audio", spec.audio.derivativeId);
        if (audio.projectId !== project.id || audio.status !== "ready")
          throw new Error("Apply processed audio first.");
        audioFile = audio.file;
      }
      const clean = async () => {
        for (const f of files) await rm(path.join(root, f), { force: true });
      };
      const job = queue.add(
        "render",
        {
          action: "render",
          projectId: project.id,
          mediaId: media.id,
          root,
          id,
          input: media.file,
          spec,
          audioFile,
          art: files,
        },
        async (result) => {
          repo.put("export", {
            id,
            projectId: project.id,
            name: project.name,
            caption: project.caption,
            edit: spec,
            ...result,
          });
          await clean();
          return id;
        },
        clean,
      );
      return reply.code(202).send({ job });
    }),
  );
  app.delete("/api/exports/:id", async (req) => {
    const item = get("export", req.params.id);
    for (const key of ["file", "thumbnail"])
      if (item[key]) await rm(path.join(root, item[key]), { force: true });
    repo.remove("export", item.id);
    return { ok: true };
  });
  app.get("/api/files/:kind/:id/:type", (req, reply) => {
    const { kind, id, type } = req.params;
    if (
      !["media", "export", "audio"].includes(kind) ||
      !["file", "thumbnail", "audioFile", "caption"].includes(type)
    )
      throw new Error("Invalid file route");
    const item = get(kind, id);
    if (type === "caption")
      return reply
        .type("text/plain; charset=utf-8")
        .header("Content-Disposition", 'attachment; filename="caption.txt"')
        .send(item.caption || "");
    if (!item[type] || !existsSync(path.join(root, item[type])))
      return reply.code(404).send({ error: "File unavailable" });
    if (req.query.download)
      reply.header(
        "Content-Disposition",
        `attachment; filename="${item.id}${path.extname(item[type])}"`,
      );
    return reply.sendFile(item[type], { cacheControl: false });
  });
  const cleaner = setInterval(async () => {
    for (const item of repo.list("media"))
      if (
        item.expiresAt < Date.now() &&
        item.status === "ready" &&
        !queue.busy
      ) {
        for (const key of ["file", "audioFile", "thumbnail"])
          if (item[key]) await rm(path.join(root, item[key]), { force: true });
        repo.put("media", { ...item, status: "expired" });
      }
    for (const [t, expiry] of sessions)
      if (expiry < Date.now()) sessions.delete(t);
    for (const [ip, a] of attempts)
      if (a.until < Date.now()) attempts.delete(ip);
  }, 60_000);
  cleaner.unref();
  app.addHook("onClose", () => {
    clearInterval(cleaner);
    repo.close();
  });
  return app;
}
