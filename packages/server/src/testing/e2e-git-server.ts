// Backend entry point for the Git E2E test (add-git-commits 7.1): the real app and engine,
// driven by the simulated LLM; task 1.1 changes two members.
import { startServer } from "../server.ts";
import { startMockLlm, type ToolCall } from "./mock-llm.ts";

/** The member paths listed in a task prompt ("- repo-api: `/path`"). */
function member(prompt: string, name: string): string {
  return new RegExp(`^- ${name}: \`([^\`]+)\``, "m").exec(prompt)?.[1] ?? `/missing/${name}`;
}

const llm = startMockLlm([], (prompt): ToolCall[] => {
  if (/^# Task 1\.1/m.test(prompt)) {
    return [
      { tool: "write", args: { filePath: `${member(prompt, "repo-api")}/src/reason.ts`, content: 'export const reason = "bloqueado";\n' } },
      { tool: "write", args: { filePath: `${member(prompt, "legado")}/src/aviso.ts`, content: "export const aviso = 1;\n" } },
    ];
  }
  return [];
});

await startServer({
  port: Number(process.env.STUDIO_PORT ?? 0),
  engineConfig: () => ({ provider: llm.providerConfig, model: "mock/m" }),
});
