// cross-spawn ships no types for its internal escaping helpers.
declare module 'cross-spawn/lib/util/escape.js' {
  export function command(arg: string): string;
  export function argument(arg: string, doubleEscape?: boolean): string;
  const escape: { command: typeof command; argument: typeof argument };
  export default escape;
}
