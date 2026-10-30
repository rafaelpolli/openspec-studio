import { ApiError, TOKEN_HEADER, type GitFailureKind } from "@studio/shared";

/** Per-run token, injected into index.html by the backend (or the Vite dev server). */
export function readToken(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="studio-token"]')?.content ?? "";
}

/** What a failed Git action reports, so the UI can offer the way out (add-git-commits D5). */
export interface GitFailureDetail {
  kind: GitFailureKind;
  output: string;
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly git?: GitFailureDetail,
    /** The change was archived; only the archive's commit failed (add-change-verification D10). */
    readonly archived?: boolean,
  ) {
    super(message);
  }
}

function gitDetail(data: unknown): GitFailureDetail | undefined {
  const error = (data as { error?: { code?: string; kind?: GitFailureKind; output?: string } } | undefined)?.error;
  return error?.code === "git_failed" && error.kind ? { kind: error.kind, output: error.output ?? "" } : undefined;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    headers: { [TOKEN_HEADER]: readToken(), "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const parsed = ApiError.safeParse(data);
    throw parsed.success
      ? new ApiRequestError(
          parsed.data.error.message,
          res.status,
          parsed.data.error.code,
          gitDetail(data),
          (data as { archived?: boolean }).archived === true ? true : undefined,
        )
      : new ApiRequestError(`HTTP ${res.status}`, res.status, "internal");
  }
  return data as T;
}
