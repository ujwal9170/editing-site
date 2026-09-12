import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRepository } from "../server/repository.mjs";
import { createUser } from "../server/users.mjs";
import { createApp } from "../server/app.mjs";
import { initialEdit } from "../shared/validation.mjs";
import { cleanVideoName } from "../shared/names.mjs";

async function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "frame-lifecycle-"));
  const repo = createRepository(root);
  const owner = await createUser(repo, "owner", "owner-password");
  const userId = owner.id;
  const media = repo.put("media", {
    userId,
    name: "Video by channel_name",
    caption: "keep caption",
    status: "ready",
    duration: 6,
    file: "source.mp4",
    thumbnail: "source.jpg",
    audioFile: "source.wav",
  });
  const edit = repo.put("project", {
    userId,
    mediaId: media.id,
    name: "Video by channel_name · edit",
    caption: "keep edit caption",
    revision: 1,
    edit: initialEdit(6000),
  });
  const second = repo.put("project", {
    userId,
    mediaId: media.id,
    name: "Another edit",
    caption: "",
    revision: 1,
    edit: initialEdit(6000),
  });
  const audio = repo.put("audio", {
    userId,
    projectId: edit.id,
    status: "ready",
    file: "stem.wav",
  });
  const output = repo.put("export", {
    userId,
    projectId: edit.id,
    name: "Video by channel_name · edit",
    caption: "export caption",
    file: "export.mp4",
    thumbnail: "export.jpg",
  });
  for (const file of [
    "source.mp4",
    "source.jpg",
    "source.wav",
    "stem.wav",
    "export.mp4",
    "export.jpg",
  ])
    writeFileSync(path.join(root, file), "test fixture");
  const app = await createApp({ dataDir: root });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth",
    payload: { username: "owner", password: "owner-password" },
  });
  const cookie = login.headers["set-cookie"].split(";")[0];
  // Every request in these tests runs as the owner of the fixture records.
  const inject = (options) =>
    app.inject(
      typeof options === "string"
        ? { url: options, headers: { cookie } }
        : { ...options, headers: { ...options.headers, cookie } },
    );
  t.after(async () => {
    await app.close();
    repo.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, repo, app, inject, userId, media, edit, second, audio, output };
}

test("existing names lose only the leading Video by prefix", async (t) => {
  const f = await fixture(t);
  assert.equal(cleanVideoName("My Video by Someone"), "My Video by Someone");
  assert.equal(f.repo.get("media", f.media.id).name, "channel_name");
  assert.equal(f.repo.get("project", f.edit.id).name, "channel_name · edit");
  assert.equal(f.repo.get("project", f.edit.id).revision, 2);
  assert.equal(f.repo.get("export", f.output.id).name, "channel_name · edit");
  assert.equal(f.repo.get("export", f.output.id).caption, "export caption");
});

test("deleting an edit removes its stem but preserves source, other edits and exports", async (t) => {
  const f = await fixture(t);
  const response = await f.inject({
    method: "DELETE",
    url: `/api/projects/${f.edit.id}`,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(f.repo.get("project", f.edit.id), null);
  assert.equal(f.repo.get("audio", f.audio.id), null);
  assert.ok(f.repo.get("project", f.second.id));
  assert.ok(f.repo.get("media", f.media.id));
  assert.ok(f.repo.get("export", f.output.id));
  assert.equal(existsSync(path.join(f.root, "stem.wav")), false);
  assert.equal(existsSync(path.join(f.root, "source.mp4")), true);
  assert.equal(existsSync(path.join(f.root, "export.mp4")), true);
  assert.equal(
    (
      await f.inject({
        method: "PATCH",
        url: `/api/projects/${f.edit.id}`,
        payload: f.edit,
      })
    ).statusCode,
    404,
  );
});

test("media with edits requires explicit current-count confirmation and preserves exports", async (t) => {
  const f = await fixture(t);
  const url = `/api/media/${f.media.id}`;
  assert.equal((await f.inject({ method: "DELETE", url })).statusCode, 409);
  assert.equal(
    (
      await f.inject({
        method: "DELETE",
        url: `${url}?deleteEdits=true&expectedEdits=1`,
      })
    ).statusCode,
    409,
  );
  assert.ok(f.repo.get("media", f.media.id));
  assert.ok(f.repo.get("project", f.edit.id));
  const response = await f.inject({
    method: "DELETE",
    url: `${url}?deleteEdits=true&expectedEdits=2`,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().deletedEdits, 2);
  for (const [kind, item] of [
    ["media", f.media],
    ["project", f.edit],
    ["project", f.second],
    ["audio", f.audio],
  ])
    assert.equal(f.repo.get(kind, item.id), null);
  assert.equal(existsSync(path.join(f.root, "source.mp4")), false);
  assert.equal(existsSync(path.join(f.root, "stem.wav")), false);
  assert.equal(
    (await f.inject(`/api/files/export/${f.output.id}/file`)).statusCode,
    200,
  );
});

test("active processing prevents deletion until the relevant job finishes", async (t) => {
  const f = await fixture(t);
  const job = f.repo.put("job", {
    type: "render",
    status: "running",
    projectId: f.edit.id,
  });
  assert.equal(
    (
      await f.inject({
        method: "DELETE",
        url: `/api/projects/${f.edit.id}`,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await f.inject({
        method: "DELETE",
        url: `/api/media/${f.media.id}?deleteEdits=true&expectedEdits=2`,
      })
    ).statusCode,
    409,
  );
  f.repo.put("job", { ...job, status: "ready" });
  assert.equal(
    (
      await f.inject({
        method: "DELETE",
        url: `/api/projects/${f.edit.id}`,
      })
    ).statusCode,
    200,
  );
});
