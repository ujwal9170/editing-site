export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
export const fileUrl = (
  kind: string,
  id: string,
  type = "file",
  download = false,
) => `/api/files/${kind}/${id}/${type}${download ? "?download=1" : ""}`;
export const clock = (seconds = 0) =>
  `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
export const size = (bytes = 0) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
export async function awaitJob(
  id: string,
  onProgress: (job: any) => void = () => {},
) {
  for (;;) {
    const job = await api(`/jobs/${id}`);
    onProgress(job);
    if (job.status === "ready") return job;
    if (job.status === "failed") throw new Error(job.error);
    await new Promise((r) => setTimeout(r, 1200));
  }
}
