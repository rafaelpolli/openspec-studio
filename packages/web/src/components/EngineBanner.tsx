import type { EngineStatus } from "@studio/shared";
import type { ButtonHTMLAttributes } from "react";
import { Link } from "wouter";

/** Engine availability; nothing is shown when AI actions are available. */
export function EngineBanner({ status, onRetry }: { status: EngineStatus | undefined; onRetry?: () => void }) {
  if (!status || status.availability === "disponivel") return null;
  switch (status.availability) {
    case "iniciando":
      return (
        <div className="banner banner-info" role="status">
          Iniciando o motor de IA…
        </div>
      );
    case "sem_provedor":
      return (
        <div className="banner banner-warn" role="status">
          Nenhum provedor de LLM configurado. As ações de IA ficam desabilitadas até você{" "}
          <Link href="/providers">configurar um provedor</Link>.
        </div>
      );
    case "falhou":
      return (
        <div className="banner banner-error" role="alert">
          <strong>O motor de IA falhou.</strong> {status.message}{" "}
          {onRetry && (
            <button type="button" onClick={onRetry}>
              Tentar novamente
            </button>
          )}
        </div>
      );
  }
}

const REASON: Record<EngineStatus["availability"], string> = {
  disponivel: "",
  iniciando: "O motor de IA ainda está iniciando",
  sem_provedor: "Configure um provedor de LLM para usar ações de IA",
  falhou: "O motor de IA não está disponível",
};

/** A button for an AI action (propose, onboarding) that is disabled unless the engine is available. */
export function AiButton({
  status,
  disabled,
  title,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { status: EngineStatus | undefined }) {
  const availability = status?.availability ?? "iniciando";
  const blocked = availability !== "disponivel";
  return (
    <button
      type="button"
      {...props}
      disabled={blocked || disabled}
      title={blocked ? REASON[availability] : title}
      aria-disabled={blocked || disabled}
    />
  );
}
