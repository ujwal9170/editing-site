import { useEffect, useRef } from "react";
import type { Media } from "./types";

export function useWebMCP(media: Media[], authenticated: boolean | null) {
  const state = useRef({ media, authenticated });
  state.current = { media, authenticated };
  useEffect(() => {
    const context = (
      document as Document & {
        modelContext?: {
          registerTool: (
            tool: unknown,
            options: { signal: AbortSignal },
          ) => void | Promise<void>;
        };
      }
    ).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    Promise.resolve(
      context.registerTool(
        {
          name: "list_workspace_media",
          title: "List Media library",
          description:
            "Read the videos currently shown in the workspace Media library.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute(input: unknown) {
            if (
              !input ||
              typeof input !== "object" ||
              Array.isArray(input) ||
              Object.keys(input).length
            )
              throw new Error("Expected an empty object.");
            if (!state.current.authenticated)
              throw new Error("Sign in to the workspace.");
            return state.current.media.map(
              ({ id, name, status, duration }) => ({
                id,
                name,
                status,
                duration,
              }),
            );
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => {});
    return () => lifecycle.abort();
  }, []);
}
