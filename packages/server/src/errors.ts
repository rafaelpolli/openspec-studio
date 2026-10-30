import type { ApiError, ApiErrorCode, GitFailure } from "@studio/shared";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ProviderInputError } from "./engine/providers.ts";
import { RunConflictError } from "./engine/runner.ts";
import { EnvironmentInputError } from "./apply/environment.ts";
import { ApplyStateError } from "./apply/service.ts";
import { GitActionError, GitAreaNotFoundError, GitStateError } from "./git/exec.ts";
import { OnboardingStateError } from "./onboarding/service.ts";
import { ProposalStateError } from "./proposal/service.ts";
import { CliError, CliOutputError, CliTimeoutError, CliUnavailableError, CliVersionError } from "./openspec/cli.ts";
import { VerificationStateError } from "./verification/service.ts";
import { ExplorationStateError } from "./explore/service.ts";
import { AccessDeniedError } from "./workspaces/paths.ts";
import { WorkspaceInputError, WorkspaceNotFoundError, WorkspaceStateError } from "./workspaces/service.ts";

function classify(err: unknown): [ContentfulStatusCode, ApiErrorCode] {
  if (err instanceof WorkspaceInputError || err instanceof ProviderInputError || err instanceof EnvironmentInputError) {
    return [400, "invalid_input"];
  }
  if (err instanceof WorkspaceNotFoundError || err instanceof GitAreaNotFoundError) return [404, "not_found"];
  if (
    err instanceof RunConflictError ||
    err instanceof ProposalStateError ||
    err instanceof WorkspaceStateError ||
    err instanceof OnboardingStateError ||
    err instanceof ApplyStateError ||
    err instanceof GitStateError ||
    err instanceof VerificationStateError ||
    err instanceof ExplorationStateError
  ) {
    return [409, "conflict"];
  }
  if (err instanceof AccessDeniedError) return [403, "forbidden"];
  if (err instanceof CliUnavailableError || err instanceof CliVersionError) return [503, "cli_unavailable"];
  if (err instanceof CliError || err instanceof CliOutputError || err instanceof CliTimeoutError) {
    return [502, "cli_error"];
  }
  return [500, "internal"];
}

export function errorResponse(err: unknown, c: Context) {
  // A Git failure carries what the UI needs to offer the way out (add-git-commits D5).
  if (err instanceof GitActionError) {
    const body: GitFailure = { error: { code: "git_failed", message: err.message, kind: err.kind, output: err.output } };
    return c.json(body, 422);
  }
  const [status, code] = classify(err);
  const message = err instanceof Error ? err.message : String(err);
  if (status === 500) console.error(err);
  const body: ApiError = { error: { code, message } };
  return c.json(body, status);
}

export function invalidInput(c: Context, message: string) {
  const body: ApiError = { error: { code: "invalid_input", message } };
  return c.json(body, 400);
}
