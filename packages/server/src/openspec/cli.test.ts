import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  CliError,
  CliOutputError,
  CliTimeoutError,
  CliUnavailableError,
  CliVersionError,
  compareVersions,
  OpenSpecCli,
} from "./cli.ts";

const dir = mkdtempSync(join(tmpdir(), "studio-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Writes an executable fake `openspec` that runs the given shell body. */
function fakeCli(name: string, body: string): OpenSpecCli {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return new OpenSpecCli({ bin: path, timeoutMs: 2_000 });
}

const Any = z.unknown();

describe("OpenSpecCli.run / json", () => {
  test("a missing executable raises CliUnavailableError", async () => {
    const cli = new OpenSpecCli({ bin: join(dir, "does-not-exist") });
    await expect(cli.json(["list"], Any, { cwd: dir })).rejects.toBeInstanceOf(CliUnavailableError);
  });

  test("non-JSON output raises CliOutputError", async () => {
    const cli = fakeCli("garbage", "echo 'not json'");
    await expect(cli.json(["list"], Any, { cwd: dir })).rejects.toBeInstanceOf(CliOutputError);
  });

  test("JSON that does not match the schema raises CliOutputError", async () => {
    const cli = fakeCli("shape", `echo '{"changes": "nope"}'`);
    const schema = z.object({ changes: z.array(z.string()) });
    await expect(cli.json(["list"], schema, { cwd: dir })).rejects.toBeInstanceOf(CliOutputError);
  });

  test("an error status entry raises CliError with code and fix", async () => {
    const cli = fakeCli(
      "status-error",
      `echo '{"status":[{"severity":"error","code":"no_openspec_root","message":"No root","fix":"Run init"}]}'; exit 1`,
    );
    const err = await cli.json(["list"], Any, { cwd: dir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err).toMatchObject({ code: "no_openspec_root", message: "No root", fix: "Run init" });
  });

  test("a non-zero exit without JSON surfaces stderr", async () => {
    const cli = fakeCli("crash", "echo boom >&2; exit 3");
    const err = await cli.json(["list"], Any, { cwd: dir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toBe("boom");
    expect((err as CliError).stderr).toContain("boom");
  });

  test("allowNonZero accepts valid JSON with a failing exit code", async () => {
    const cli = fakeCli("validate", `echo '{"ok": false}'; exit 1`);
    const out = await cli.json(["validate"], z.object({ ok: z.boolean() }), { cwd: dir, allowNonZero: true });
    expect(out).toEqual({ ok: false });
  });

  test("appends --store and --json and runs in cwd", async () => {
    const cli = fakeCli("echo-args", `printf '{"args":"%s","cwd":"%s"}' "$*" "$(pwd)"`);
    const out = await cli.json(["list"], z.object({ args: z.string(), cwd: z.string() }), {
      cwd: dir,
      store: "team",
    });
    expect(out.args).toBe("list --json --store team");
    expect(out.cwd).toBe(dir);
  });

  test("a hung CLI raises CliTimeoutError", async () => {
    const cli = new OpenSpecCli({ bin: fakeCli("hang", "sleep 5").bin, timeoutMs: 200 });
    await expect(cli.run(["list"], { cwd: dir })).rejects.toBeInstanceOf(CliTimeoutError);
  });
});

describe("version check", () => {
  test("compareVersions orders dotted versions", () => {
    expect(compareVersions("1.15.0", "1.15.0")).toBe(0);
    expect(compareVersions("1.15.1", "1.15.0")).toBe(1);
    expect(compareVersions("1.9.0", "1.15.0")).toBe(-1);
    expect(compareVersions("2.0", "1.99.99")).toBe(1);
  });

  test("an old CLI is rejected", async () => {
    const cli = fakeCli("old", `echo '{"version":"1.2.0"}'`);
    await expect(cli.assertVersion("1.15.0")).rejects.toBeInstanceOf(CliVersionError);
  });

  test("the installed CLI meets the minimum version", async () => {
    expect(await new OpenSpecCli().assertVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
