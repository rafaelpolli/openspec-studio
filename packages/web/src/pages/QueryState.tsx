import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";

/** Renders loading and error states, and the children once data is available. */
export function QueryState<T>({ query, children }: { query: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  if (query.isPending) return <p className="muted">Carregando…</p>;
  if (query.isError) {
    return (
      <p className="banner banner-error" role="alert">
        {query.error.message}
      </p>
    );
  }
  return <>{children(query.data)}</>;
}
