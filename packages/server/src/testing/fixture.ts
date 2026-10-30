import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenSpecCli } from "../openspec/cli.ts";

/** A temp directory with an isolated XDG data dir, so store registrations stay local. */
export function sandbox(prefix = "studio-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const cli = new OpenSpecCli({ env: { XDG_DATA_HOME: join(dir, ".xdg") } });
  return { dir, cli };
}

function write(path: string, content: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

const PROPOSAL = (why: string, cap: string) =>
  `# Proposal\n\n## Why\n\n${why}\n\n## What Changes\n\n- Change.\n\n## Capabilities\n\n### New Capabilities\n- \`${cap}\`: ${cap}\n\n## Impact\n\nNone.\n`;

/**
 * Builds an OpenSpec root with one archived spec (`auth`) and one active change
 * (`add-export`) whose spec has a requirement without a scenario (invalid) and
 * whose tasks.md has 1 of 2 tasks done.
 */
export async function buildFixtureRoot(root: string, cli: OpenSpecCli): Promise<void> {
  mkdirSync(root, { recursive: true });
  const init = await cli.run(["init", "--tools", "none", "--no-animation"], { cwd: root });
  if (init.exitCode !== 0) throw new Error(`fixture init failed: ${init.stderr}`);

  await cli.run(["new", "change", "baseline-auth"], { cwd: root });
  const base = join(root, "openspec/changes/baseline-auth");
  write(join(base, "proposal.md"), PROPOSAL("Document how authentication behaves today so changes can modify it.", "auth"));
  write(
    join(base, "specs/auth/spec.md"),
    "# Spec Delta\n\n## Purpose\n\nDescribes how users authenticate in the existing system today.\n\n## ADDED Requirements\n\n### Requirement: Login\nThe system SHALL reject expired tokens.\n\n#### Scenario: Expired token\n- **WHEN** a request carries an expired token\n- **THEN** the system responds 401\n",
  );
  const archived = await cli.run(["archive", "baseline-auth", "-y"], { cwd: root });
  if (archived.exitCode !== 0) throw new Error(`fixture archive failed: ${archived.stderr}`);

  await cli.run(["new", "change", "add-export"], { cwd: root });
  const change = join(root, "openspec/changes/add-export");
  write(join(change, "proposal.md"), PROPOSAL("Users need to export their data to move it into other tools easily.", "export"));
  write(
    join(change, "specs/export/spec.md"),
    "# Spec Delta\n\n## Purpose\n\nLets users take their data out of the product in a portable format.\n\n## ADDED Requirements\n\n### Requirement: Export CSV\nThe system SHALL export CSV.\n",
  );
  write(join(change, "tasks.md"), "# Tasks\n\n## 1. Core\n\n- [x] 1.1 Do a\n- [ ] 1.2 Do b\n");
}
