import type {
  ChangeDraft,
  DecisionAnswer,
  Exploration,
  ExplorationSummary,
  ApplyState,
  ArchiveOutcome,
  ArtifactFile,
  BaselineReview,
  CapabilityDraft,
  Estimate,
  OnboardingJob,
  EngineStatus,
  EnvironmentConfig,
  EnvironmentSettings,
  EnvironmentStatus,
  GitState,
  InitPreview,
  MemberWarning,
  ProposalView,
  RunView,
  ChangeStatus,
  ChangeSummary,
  SpecDetail,
  SpecOverview,
  SystemStatus,
  TaskChecklist,
  ValidationReport,
  VerificationState,
  WorkspaceView,
} from "@studio/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api.ts";

// Every workspace-scoped key starts with ["workspace", id], so one SSE event refreshes them all.
const ws = (id: string, ...rest: string[]) => ["workspace", id, ...rest];

export const useSystem = () => useQuery({ queryKey: ["system"], queryFn: () => api<SystemStatus>("/system") });

export const useEngine = () => useQuery({ queryKey: ["engine"], queryFn: () => api<EngineStatus>("/engine") });

export const useEngineRetry = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<EngineStatus>("/engine/restart", { method: "POST" }),
    onSuccess: (status) => client.setQueryData(["engine"], status),
  });
};

export const useWorkspaces = () =>
  useQuery({ queryKey: ["workspaces"], queryFn: () => api<WorkspaceView[]>("/workspaces") });

export const useWorkspace = (id: string) =>
  useQuery({ queryKey: ws(id), queryFn: () => api<WorkspaceView>(`/workspaces/${id}`) });

export const useSpecs = (id: string, enabled = true) =>
  useQuery({ queryKey: ws(id, "specs"), queryFn: () => api<SpecOverview[]>(`/workspaces/${id}/specs`), enabled });

export const useSpec = (id: string, spec: string) =>
  useQuery({ queryKey: ws(id, "spec", spec), queryFn: () => api<SpecDetail>(`/workspaces/${id}/specs/${spec}`) });

export const useChanges = (id: string, enabled = true) =>
  useQuery({
    queryKey: ws(id, "changes"),
    queryFn: () => api<ChangeSummary[]>(`/workspaces/${id}/changes`),
    enabled,
  });

export const useChangeStatus = (id: string, change: string) =>
  useQuery({
    queryKey: ws(id, "change", change, "status"),
    queryFn: () => api<ChangeStatus>(`/workspaces/${id}/changes/${change}/status`),
  });

export const useTasks = (id: string, change: string) =>
  useQuery({
    queryKey: ws(id, "change", change, "tasks"),
    queryFn: () => api<TaskChecklist>(`/workspaces/${id}/changes/${change}/tasks`),
  });

export const useArtifact = (id: string, change: string, artifact: string | undefined) =>
  useQuery({
    queryKey: ws(id, "change", change, "artifact", artifact ?? ""),
    queryFn: () => api<ArtifactFile[]>(`/workspaces/${id}/changes/${change}/artifacts/${artifact}`),
    enabled: artifact !== undefined,
  });

export const useValidate = (id: string) =>
  useMutation({
    mutationFn: (item?: string) =>
      api<ValidationReport>(`/workspaces/${id}/validate`, { method: "POST", body: item ? { item } : {} }),
  });

export const runKey = (id: string, change: string) => ws(id, "change", change, "run");

export const useRun = (id: string, change: string, enabled = true) =>
  useQuery({
    queryKey: runKey(id, change),
    queryFn: () => api<RunView | null>(`/workspaces/${id}/changes/${change}/run`),
    enabled,
  });

export const useCancelRun = (id: string, change: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<RunView | null>(`/workspaces/${id}/changes/${change}/run/cancel`, { method: "POST" }),
    onSuccess: (run) => client.setQueryData(runKey(id, change), run),
  });
};

export const useProposal = (id: string, change: string) =>
  useQuery({
    queryKey: ws(id, "change", change, "proposal"),
    queryFn: () => api<ProposalView>(`/workspaces/${id}/changes/${change}/proposal`),
  });

/** Mutations of the guided proposal; each refreshes the change's queries. */
export function useProposalActions(id: string, change: string) {
  const client = useQueryClient();
  const base = `/workspaces/${id}/changes/${change}`;
  const refresh = () => client.invalidateQueries({ queryKey: ws(id, "change", change) });
  const make = <T,>(fn: (arg: T) => Promise<unknown>) => useMutation({ mutationFn: fn, onSettled: refresh });
  return {
    generate: make((artifact: string) => api(`${base}/artifacts/${artifact}/generate`, { method: "POST" })),
    approve: make((artifact: string) => api(`${base}/artifacts/${artifact}/approve`, { method: "POST" })),
    fix: make((artifact: string) => api(`${base}/artifacts/${artifact}/fix`, { method: "POST" })),
    save: make((a: { artifact: string; path: string; content: string }) =>
      api(`${base}/artifacts/${a.artifact}/content`, { method: "PUT", body: { path: a.path, content: a.content } }),
    ),
    adjust: make((a: { artifact: string; request: string }) =>
      api(`${base}/artifacts/${a.artifact}/adjust`, { method: "POST", body: { request: a.request } }),
    ),
    generateRest: make(() => api(`${base}/generate-rest`, { method: "POST" })),
    answerDecisions: make((answers: DecisionAnswer[]) => api(`${base}/decisions/answers`, { method: "POST", body: { answers } })),
    skipDecisions: make(() => api(`${base}/decisions/skip`, { method: "POST" })),
    retryDecisions: make(() => api(`${base}/decisions/retry`, { method: "POST" })),
  };
}

// --- onboarding ---------------------------------------------------------------

export const onboardingKey = (id: string) => ws(id, "onboarding");

export const useOnboarding = (id: string) =>
  useQuery({ queryKey: onboardingKey(id), queryFn: () => api<OnboardingJob | null>(`/workspaces/${id}/onboarding`) });

export const useBaselineReview = (id: string, jobId: string | undefined, cap: string | undefined, enabled: boolean) =>
  useQuery({
    queryKey: [...onboardingKey(id), "review", cap ?? ""],
    queryFn: () => api<BaselineReview>(`/onboarding/${jobId}/capabilities/${cap}/review`),
    enabled: enabled && !!jobId && !!cap,
  });

/** Onboarding mutations; each refreshes the workspace's onboarding queries. */
export function useOnboardingActions(id: string, jobId: string | undefined) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ws(id) });
  const make = <A, R>(fn: (arg: A) => Promise<R>) => useMutation({ mutationFn: fn, onSettled: refresh });
  const job = `/onboarding/${jobId}`;
  const cap = (name: string, action: string, body?: unknown) =>
    api<OnboardingJob>(`${job}/capabilities/${name}/${action}`, { method: "POST", ...(body ? { body } : {}) });
  return {
    init: make((language: string) => api<WorkspaceView>(`/workspaces/${id}/init`, { method: "POST", body: { language } })),
    discover: make(() => api<OnboardingJob>(`/workspaces/${id}/onboarding`, { method: "POST" })),
    checkpoint: make(async (capabilities: CapabilityDraft[]) => {
      await api<OnboardingJob>(`${job}/capabilities`, { method: "PUT", body: { capabilities } });
      return api<Estimate>(`${job}/estimate`);
    }),
    start: make(() => api<OnboardingJob>(`${job}/start`, { method: "POST", body: { confirmed: true } })),
    retry: make((name: string) => cap(name, "retry")),
    cancel: make((name: string) => cap(name, "cancel")),
    approve: make((name: string) => cap(name, "approve")),
    discard: make((name: string) => cap(name, "discard")),
    adjust: make((a: { name: string; request: string }) => cap(a.name, "adjust", { request: a.request })),
    archive: make(() => api<ArchiveOutcome[]>(`${job}/archive`, { method: "POST" })),
  };
}

// --- apply (add-visual-apply) ---------------------------------------------------

// Under the change's key, so whatever refreshes the change (a finished planning run, an
// external edit of tasks.md) refreshes the apply state too.
export const applyKey = (id: string, change: string) => ws(id, "change", change, "apply");

export const useApply = (id: string, change: string) =>
  useQuery({
    queryKey: applyKey(id, change),
    queryFn: () => api<ApplyState>(`/workspaces/${id}/changes/${change}/apply`),
  });

/** Apply mutations; each replaces the cached state with the one the backend returns. */
export function useApplyActions(id: string, change: string) {
  const client = useQueryClient();
  const base = `/workspaces/${id}/changes/${change}/apply`;
  const make = <A,>(fn: (arg: A) => Promise<ApplyState>) =>
    useMutation({
      mutationFn: fn,
      onSuccess: (state) => client.setQueryData(applyKey(id, change), state),
      onSettled: () => {
        void client.invalidateQueries({ queryKey: ws(id, "change", change) });
        void client.invalidateQueries({ queryKey: gitKey(id) });
      },
    });
  const post = (path: string, body?: unknown) => api<ApplyState>(`${base}${path}`, { method: "POST", ...(body ? { body } : {}) });
  return {
    check: useMutation({ mutationFn: () => api<{ warnings: MemberWarning[] }>(`/workspaces/${id}/apply/check`) }),
    run: make((a: { mode: "proxima" | "todas"; confirmed: boolean }) => post("/run", a)),
    stop: make(() => post("/stop")),
    accept: make((task: string) => post(`/tasks/${task}/accept`)),
    commit: make((a: { task: string; message: string; noVerify: boolean }) =>
      post(`/tasks/${a.task}/accept`, { commit: { message: a.message, noVerify: a.noVerify } }),
    ),
    undo: make((task: string) => post(`/tasks/${task}/undo`)),
    adjust: make((a: { task: string; request: string }) => post(`/tasks/${a.task}/adjust`, { request: a.request })),
    reply: make((a: { requestId: string; reply: "once" | "always" | "reject" }) => post("/permission", a)),
  };
}

export const useApplyCommands = (id: string) =>
  useQuery({
    queryKey: ws(id, "apply-commands"),
    queryFn: () => api<{ commands: string[] }>(`/workspaces/${id}/apply/commands`),
  });

export const useSaveApplyCommands = (id: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (commands: string[]) =>
      api<{ commands: string[] }>(`/workspaces/${id}/apply/commands`, { method: "PUT", body: { commands } }),
    onSuccess: (data) => client.setQueryData(ws(id, "apply-commands"), data),
  });
};

// --- apply environment (add-apply-devcontainer) --------------------------------

export const environmentKey = (id: string) => ws(id, "environment");

export const useEnvironmentSettings = (id: string) =>
  useQuery({
    queryKey: [...environmentKey(id), "settings"],
    queryFn: () => api<EnvironmentSettings>(`/workspaces/${id}/apply/environment`),
  });

export const useEnvironmentStatus = (id: string) =>
  useQuery({
    queryKey: [...environmentKey(id), "status"],
    queryFn: () => api<EnvironmentStatus>(`/workspaces/${id}/apply/environment/status`),
  });

/** Saving the choice, stopping and rebuilding; each refreshes the environment queries. */
export function useEnvironmentActions(id: string) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: environmentKey(id) });
  const base = `/workspaces/${id}/apply/environment`;
  return {
    save: useMutation({
      mutationFn: (config: EnvironmentConfig) => api<EnvironmentSettings>(base, { method: "PUT", body: config }),
      onSettled: refresh,
    }),
    stop: useMutation({ mutationFn: () => api<EnvironmentStatus>(`${base}/stop`, { method: "POST" }), onSettled: refresh }),
    rebuild: useMutation({ mutationFn: () => api<EnvironmentStatus>(`${base}/rebuild`, { method: "POST" }), onSettled: refresh }),
  };
}

// --- git (add-git-commits) -----------------------------------------------------

export const gitKey = (id: string) => ws(id, "git");

export const useGit = (id: string) =>
  useQuery({
    queryKey: gitKey(id),
    queryFn: () => api<GitState>(`/workspaces/${id}/git`),
  });

/** Git actions; each replaces the cached Git state and refreshes the apply checks. */
export function useGitActions(id: string) {
  const client = useQueryClient();
  const base = `/workspaces/${id}/git`;
  const make = <A,>(fn: (arg: A) => Promise<GitState>) =>
    useMutation({
      mutationFn: fn,
      onSuccess: (state) => {
        client.setQueryData(gitKey(id), state);
        void client.invalidateQueries({ queryKey: ["workspace", id] });
      },
    });
  return {
    setIdentity: make((a: { area: string; name: string; email: string }) => api<GitState>(`${base}/identity`, { method: "PUT", body: a })),
    clearIdentity: make((area: string) => api<GitState>(`${base}/identity`, { method: "DELETE", body: { area } })),
    init: make((a: { area: string; gitignore: string; message: string; noVerify: boolean; identity?: { name: string; email: string } }) =>
      api<GitState>(`${base}/init`, { method: "POST", body: a }),
    ),
    commitPending: make((a: { area: string; message: string; noVerify: boolean }) =>
      api<GitState>(`${base}/commit-pending`, { method: "POST", body: a }),
    ),
    preview: (area: string, gitignore?: string) =>
      api<InitPreview>(`${base}/init/preview`, { method: "POST", body: { area, ...(gitignore === undefined ? {} : { gitignore }) } }),
  };
}

// --- verification (add-change-verification) ---------------------------------

export const verificationKey = (id: string, change: string) => ws(id, "change", change, "verification");

export const useVerification = (id: string, change: string) =>
  useQuery({
    queryKey: verificationKey(id, change),
    queryFn: () => api<VerificationState>(`/workspaces/${id}/changes/${change}/verification`),
  });

export interface ChangeArchive {
  archivedAs: string;
  specsUpdated: boolean;
  commit?: string;
}

/** Verification and archive actions; item ids travel URL-encoded in one path segment. */
export function useVerificationActions(id: string, change: string) {
  const client = useQueryClient();
  const base = `/workspaces/${id}/changes/${change}/verification`;
  const item = (itemId: string) => `${base}/items/${encodeURIComponent(itemId)}`;
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ws(id, "change", change) });
    void client.invalidateQueries({ queryKey: gitKey(id) });
  };
  const make = <A,>(fn: (arg: A) => Promise<VerificationState>) =>
    useMutation({
      mutationFn: fn,
      onSuccess: (state) => client.setQueryData(verificationKey(id, change), state),
      onSettled: refresh,
    });
  return {
    run: make(() => api<VerificationState>(base, { method: "POST" })),
    stop: make(() => api<VerificationState>(base, { method: "DELETE" })),
    check: make((a: { item: string; note?: string }) =>
      api<VerificationState>(`${item(a.item)}/check`, { method: "POST", body: a.note ? { note: a.note } : {} }),
    ),
    uncheck: make((itemId: string) => api<VerificationState>(`${item(itemId)}/check`, { method: "DELETE" })),
    justify: make((a: { item: string; text: string }) =>
      api<VerificationState>(`${item(a.item)}/justification`, { method: "PUT", body: { text: a.text } }),
    ),
    testTask: make((itemId: string) =>
      api<{ state: VerificationState; taskId: string }>(`${item(itemId)}/test-task`, { method: "POST" }).then((r) => r.state),
    ),
    proof: make((itemId: string) => api<VerificationState>(`${item(itemId)}/proof`, { method: "POST" })),
    archive: useMutation({
      mutationFn: (a: { commit?: { message: string; noVerify: boolean } }) =>
        api<ChangeArchive>(`/workspaces/${id}/changes/${change}/archive`, { method: "POST", body: a }),
      onSettled: () => {
        void client.invalidateQueries({ queryKey: ["workspace", id] });
      },
    }),
    archiveCommit: useMutation({
      mutationFn: (a: { message: string; noVerify: boolean }) =>
        api<{ commit: string }>(`/workspaces/${id}/changes/${change}/archive/commit`, { method: "POST", body: a }),
      onSettled: () => {
        void client.invalidateQueries({ queryKey: ["workspace", id] });
      },
    }),
  };
}

// --- explorations (add-workspace-explore) -----------------------------------------

export const explorationsKey = (id: string) => ws(id, "explorations");

export const useExplorations = (id: string) =>
  useQuery({ queryKey: explorationsKey(id), queryFn: () => api<ExplorationSummary[]>(`/workspaces/${id}/explorations`) });

export const useExploration = (id: string, x: string) =>
  useQuery({ queryKey: [...explorationsKey(id), x], queryFn: () => api<Exploration>(`/workspaces/${id}/explorations/${x}`) });

/** Exploration actions; each replaces the cached exploration with the one the backend returns. */
export function useExplorationActions(id: string, x: string) {
  const client = useQueryClient();
  const base = `/workspaces/${id}/explorations/${x}`;
  const make = <A,>(fn: (arg: A) => Promise<Exploration>) =>
    useMutation({
      mutationFn: fn,
      onSuccess: (e) => client.setQueryData([...explorationsKey(id), x], e),
      onSettled: () => client.invalidateQueries({ queryKey: explorationsKey(id) }),
    });
  const post = (path: string, body?: unknown) => api<Exploration>(`${base}${path}`, { method: "POST", ...(body ? { body } : {}) });
  return {
    send: make((text: string) => post("/messages", { text })),
    stop: make(() => post("/stop")),
    rename: make((title: string) => api<Exploration>(base, { method: "PATCH", body: { title } })),
    draft: make(() => post("/draft")),
    toChange: make((draft: ChangeDraft) => post("/change", draft)),
    discard: make(() => post("/discard")),
  };
}

export function useCreateExploration(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (from?: string) => api<Exploration>(`/workspaces/${id}/explorations`, { method: "POST", body: from ? { from } : {} }),
    onSettled: () => client.invalidateQueries({ queryKey: explorationsKey(id) }),
  });
}
