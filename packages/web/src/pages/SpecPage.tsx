import { Link } from "wouter";
import { SpecView } from "../components/SpecView.tsx";
import { useSpec } from "../queries.ts";
import { QueryState } from "./QueryState.tsx";

export function SpecPage({ id, spec }: { id: string; spec: string }) {
  const query = useSpec(id, spec);
  return (
    <main>
      <Link href={`/w/${id}`} className="muted">
        ← workspace
      </Link>
      <QueryState query={query}>{(data) => <SpecView spec={data} />}</QueryState>
    </main>
  );
}
