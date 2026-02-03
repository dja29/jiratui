declare module "@opentui/react" {
  import type { ReactNode } from "react";
  import type { CliRenderer } from "@opentui/core";

  export interface Root {
    render: (node: ReactNode) => void;
    unmount: () => void;
  }

  export function createRoot(renderer: CliRenderer): Root;
  export function useKeyboard(
    handler: (key: KeyEvent) => void,
    options?: { release?: boolean }
  ): void;
  export function useTerminalDimensions(): { width: number; height: number };
  export function useRenderer(): CliRenderer;

  export interface KeyEvent {
    name: string;
    ctrl: boolean;
    meta: boolean;
    shift: boolean;
    option: boolean;
    sequence: string;
    number: boolean;
    raw: string;
  }
}

declare module "@opentui/core" {
  import { EventEmitter } from "events";

  export interface CliRendererConfig {
    stdin?: NodeJS.ReadStream;
    stdout?: NodeJS.WriteStream;
    exitOnCtrlC?: boolean;
    exitSignals?: NodeJS.Signals[];
    debounceDelay?: number;
    targetFps?: number;
    maxFps?: number;
    backgroundColor?: string;
    useMouse?: boolean;
    useAlternateScreen?: boolean;
    useConsole?: boolean;
  }

  export class CliRenderer extends EventEmitter {
    width: number;
    height: number;
    start(): void;
    stop(): void;
    destroy(): void;
  }

  export function createCliRenderer(
    config?: CliRendererConfig
  ): Promise<CliRenderer>;

  export interface KeyEvent {
    name: string;
    ctrl: boolean;
    meta: boolean;
    shift: boolean;
    option: boolean;
    sequence: string;
    number: boolean;
    raw: string;
    eventType: "press" | "release";
    source: "raw" | "kitty";
    code?: string;
    repeated?: boolean;
  }
}
