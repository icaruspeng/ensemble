declare module "qrcode" {
  type QRColor = { dark?: string; light?: string };
  type QROptions = {
    width?: number;
    margin?: number;
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
    color?: QRColor;
  };

  const QRCode: {
    toCanvas(canvas: HTMLCanvasElement, text: string, options?: QROptions): Promise<void>;
  };

  export default QRCode;
}

declare module "react" {
  export type ReactNode = unknown;
  export type CSSProperties = Record<string, string | number | undefined>;
  export type FormEvent<T = Element> = {
    currentTarget: T;
    target: EventTarget;
    preventDefault(): void;
  };
  export type KeyboardEvent<T = Element> = {
    currentTarget: T;
    target: EventTarget;
    key: string;
    shiftKey: boolean;
    preventDefault(): void;
  };
  export type PointerEvent<T = Element> = {
    currentTarget: T;
    target: EventTarget;
  };
  export type SetStateAction<S> = S | ((previous: S) => S);
  export type Dispatch<A> = (value: A) => void;

  export function useState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  export function useEffect(effect: () => void | (() => void), dependencies?: readonly unknown[]): void;
  export function useMemo<T>(factory: () => T, dependencies: readonly unknown[]): T;
  export function useCallback<T extends (...arguments_: never[]) => unknown>(callback: T, dependencies: readonly unknown[]): T;
  export function useRef<T>(initial: T): { current: T };
  export function useRef<T>(initial: null): { current: T | null };
}

declare module "react/jsx-runtime" {
  export function jsx(type: unknown, properties: unknown, key?: unknown): unknown;
  export function jsxs(type: unknown, properties: unknown, key?: unknown): unknown;
  export const Fragment: unknown;
}

declare module "react-dom/client" {
  export function createRoot(container: Element | DocumentFragment): {
    render(children: unknown): void;
    unmount(): void;
  };
}

declare module "react-dom" {
  export function createPortal(children: unknown, container: Element | DocumentFragment): unknown;
}

declare namespace JSX {
  interface IntrinsicAttributes {
    key?: string | number;
  }

  interface IntrinsicElements {
    [elementName: string]: Record<string, unknown>;
  }
}
