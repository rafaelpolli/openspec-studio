import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Test runners the verification knows how to filter to one test (D4). */
export type RunnerKind = "bun" | "vitest" | "jest" | "pytest";

export interface TestCommand {
  kind?: RunnerKind;
  /** The argv that runs only the named test, run in the member without a shell. */
  argv?: string[];
  /** Why there is no argv. */
  reason?: string;
}

interface PackageJson {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

function packageJson(dir: string): PackageJson | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageJson;
  } catch {
    return undefined;
  }
}

const has = (dir: string, ...files: string[]) => files.some((f) => existsSync(join(dir, f)));

/** The command that runs a package's binary, by the lockfile the member has (as in apply/commands.ts). */
function exec(dir: string): string[] {
  if (has(dir, "bun.lock", "bun.lockb")) return ["bunx"];
  if (has(dir, "pnpm-lock.yaml")) return ["pnpm", "exec"];
  if (has(dir, "yarn.lock")) return ["yarn"];
  return ["npx"];
}

/** The runner of a member for a test file, or undefined when the app does not know it. */
export function detectRunner(member: string, file: string): RunnerKind | undefined {
  if (file.endsWith(".py")) {
    return has(member, "pyproject.toml", "pytest.ini", "conftest.py", "setup.cfg", "tox.ini") ? "pytest" : undefined;
  }
  const pkg = packageJson(member);
  if (!pkg) return undefined;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if ("vitest" in deps) return "vitest";
  if ("jest" in deps) return "jest";
  const test = pkg.scripts?.["test"];
  if (typeof test === "string" && /^\s*bun test\b/.test(test)) return "bun";
  if (has(member, "bun.lock", "bun.lockb")) return "bun";
  return undefined;
}

/** `text` as a regular expression that matches it literally. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * The argv that runs only the test `name` of `file` (relative to the member). The name is
 * matched unanchored, since runners match it against the full name with the `describe`s.
 */
export function testCommand(member: string, file: string, name: string): TestCommand {
  const kind = detectRunner(member, file);
  const pattern = escapeRegex(name);
  switch (kind) {
    case "bun":
      return { kind, argv: ["bun", "test", `./${file}`, "-t", pattern] };
    case "vitest":
      return { kind, argv: [...exec(member), "vitest", "run", file, "-t", pattern] };
    case "jest":
      return { kind, argv: [...exec(member), "jest", file, "-t", pattern] };
    case "pytest":
      return { kind, argv: ["python3", "-m", "pytest", `${file}::${name}`] };
    default: {
      const script = packageJson(member)?.scripts?.["test"];
      const hint = typeof script === "string" ? ` (o script de teste do membro é \`${script}\`)` : "";
      return { reason: `runner desconhecido${hint}: confira este cenário manualmente` };
    }
  }
}
