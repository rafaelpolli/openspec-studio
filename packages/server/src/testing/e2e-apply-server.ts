// Backend entry point for the apply E2E test (add-visual-apply 6.1): the real app and the
// real embedded engine, driven by the simulated LLM with one script per task.
import { startServer } from "../server.ts";
import { startMockLlm, type ToolCall } from "./mock-llm.ts";

/** The member paths listed in a task prompt ("- repo-api: `/path`"). */
function member(prompt: string, name: string): string {
  return new RegExp(`^- ${name}: \`([^\`]+)\``, "m").exec(prompt)?.[1] ?? `/missing/${name}`;
}

const llm = startMockLlm([], (prompt): ToolCall[] => {
  const task = /^# Task ([\d.]+)/m.exec(prompt)?.[1];
  const api = member(prompt, "repo-api");
  const web = member(prompt, "repo-web");
  if (task === "1.1") {
    return [{ tool: "write", args: { filePath: `${api}/src/reason.ts`, content: 'export const reason = "bloqueado";\n' } }];
  }
  if (task === "1.2") {
    return [
      { tool: "bash", args: { command: "echo lint-web", description: "lint", workdir: web } },
      { tool: "write", args: { filePath: `${web}/src/msg.ts`, content: "export const msg = 'Conta bloqueada';\n" } },
    ];
  }
  return [];
});

await startServer({
  port: Number(process.env.STUDIO_PORT ?? 0),
  engineConfig: () => ({ provider: llm.providerConfig, model: "mock/m" }),
});
