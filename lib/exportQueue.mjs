// App-owned queue, independent of any mounted editor. Dependencies are injected
// so ordering, cancellation and immutable snapshots can be tested without codecs.
export function createExportQueue(execute) {
  let rows = [],
    active = false;
  const listeners = new Set();
  const publish = () => listeners.forEach((fn) => fn());
  async function drain() {
    if (active) return;
    active = true;
    try {
      for (;;) {
        const row = rows.find((r) => r.status === "queued");
        if (!row) break;
        row.status = "running";
        const controller = new AbortController();
        row.controller = controller;
        publish();
        try {
          const result = await execute(row.payload, {
            signal: controller.signal,
            progress(detail) {
              row.detail = detail;
              publish();
            },
            saving() {
              controller.signal.throwIfAborted();
              row.status = "saving";
              row.detail = "Saving finished MP4…";
              publish();
            },
          });
          controller.signal.throwIfAborted();
          row.result = result;
          row.status = "done";
          row.detail = "Export ready in Edited videos.";
        } catch (e) {
          row.status = controller.signal.aborted ? "cancelled" : "failed";
          row.detail = controller.signal.aborted
            ? "Export cancelled."
            : e.message || "Export failed.";
        } finally {
          delete row.controller;
          delete row.payload;
          publish();
        }
      }
    } finally {
      active = false;
    }
  }
  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    list() {
      return rows.map(({ controller, payload, ...row }) => ({ ...row }));
    },
    add(payload) {
      if (
        rows.filter((r) => ["queued", "running", "saving"].includes(r.status))
          .length >= 10
      )
        throw new Error("Queue full. Wait for an export to finish.");
      const id = crypto.randomUUID();
      rows.push({
        id,
        name: payload.project.name,
        quality: payload.quality,
        status: "queued",
        detail: "Waiting for this device…",
        payload: structuredClone(payload),
      });
      publish();
      void drain();
      return id;
    },
    cancel(id) {
      const row = rows.find((r) => r.id === id);
      if (!row || row.status === "saving") return false;
      if (row.status === "queued") {
        row.status = "cancelled";
        row.detail = "Export cancelled.";
        delete row.payload;
      }
      if (row.status === "running") row.controller.abort();
      publish();
      return true;
    },
    dismiss(id) {
      rows = rows.filter(
        (r) =>
          r.id !== id || ["queued", "running", "saving"].includes(r.status),
      );
      publish();
    },
    clear() {
      for (const row of rows) row.controller?.abort();
      rows = [];
      publish();
    },
  };
}
