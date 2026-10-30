import { startServer } from "./server.ts";

await startServer({ port: Number(process.env.STUDIO_PORT ?? 4317) });
