import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import QRCode from "qrcode";
import "./share-dialog.css";

export interface ShareDialogProps {
  open: boolean;
  onClose: () => void;
  steerLink?: string;
  viewLink?: string;
}

type Feedback =
  | { tone: "success" | "error"; message: string }
  | null;

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableElements(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(
    (element) =>
      !element.hidden &&
      element.getAttribute("aria-disabled") !== "true" &&
      element.getAttribute("aria-hidden") !== "true",
  );
}

function trapFocus(event: globalThis.KeyboardEvent, container: HTMLElement) {
  if (event.key !== "Tab") return;

  const focusable = focusableElements(container);
  if (!focusable.length) {
    event.preventDefault();
    container.focus();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !container.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

function fallbackCopy(text: string) {
  const previousFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const textarea = document.createElement("textarea");

  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto -9999px";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);

  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    if (
      typeof document.execCommand !== "function" ||
      !document.execCommand("copy")
    ) {
      throw new Error("The browser rejected the copy command");
    }
  } finally {
    textarea.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
  }
}

async function copyText(text: string) {
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Clipboard access can be rejected outside a secure context. The
    // selection-based path still works in older and locked-down browsers.
  }

  fallbackCopy(text);
}

interface ShareLinkRowProps {
  kind: "steer" | "view";
  label: "Can steer" | "Can view";
  link?: string;
}

function ShareLinkRow({ kind, label, link }: ShareLinkRowProps) {
  const [showQr, setShowQr] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [qrError, setQrError] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const feedbackTimerRef = useRef<number | null>(null);
  const qrId = `share-${kind}-qr`;
  const feedbackId = `share-${kind}-feedback`;

  useEffect(() => {
    setFeedback(null);
    setQrError("");
    if (!link) setShowQr(false);
  }, [link]);

  useEffect(() => {
    if (!showQr || !link || !canvasRef.current) return;

    let cancelled = false;
    setQrError("");
    void QRCode.toCanvas(canvasRef.current, link, {
      width: 208,
      margin: 3,
      errorCorrectionLevel: "M",
      color: { dark: "#dce3df", light: "#111419" },
    }).catch(() => {
      if (!cancelled) {
        setQrError("The QR code could not be rendered. The link still works.");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [link, showQr]);

  useEffect(
    () => () => {
      if (feedbackTimerRef.current !== null) {
        window.clearTimeout(feedbackTimerRef.current);
      }
    },
    [],
  );

  const scheduleFeedbackClear = (delay: number) => {
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current);
    }
    feedbackTimerRef.current = window.setTimeout(() => {
      setFeedback(null);
      feedbackTimerRef.current = null;
    }, delay);
  };

  const handleCopy = async () => {
    if (!link) return;
    setFeedback(null);

    try {
      await copyText(link);
      setFeedback({ tone: "success", message: "Link copied" });
      scheduleFeedbackClear(2_500);
    } catch {
      setFeedback({
        tone: "error",
        message: "Copy failed. Select the link and copy it manually.",
      });
      scheduleFeedbackClear(5_000);
    }
  };

  return (
    <section className="share-dialog__row" aria-labelledby={`share-${kind}-label`}>
      <div className="share-dialog__role">
        <strong id={`share-${kind}-label`}>{label}</strong>
        <span>{kind === "steer" ? "Join and direct agents" : "Watch in real time"}</span>
      </div>

      <div className="share-dialog__link-column">
        {link ? (
          <div className="share-dialog__link" title={link}>{link}</div>
        ) : (
          <div className="share-dialog__link share-dialog__link--missing">
            Link unavailable
          </div>
        )}
        <span
          className={`share-dialog__feedback${feedback ? ` share-dialog__feedback--${feedback.tone}` : ""}`}
          id={feedbackId}
          role={feedback?.tone === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {feedback?.message ?? ""}
        </span>
      </div>

      <div className="share-dialog__actions">
        <button
          className="share-dialog__button share-dialog__button--copy"
          type="button"
          disabled={!link}
          aria-describedby={feedback ? feedbackId : undefined}
          onClick={() => void handleCopy()}
        >
          {feedback?.tone === "success" ? "Copied" : "Copy"}
        </button>
        <button
          className="share-dialog__button"
          type="button"
          disabled={!link}
          aria-expanded={showQr}
          aria-controls={qrId}
          onClick={() => {
            setQrError("");
            setShowQr((visible) => !visible);
          }}
        >
          {showQr ? "Hide QR" : "Show QR"}
        </button>
      </div>

      {showQr && link && (
        <div className="share-dialog__qr" id={qrId}>
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={`QR code for ${label} link`}
          >
            QR code for {link}
          </canvas>
          <div>
            <strong>Scan to open</strong>
            <span>{label}</span>
          </div>
          {qrError && <p role="alert">{qrError}</p>}
        </div>
      )}
    </section>
  );
}

export function ShareDialog({
  open,
  onClose,
  steerLink,
  viewLink,
}: ShareDialogProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousBodyOverflow = document.body.style.overflow;
    const overlay = overlayRef.current;
    const inerted: Array<{ element: HTMLElement; wasInert: boolean }> = [];

    document.body.style.overflow = "hidden";
    if (overlay) {
      for (const child of Array.from(document.body.children)) {
        if (!(child instanceof HTMLElement)) continue;
        if (child === overlay || child.contains(overlay)) continue;
        const wasInert = child.hasAttribute("inert");
        inerted.push({ element: child, wasInert });
        if (!wasInert) child.setAttribute("inert", "");
      }
    }

    const initialFocus = dialogRef.current?.querySelector<HTMLElement>(
      "[data-share-autofocus]",
    );
    (initialFocus ?? dialogRef.current)?.focus({ preventScroll: true });

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (dialogRef.current) trapFocus(event, dialogRef.current);
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousBodyOverflow;
      for (const { element, wasInert } of inerted) {
        if (!wasInert) element.removeAttribute("inert");
      }
      if (previousFocus?.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      ref={overlayRef}
      className="share-dialog-overlay"
      role="presentation"
      onClick={(event: { target: EventTarget; currentTarget: HTMLDivElement }) => {
        if (event.target === event.currentTarget) closeRef.current();
      }}
    >
      <section
        ref={dialogRef}
        className="share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
        aria-describedby="share-dialog-description"
        tabIndex={-1}
      >
        <header className="share-dialog__header">
          <div>
            <span className="share-dialog__eyebrow">INVITE THE ROOM</span>
            <h2 id="share-dialog-title">Share this task</h2>
            <p id="share-dialog-description">
              Choose whether teammates can steer the agents or watch the work unfold.
            </p>
          </div>
          <button
            className="share-dialog__close"
            type="button"
            data-share-autofocus
            aria-label="Close share dialog"
            onClick={() => closeRef.current()}
          >
            Close
          </button>
        </header>

        <div className="share-dialog__rows">
          <ShareLinkRow kind="steer" label="Can steer" link={steerLink} />
          <ShareLinkRow kind="view" label="Can view" link={viewLink} />
        </div>

        <footer className="share-dialog__footer">
          Anyone with a link can enter with that level of access.
        </footer>
      </section>
    </div>,
    document.body,
  );
}

export default ShareDialog;
