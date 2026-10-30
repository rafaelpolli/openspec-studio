import type { SpecDetail } from "@studio/shared";
import Markdown from "react-markdown";

export function SpecView({ spec }: { spec: SpecDetail }) {
  return (
    <article>
      <h2>{spec.id}</h2>
      <p className="lead">{spec.overview}</p>
      {spec.requirements.map((req) => (
        <section key={req.name} className="requirement">
          <h3>{req.name}</h3>
          <p>{req.text}</p>
          {req.scenarios.length === 0 ? (
            <p className="muted">Sem cenários.</p>
          ) : (
            req.scenarios.map((sc) => (
              <div key={sc.name} className="scenario">
                <h4>Cenário: {sc.name}</h4>
                <Markdown>{sc.rawText}</Markdown>
              </div>
            ))
          )}
        </section>
      ))}
    </article>
  );
}
