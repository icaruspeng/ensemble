type GracefulStateKind = "loading" | "workspace-error" | "invalid-invite";

interface GracefulStateProps {
  kind: GracefulStateKind;
  message: string;
  detail?: string;
  fullScreen?: boolean;
  actionHref?: string;
  actionLabel?: string;
}

function quietText(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function GracefulState({
  kind,
  message,
  detail,
  fullScreen = false,
  actionHref,
  actionLabel,
}: GracefulStateProps) {
  const quietMessage = quietText(message);
  const quietDetail = detail ? quietText(detail) : "";
  const role = kind === "loading" ? "status" : "alert";

  return (
    <div
      className={`graceful-state${fullScreen ? " graceful-state--fullscreen" : ""}`}
      data-state={kind}
      role={role}
      aria-live={kind === "loading" ? "polite" : "assertive"}
      aria-busy={kind === "loading" || undefined}
    >
      <div className="graceful-state__content">
        <span className="graceful-state__orb" aria-hidden="true" />
        <p
          className={`graceful-state__message${quietDetail ? " hint hint--below" : ""}`}
          data-hint={quietDetail || undefined}
          title={quietDetail || undefined}
          aria-label={quietDetail ? `${quietMessage}. ${quietDetail}` : quietMessage}
        >
          <span aria-hidden="true">{quietMessage}</span>
        </p>
        {actionHref && actionLabel && (
          <a className="graceful-state__action" href={actionHref}>
            {quietText(actionLabel)}
          </a>
        )}
      </div>
    </div>
  );
}
