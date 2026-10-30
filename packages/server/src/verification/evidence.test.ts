import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEvidence } from "./evidence.ts";

const dir = mkdtempSync(join(tmpdir(), "studio-evidence-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const studio = join(dir, "studio");
mkdirSync(join(studio, "src"), { recursive: true });
mkdirSync(join(dir, "outro"), { recursive: true });
writeFileSync(join(dir, "outro", "a.test.ts"), 'test("Confirmar", () => {});\n');
writeFileSync(
  join(studio, "src", "init.test.ts"),
  [
    'describe("3.1 inicializar Git", () => {', // 1
    "  test(", // 2
    '    "Pré-visualização: node_modules and dist ignored",', // 3
    "    async () => {},", // 4
    "  );", // 5
    '  test("Arquivo \\"secreto\\" fica fora", () => {});', // 6
    "});", // 7
  ].join("\n"),
);
const members = [{ name: "studio", path: studio }];
const ev = (file: string, line: number, name: string, member = "studio") => ({ member, file, line, name });

describe("3.3 conferência das evidências", () => {
  test("a valid evidence: the name a few lines after the declaration line", () => {
    const check = checkEvidence(members, ev("src/init.test.ts", 2, "Pré-visualização: node_modules and dist ignored"));
    expect(check).toEqual({
      ok: true,
      member: members[0]!,
      path: join(studio, "src", "init.test.ts"),
      evidence: ev("src/init.test.ts", 2, "Pré-visualização: node_modules and dist ignored"),
    });
  });

  test("the describe prefix and escaped quotes are tolerated; the name found is kept", () => {
    const check = checkEvidence(members, ev("src/init.test.ts", 1, "3.1 inicializar Git > Pré-visualização: node_modules and dist ignored"));
    expect(check.ok && check.evidence.name).toBe("Pré-visualização: node_modules and dist ignored");
    const quoted = checkEvidence(members, ev("src/init.test.ts", 6, 'Arquivo \\"secreto\\" fica fora'));
    expect(quoted.ok).toBe(true);
  });

  test("Teste inexistente: a name far from the line, or a line past the end", () => {
    expect(checkEvidence(members, ev("src/init.test.ts", 7, "Arquivo"))).toEqual({ ok: false, reason: "o nome do teste não aparece perto da linha 7" });
    expect(checkEvidence(members, ev("src/init.test.ts", 200, "x y z"))).toEqual({
      ok: false,
      reason: "src/init.test.ts tem 7 linhas, e a evidência aponta a linha 200",
    });
  });

  test("Arquivo fora do membro, a missing file, an unknown member, no evidence", () => {
    expect(checkEvidence(members, ev("../outro/a.test.ts", 1, "Confirmar"))).toEqual({ ok: false, reason: "../outro/a.test.ts está fora do membro studio" });
    expect(checkEvidence(members, ev("src/nao.test.ts", 1, "Confirmar"))).toEqual({ ok: false, reason: "src/nao.test.ts não existe em studio" });
    expect(checkEvidence(members, ev("src", 1, "Confirmar"))).toEqual({ ok: false, reason: "src não existe em studio" });
    expect(checkEvidence(members, ev("a.ts", 1, "x", "web")).ok).toBe(false);
    expect(checkEvidence(members, undefined)).toEqual({ ok: false, reason: "o agente não informou membro, arquivo, linha e nome do teste" });
  });
});
