import type { SystemStatus } from "@studio/shared";

/** Shown instead of OpenSpec data when the CLI is missing or too old. */
export function CliBanner({ system }: { system: SystemStatus | undefined }) {
  if (!system || system.openspec.available) return null;
  return (
    <div className="banner banner-error" role="alert">
      <strong>CLI do OpenSpec indisponível.</strong> {system.openspec.message}
      <div className="muted">
        Instale o OpenSpec (veja <a href="https://github.com/Fission-AI/OpenSpec">github.com/Fission-AI/OpenSpec</a>),
        confira se o comando <code>openspec</code> está no PATH do backend e recarregue a página.
      </div>
    </div>
  );
}
