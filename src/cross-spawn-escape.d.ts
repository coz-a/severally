// cross-spawn ships no types for its internal escaping helpers.
declare module 'cross-spawn/lib/util/escape.js' {
  export function command(arg: string): string;
  export function argument(arg: string, doubleEscape?: boolean): string;
  const escape: { command: typeof command; argument: typeof argument };
  export default escape;
}

declare module 'cross-spawn/lib/parse.js' {
  import type { SpawnOptions } from 'node:child_process';
  export default function parse(command: string, args: readonly string[], options: SpawnOptions): {
    command: string; args: string[]; options: SpawnOptions; file?: string | undefined;
  };
}
