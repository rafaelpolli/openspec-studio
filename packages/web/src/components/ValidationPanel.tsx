import type { ValidationReport } from "@studio/shared";

export function ValidationPanel({ report }: { report: ValidationReport }) {
  const { passed, failed } = report.summary.totals;
  return (
    <div className="validation">
      <p className={failed > 0 ? "status-error" : "status-ok"}>
        {failed > 0 ? `${failed} com problemas, ${passed} válidos` : `Tudo válido (${passed})`}
      </p>
      <ul>
        {report.items
          .filter((item) => item.issues.length > 0)
          .map((item) => (
            <li key={`${item.type}:${item.id}`}>
              <strong>
                {item.type} {item.id}
              </strong>
              <ul>
                {item.issues.map((issue, i) => (
                  <li key={i} className={`issue issue-${issue.level.toLowerCase()}`}>
                    <span className="issue-level">{issue.level}</span>
                    {issue.path && <code>{issue.path}</code>} {issue.message}
                  </li>
                ))}
              </ul>
            </li>
          ))}
      </ul>
    </div>
  );
}
