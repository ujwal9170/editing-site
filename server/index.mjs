import { createApp } from "./app.mjs";
const app = await createApp({ logger: process.env.LOG_LEVEL === "debug" });
await app.listen({
  host: "127.0.0.1",
  port: Number(process.env.API_PORT || 4175),
});
process.on("SIGTERM", () => app.close());
