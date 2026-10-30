import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessDeniedError, resolveInside } from "./paths.ts";

const base = mkdtempSync(join(tmpdir(), "studio-paths-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const root = join(base, "root");
const member = join(base, "member");
const outside = join(base, "outside");
for (const d of [root, member, outside]) mkdirSync(d);
writeFileSync(join(outside, "secret.txt"), "secret");
writeFileSync(join(member, "a.ts"), "x");
symlinkSync(outside, join(root, "escape"));
symlinkSync(join(outside, "secret.txt"), join(root, "secret-link"));

const bases = [root, member];

describe("resolveInside", () => {
  test("allows relative paths inside the root and absolute paths inside a member", () => {
    expect(resolveInside(bases, "openspec/config.yaml")).toBe(join(root, "openspec/config.yaml"));
    expect(resolveInside(bases, join(member, "a.ts"))).toBe(join(member, "a.ts"));
  });

  test("rejects ../ traversal", () => {
    expect(() => resolveInside(bases, "../outside/secret.txt")).toThrow(AccessDeniedError);
    expect(() => resolveInside(bases, "openspec/../../outside/secret.txt")).toThrow(AccessDeniedError);
  });

  test("rejects absolute paths outside", () => {
    expect(() => resolveInside(bases, join(outside, "secret.txt"))).toThrow(AccessDeniedError);
    expect(() => resolveInside(bases, "/etc/passwd")).toThrow(AccessDeniedError);
  });

  test("rejects symlinks that point outside, including not-yet-existing files under them", () => {
    expect(() => resolveInside(bases, "secret-link")).toThrow(AccessDeniedError);
    expect(() => resolveInside(bases, "escape/secret.txt")).toThrow(AccessDeniedError);
    expect(() => resolveInside(bases, "escape/new-file.txt")).toThrow(AccessDeniedError);
  });

  test("a sibling folder sharing the prefix is not inside", () => {
    mkdirSync(join(base, "root-evil"));
    expect(() => resolveInside(bases, join(base, "root-evil"))).toThrow(AccessDeniedError);
  });
});
