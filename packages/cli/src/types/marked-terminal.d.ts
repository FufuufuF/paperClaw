declare module 'marked-terminal' {
  import type { MarkedExtension } from 'marked';

  export interface MarkedTerminalOptions {
    width?: number;
    reflowText?: boolean;
    showSectionPrefix?: boolean;
    unescape?: boolean;
    emoji?: boolean;
    tab?: number | string;
    tableOptions?: Record<string, unknown>;
    [key: string]: unknown;
  }

  export function markedTerminal(
    options?: MarkedTerminalOptions,
    highlightOptions?: Record<string, unknown>,
  ): MarkedExtension;

  export default class TerminalRenderer {
    constructor(options?: MarkedTerminalOptions, highlightOptions?: Record<string, unknown>);
  }
}
