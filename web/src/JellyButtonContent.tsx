import type { ReactNode } from "react";

export function JellyButtonContent({ children }: { children: ReactNode }) {
  return (
    <>
      <span className="btn-jelly__fx" aria-hidden="true">
        <span className="btn-jelly__blobs">
          <span className="btn-jelly__blob btn-jelly__blob--wobble" />
          <span className="btn-jelly__blob btn-jelly__blob--flow" />
          <span className="btn-jelly__blob btn-jelly__blob--slow" />
        </span>
      </span>
      <span className="btn-jelly__label">{children}</span>
    </>
  );
}
