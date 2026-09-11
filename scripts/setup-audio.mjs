import {
  mkdir,
  readdir,
  copyFile,
  writeFile,
  readFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const digest =
  "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b";
await mkdir("public/vendor/ort", { recursive: true });
await mkdir("public/models", { recursive: true });
await copyFile(
  "public/audio/ONNX-LICENSE.txt",
  "public/vendor/ort/LICENSE",
);
for (const name of await readdir("node_modules/onnxruntime-web/dist"))
  if (/\.(wasm|mjs|js)$/.test(name))
    await copyFile(
      path.join("node_modules/onnxruntime-web/dist", name),
      path.join("public/vendor/ort", name),
    );
const file = "public/models/Kim_Vocal_2.onnx";
const valid = (buffer) =>
  createHash("sha256").update(buffer).digest("hex") === digest;
let cached;
try {
  cached = await readFile(file);
} catch {}
if (!cached || !valid(cached)) {
  console.log("Downloading pinned Kim Vocal 2 model (66.8 MB)…");
  const response = await fetch(
    "https://huggingface.co/Blane187/all_public_uvr_models/resolve/main/Kim_Vocal_2.onnx",
  );
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!valid(bytes))
    throw new Error(
      "Model checksum changed. Review the artifact before upgrading.",
    );
  await writeFile(file, bytes);
}
console.log(
  "Model verified and matching ONNX Runtime 1.21.0 assets installed.",
);
