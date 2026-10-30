import { z } from "zod";

/** BCP 47-like tag, e.g. `pt-BR`, `en`, `es`. */
export const InitInput = z.object({ language: z.string().regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/) });
export type InitInput = z.infer<typeof InitInput>;

export const CAPABILITY_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Where a capability is implemented: a file or folder relative to a member. */
export const CapabilityLocation = z.object({
  member: z.string().min(1),
  path: z.string().min(1),
});
export type CapabilityLocation = z.infer<typeof CapabilityLocation>;

/** A capability as discovered or as edited at the checkpoint. */
export const CapabilityDraft = z.object({
  name: z.string().regex(CAPABILITY_NAME),
  description: z.string().min(1),
  locations: z.array(CapabilityLocation),
});
export type CapabilityDraft = z.infer<typeof CapabilityDraft>;

/** The JSON file the discovery session writes. */
export const DiscoveryFile = z.object({ capabilities: z.array(CapabilityDraft).min(1) });
export type DiscoveryFile = z.infer<typeof DiscoveryFile>;

/** The checkpoint saves the whole edited list (rename, merge, remove, add). */
export const CheckpointInput = z.object({ capabilities: z.array(CapabilityDraft).min(1) });
export type CheckpointInput = z.infer<typeof CheckpointInput>;

/**
 * Per-capability state. The batch shows aguardando → gerando → validando → pronta | falhou
 * (spec: project-onboarding, "Progresso da geração em lote"); review and archive follow.
 */
export const CapabilityStatus = z.enum([
  "aguardando",
  "gerando",
  "validando",
  "pronta",
  "falhou",
  "cancelada",
  "aprovada",
  "descartada",
  "arquivada",
]);
export type CapabilityStatus = z.infer<typeof CapabilityStatus>;

export const Capability = CapabilityDraft.extend({
  status: CapabilityStatus,
  error: z.string().nullable(),
  /** `baseline-<name>`, once generation started. */
  changeName: z.string().nullable(),
});
export type Capability = z.infer<typeof Capability>;

export const OnboardingStatus = z.enum(["descobrindo", "descoberta_falhou", "checkpoint", "gerando", "revisao"]);
export type OnboardingStatus = z.infer<typeof OnboardingStatus>;

export const OnboardingJob = z.object({
  id: z.string(),
  workspaceId: z.string(),
  status: OnboardingStatus,
  error: z.string().nullable(),
  /** Pseudo change name whose run streams the discovery session. */
  discoveryRun: z.string(),
  capabilities: z.array(Capability),
  createdAt: z.string(),
});
export type OnboardingJob = z.infer<typeof OnboardingJob>;

export const Estimate = z.object({
  capabilities: z.number(),
  files: z.number(),
  bytes: z.number(),
  /** Rough token range for reading the code and writing the baselines. */
  tokens: z.object({ min: z.number(), max: z.number() }),
  concurrency: z.number(),
});
export type Estimate = z.infer<typeof Estimate>;

export const StartInput = z.object({ confirmed: z.literal(true) });

export const EvidenceSource = z.enum(["testado", "inferido"]);
export type EvidenceSource = z.infer<typeof EvidenceSource>;

/** A baseline requirement with the evidence read from the design.md table. */
export const BaselineRequirement = z.object({
  name: z.string(),
  text: z.string(),
  evidence: z.array(z.string()),
  /** No matching test: shown with the "inferido" badge. */
  inferred: z.boolean(),
});
export type BaselineRequirement = z.infer<typeof BaselineRequirement>;

export const BaselineReview = z.object({
  capability: z.string(),
  change: z.string(),
  requirements: z.array(BaselineRequirement),
  files: z.array(z.object({ path: z.string(), content: z.string() })),
});
export type BaselineReview = z.infer<typeof BaselineReview>;

export const ArchiveOutcome = z.object({
  capability: z.string(),
  change: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
});
export type ArchiveOutcome = z.infer<typeof ArchiveOutcome>;

export const AdjustInput = z.object({ request: z.string().min(1) });
