import { describe, expect, test } from "bun:test";
import { AgentOutputError, parseAssumptions, parseDecisions } from "./decisions.ts";
import { buildDecisionsPrompt } from "./prompt.ts";

const decision = (id: string, recommended = 0, options = ["A", "B"]) => ({ id, question: `${id}?`, options: options.map((label) => ({ label })), recommended });

describe("2.1 checkpoint de decisões", () => {
  test("the prompt asks for the JSON file only, from the description and the code", () => {
    const { system, text } = buildDecisionsPrompt({
      change: "add-export",
      description: "Exportar dados do usuário em CSV",
      members: [{ name: "api", path: "/w/api" }],
      outputFile: "/w/openspec/changes/add-export/.studio/decisoes.json",
    });
    expect(system).toContain("agente de planejamento");
    expect(text).toMatchSnapshot();
  });

  test("valid decisions come back as they are, with optional fields only when present", () => {
    const raw = JSON.stringify({ decisions: [{ ...decision("campos", 1), why: "privacidade" }, decision("formato")] });
    expect(parseDecisions(raw)).toEqual([
      { id: "campos", question: "campos?", why: "privacidade", options: [{ label: "A" }, { label: "B" }], recommended: 1 },
      { id: "formato", question: "formato?", options: [{ label: "A" }, { label: "B" }], recommended: 0 },
    ]);
    expect(parseDecisions('{"decisions": []}')).toEqual([]);
  });

  test("missing, not JSON, wrong shape, more than 8, repeated ids, recommendation out of range: failures with a message", () => {
    expect(() => parseDecisions(undefined)).toThrow("o agente terminou sem escrever a lista de decisões");
    expect(() => parseDecisions("{")).toThrow("não é JSON");
    expect(() => parseDecisions('{"decisoes": []}')).toThrow("não segue o formato pedido");
    expect(() => parseDecisions(JSON.stringify({ decisions: [{ ...decision("x"), options: [{ label: "só uma" }] }] }))).toThrow("não segue o formato");
    expect(() => parseDecisions(JSON.stringify({ decisions: Array.from({ length: 9 }, (_, i) => decision(`d${i}`)) }))).toThrow(AgentOutputError);
    expect(() => parseDecisions(JSON.stringify({ decisions: [decision("x"), decision("x")] }))).toThrow("decisão repetida: x");
    expect(() => parseDecisions(JSON.stringify({ decisions: [decision("x", 2)] }))).toThrow("a recomendação de x não é uma das opções");
  });

  test("assumptions: a missing or unusable file is an empty list", () => {
    expect(parseAssumptions(JSON.stringify({ assumptions: [{ text: " roda em segundo plano " }, { text: "t", question: "q?" }] }))).toEqual([
      { text: "roda em segundo plano" },
      { text: "t", question: "q?" },
    ]);
    expect(parseAssumptions(undefined)).toEqual([]);
    expect(parseAssumptions("não é json")).toEqual([]);
    expect(parseAssumptions('{"assumptions": [{"texto": "x"}]}')).toEqual([]);
  });
});
