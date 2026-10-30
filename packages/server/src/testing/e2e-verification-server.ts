// Backend entry point for the verification E2E test (add-change-verification 8.1): the real app
// and engine, driven by the simulated LLM. Task 1.1 fixes `soma`; task 2.1 (the test task the
// verification generates) writes the missing test; the verification points each scenario to
// the test that exists in the member at that moment.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../server.ts";
import { startMockLlm, type ToolCall } from "./mock-llm.ts";

/** The member paths listed in a prompt ("- app: `/path`"). */
function member(prompt: string, name: string): string {
  return new RegExp(`^- ${name}: \`([^\`]+)\``, "m").exec(prompt)?.[1] ?? `/missing/${name}`;
}

/** The trace answer for a scenario whose test is `name` in `file`, or "sem-teste" when it is not there. */
function traceItem(app: string, id: string, file: string, name: string) {
  const path = join(app, file);
  const line = existsSync(path) ? readFileSync(path, "utf8").split("\n").findIndex((l) => l.includes(name)) + 1 : 0;
  return line > 0 ? { id, kind: "teste", member: "app", file, line, name } : { id, kind: "sem-teste", note: "nenhum teste encontrado" };
}

const llm = startMockLlm([], (prompt): ToolCall[] => {
  const app = member(prompt, "app");
  if (/^# Task 1\.1/m.test(prompt)) {
    return [{ tool: "write", args: { filePath: `${app}/src/soma.ts`, content: "export const soma = (a: number, b: number) => a + b;\n" } }];
  }
  if (/^# Task 2\.1/m.test(prompt)) {
    const test = ['import { expect, test } from "bun:test";', 'import { soma } from "./soma.ts";', "", 'test("Soma com zero", () => {', "  expect(soma(0, 5)).toBe(5);", "});", ""];
    return [{ tool: "write", args: { filePath: `${app}/src/zero.test.ts`, content: test.join("\n") } }];
  }
  if (/^# Verificação da change/m.test(prompt)) {
    const output = /Escreva apenas o arquivo `([^`]+)`/.exec(prompt)?.[1];
    if (!output) return [];
    const items = [
      traceItem(app, "calc/Somar/Soma dois números", "src/soma.test.ts", "Soma dois números"),
      traceItem(app, "calc/Somar/Soma com zero", "src/zero.test.ts", "Soma com zero"),
    ];
    return [{ tool: "write", args: { filePath: output, content: JSON.stringify({ items }) } }];
  }
  return [];
});

await startServer({
  port: Number(process.env.STUDIO_PORT ?? 0),
  engineConfig: () => ({ provider: llm.providerConfig, model: "mock/m" }),
});
