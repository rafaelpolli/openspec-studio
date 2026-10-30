import { describe, expect, test } from "bun:test";
import type { SpecScenario } from "@studio/shared";
import { buildVerificationPrompt, parseTrace, TraceError } from "./prompt.ts";

const scenario = (requirement: string, name: string): SpecScenario => ({
  id: `git-repositories/${requirement}/${name}`,
  capability: "git-repositories",
  requirement,
  name,
  text: `- **WHEN** ${name}\n- **THEN** ok`,
});
const scenarios = [scenario("Inicializar Git", "Pré-visualização"), scenario("Inicializar Git", "Confirmar"), scenario("Estado", "Limpo")];

describe("3.2 prompt e trace.json", () => {
  test("the prompt lists every scenario by id with its text, the members and the output file", () => {
    const { system, text } = buildVerificationPrompt({
      change: "add-git",
      changeDir: "/r/openspec/changes/add-git",
      members: [{ name: "studio", path: "/w/studio" }],
      scenarios: scenarios.slice(0, 2),
      outputFile: "/data/verify/v1/trace.json",
    });
    expect(system).toContain("nunca altera nada nem roda comandos");
    expect(text).toMatchSnapshot();
  });

  test("Agente aponta o teste: a full 'teste' answer becomes evidence", () => {
    const raw = JSON.stringify({
      items: [{ id: scenarios[0]!.id, kind: "teste", member: "studio", file: "src/git/init.test.ts", line: 15, name: "Pré-visualização: x", note: " ok " }],
    });
    expect(parseTrace(raw, scenarios).get(scenarios[0]!.id)).toEqual({
      trace: "teste",
      evidence: { member: "studio", file: "src/git/init.test.ts", line: 15, name: "Pré-visualização: x" },
      note: "ok",
    });
  });

  test("Cenário esquecido: missing ids are sem-teste; unknown ids are dropped; the first answer wins", () => {
    const raw = JSON.stringify({
      items: [
        { id: "inventado/X/Y", kind: "teste", member: "studio", file: "a.ts", line: 1, name: "n" },
        { id: scenarios[1]!.id, kind: "manual" },
        { id: scenarios[1]!.id, kind: "sem-teste" },
        { id: scenarios[2]!.id, kind: "teste", member: "studio" },
      ],
    });
    const trace = parseTrace(raw, scenarios);
    expect([...trace.keys()].sort()).toEqual(scenarios.map((s) => s.id).sort());
    expect(trace.get(scenarios[0]!.id)).toEqual({ trace: "sem-teste" });
    expect(trace.get(scenarios[1]!.id)).toEqual({ trace: "manual" });
    // A "teste" without file, line or name has no evidence: it is checked as invalid later.
    expect(trace.get(scenarios[2]!.id)).toEqual({ trace: "teste" });
  });

  test("an invalid trace.json fails with a message", () => {
    expect(() => parseTrace("não é json", scenarios)).toThrow(TraceError);
    expect(() => parseTrace('{"itens": []}', scenarios)).toThrow("não segue o formato pedido");
    expect(() => parseTrace('{"items": [{"id": "x", "kind": "talvez"}]}', scenarios)).toThrow("não segue o formato pedido");
  });
});
