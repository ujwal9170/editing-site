"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Download, X } from "lucide-react";
import { fileUrl } from "@/lib/api";
import type { Export } from "@/lib/types";

export default function CaptionPreview({
  item,
  onClose,
}: {
  item: Export;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  const [status, setStatus] = useState("");
  const [copying, setCopying] = useState(false);
  const hasCaption = Boolean(item.caption?.trim());

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  async function copyCaption() {
    setCopying(true);
    setStatus("");
    try {
      await navigator.clipboard.writeText(item.caption);
      setStatus("Caption copied!");
    } catch {
      text.current?.focus();
      text.current?.select();
      setStatus(
        "Clipboard access is blocked. The caption is selected — press Ctrl+C or use your device's Copy option.",
      );
    } finally {
      setCopying(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="modal caption-dialog"
      aria-labelledby="caption-preview-title"
      onClose={onClose}
    >
      <button
        className="close"
        aria-label="Close caption preview"
        onClick={onClose}
      >
        <X />
      </button>
      <div className="caption-dialog-header">
        <h2 id="caption-preview-title">Caption preview</h2>
        <button
          className="subtle"
          onClick={copyCaption}
          disabled={!hasCaption || copying}
        >
          {status === "Caption copied!" ? (
            <Check size={18} />
          ) : (
            <Copy size={18} />
          )}
          {copying
            ? "Copying…"
            : status === "Caption copied!"
              ? "Copied!"
              : "Copy caption"}
        </button>
      </div>
      <p className="caption-video-name">{item.name}</p>
      {hasCaption ? (
        <textarea
          ref={text}
          className="caption-full-text"
          aria-label="Full caption"
          readOnly
          value={item.caption}
          rows={12}
        />
      ) : (
        <p className="caption-empty">No caption added to this video.</p>
      )}
      <p className="caption-copy-status" role="status" aria-live="polite">
        {status}
      </p>
      {hasCaption && (
        <a className="subtle" href={fileUrl("export", item.id, "caption")}>
          <Download size={16} /> Download caption (.txt)
        </a>
      )}
    </dialog>
  );
}
