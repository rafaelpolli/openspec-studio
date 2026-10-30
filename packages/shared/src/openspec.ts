import { z } from "zod";

// Shapes of `openspec ... --json` output (OpenSpec 1.15). Unknown keys are stripped.

export const CliStatusEntry = z.object({
  severity: z.string(),
  code: z.string(),
  message: z.string(),
  fix: z.string().optional(),
});
export type CliStatusEntry = z.infer<typeof CliStatusEntry>;

export const ChangeSummary = z.object({
  name: z.string(),
  completedTasks: z.number(),
  totalTasks: z.number(),
  lastModified: z.string(),
  status: z.string(),
});
export type ChangeSummary = z.infer<typeof ChangeSummary>;

export const ChangeList = z.object({ changes: z.array(ChangeSummary) });

export const SpecSummary = z.object({ id: z.string(), requirementCount: z.number() });
export type SpecSummary = z.infer<typeof SpecSummary>;

export const SpecList = z.object({ specs: z.array(SpecSummary) });

export const Scenario = z.object({ name: z.string(), rawText: z.string() });

export const Requirement = z.object({
  name: z.string(),
  text: z.string(),
  scenarios: z.array(Scenario),
});
export type Requirement = z.infer<typeof Requirement>;

export const SpecDetail = z.object({
  id: z.string(),
  title: z.string(),
  overview: z.string(),
  requirementCount: z.number(),
  requirements: z.array(Requirement),
});
export type SpecDetail = z.infer<typeof SpecDetail>;

export const ChangeDelta = z.object({
  spec: z.string(),
  operation: z.string(),
  description: z.string(),
  requirements: z.array(Requirement).optional(),
});

export const ChangeDetail = z.object({
  id: z.string(),
  title: z.string(),
  deltaCount: z.number(),
  deltas: z.array(ChangeDelta),
});
export type ChangeDetail = z.infer<typeof ChangeDetail>;

export const ArtifactState = z.enum(["done", "ready", "blocked", "skipped"]);
export type ArtifactState = z.infer<typeof ArtifactState>;

export const ArtifactStatus = z.object({
  id: z.string(),
  outputPath: z.string(),
  status: ArtifactState,
  requires: z.array(z.string()),
  missingDeps: z.array(z.string()).optional(),
});
export type ArtifactStatus = z.infer<typeof ArtifactStatus>;

export const ChangeStatus = z.object({
  changeName: z.string(),
  schemaName: z.string(),
  changeRoot: z.string(),
  isPlanningComplete: z.boolean(),
  applyRequires: z.array(z.string()),
  artifacts: z.array(ArtifactStatus),
  artifactPaths: z.record(
    z.string(),
    z.object({
      outputPath: z.string(),
      resolvedOutputPath: z.string(),
      existingOutputPaths: z.array(z.string()),
    }),
  ),
});
export type ChangeStatus = z.infer<typeof ChangeStatus>;

export const ValidationIssue = z.object({
  level: z.string(),
  path: z.string().optional(),
  message: z.string(),
});
export type ValidationIssue = z.infer<typeof ValidationIssue>;

export const ValidationReport = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      valid: z.boolean(),
      issues: z.array(ValidationIssue),
    }),
  ),
  summary: z.object({
    totals: z.object({ items: z.number(), passed: z.number(), failed: z.number() }),
  }),
});
export type ValidationReport = z.infer<typeof ValidationReport>;

export const ContextReport = z.object({
  root: z.object({ path: z.string(), source: z.string(), store_id: z.string().optional() }).nullable(),
  members: z.array(z.unknown()),
});
export type ContextReport = z.infer<typeof ContextReport>;

export const VersionReport = z.object({ version: z.string() });

export const NewChangeResult = z.object({
  change: z.object({ id: z.string(), path: z.string(), schema: z.string() }),
});

export const ArchiveResult = z.object({
  archive: z.object({
    change: z.string(),
    archivedAs: z.string(),
    path: z.string(),
    specsUpdated: z.boolean(),
  }),
});
export type ArchiveResult = z.infer<typeof ArchiveResult>;

export const StoreSetupResult = z.object({
  store: z.object({ id: z.string(), root: z.string() }),
  registry: z.object({ path: z.string(), registered: z.boolean() }),
});
export type StoreSetupResult = z.infer<typeof StoreSetupResult>;

export const StoreList = z.object({
  stores: z.array(z.object({ id: z.string(), root: z.string() })),
});
export type StoreList = z.infer<typeof StoreList>;

// Parsed `tasks.md` checklist (read from the file, not the CLI; see design D3).

export interface TaskItem {
  /** Leading task number such as "1.2", when present. */
  id: string | null;
  text: string;
  done: boolean;
  /** 1-based line number in tasks.md. */
  line: number;
}

export interface TaskSection {
  /** Heading text, or null for tasks before the first `##` heading. */
  title: string | null;
  tasks: TaskItem[];
}

export interface TaskChecklist {
  sections: TaskSection[];
  total: number;
  complete: number;
}

export const ArtifactInstructions = z.object({
  changeName: z.string(),
  artifactId: z.string(),
  schemaName: z.string(),
  changeDir: z.string(),
  outputPath: z.string(),
  resolvedOutputPath: z.string(),
  existingOutputPaths: z.array(z.string()).optional(),
  description: z.string().optional(),
  instruction: z.string(),
  template: z.string().optional(),
  context: z.string().optional(),
  rules: z.array(z.string()).optional(),
  dependencies: z.array(z.object({ id: z.string(), done: z.boolean(), path: z.string() })),
  skipped: z.boolean().optional(),
  warning: z.string().optional(),
});
export type ArtifactInstructions = z.infer<typeof ArtifactInstructions>;
