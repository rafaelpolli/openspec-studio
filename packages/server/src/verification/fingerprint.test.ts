import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changed, fingerprint } from "./fingerprint.ts";
import { evidence, git, verificationSetup } from "./testing.ts";

setDefaultTimeout(60_000);

const t = await verificationSetup({
  scenarios: ["Passa", "Manual"],
  trace: () => ({ items: [evidence("calc/Somar/Passa", 5, "Passa: soma dois números"), { id: "calc/Somar/Manual", kind: "manual" }] }),
});
afterAll(() => {
  t.close();
  rmSync(t.dir, { recursive: true, force: true });
});

const fp = () => fingerprint(t.ws, t.changeDir);

describe("4.3 impressão digital e desatualização", () => {
  test("the root's openspec/ is left out of a member's tree, and the report file out of the artifacts", () => {
    const before = fp();
    writeFileSync(join(t.root, "openspec", "specs-rascunho.md"), "x\n");
    writeFileSync(join(t.changeDir, "verification.md"), "# qualquer coisa\n");
    expect(changed(before, fp())).toBe(false);
    rmSync(join(t.root, "openspec", "specs-rascunho.md"));
  });

  test("Código alterado depois: a member's file makes the report stale; restoring it makes it current again", async () => {
    await t.verify();
    expect(t.service.state(t.ws.id, "c").stale).toBe(false);
    const file = join(t.root, "src", "soma.ts");
    const original = readFileSync(file, "utf8");
    writeFileSync(file, `${original}// editado\n`);
    const stale = t.service.state(t.ws.id, "c");
    expect(stale.stale).toBe(true);
    expect(stale.archive).toMatchObject({ allowed: false, reason: "o código ou os artefatos mudaram depois da verificação: verifique de novo" });
    writeFileSync(file, original);
    expect(t.service.state(t.ws.id, "c").stale).toBe(false);
    // An untracked new file counts too.
    mkdirSync(join(t.root, "src", "novo"), { recursive: true });
    writeFileSync(join(t.root, "src", "novo", "a.ts"), "a\n");
    expect(t.service.state(t.ws.id, "c").stale).toBe(true);
    rmSync(join(t.root, "src", "novo"), { recursive: true });
    expect(git(t.root, "status", "--porcelain", "--", "src").trim()).toBe("");
  });

  test("editing tasks.md makes it stale", async () => {
    await t.verify();
    const file = join(t.changeDir, "tasks.md");
    const original = readFileSync(file, "utf8");
    writeFileSync(file, `${original}\n`);
    expect(t.service.state(t.ws.id, "c").stale).toBe(true);
    writeFileSync(file, original);
    expect(t.service.state(t.ws.id, "c").stale).toBe(false);
  });

  test("Justificativa não desatualiza: justifying and rewriting verification.md keep it current", async () => {
    await t.verify();
    t.service.justify(t.ws.id, "c", "calc/Somar/Manual", "conferido no release");
    expect(t.service.state(t.ws.id, "c").stale).toBe(false);
    expect(readFileSync(join(t.changeDir, "verification.md"), "utf8")).toContain("conferido no release");
  });
});
