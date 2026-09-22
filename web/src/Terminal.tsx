import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/** The operations that the application does on the terminal. */
export interface TerminalHandle {
  write(bytes: Uint8Array): void;
  writeLine(text: string): void;
  focus(): void;
  size(): { cols: number; rows: number };
}

interface Props {
  /** Keyboard input, which includes control bytes such as Ctrl-C. */
  onInput(data: string): void;
  /** The window changed size. */
  onResize(cols: number, rows: number): void;
  /** The terminal is on the page and ready to use. */
  onReady(handle: TerminalHandle): void;
}

export function TerminalView({ onInput, onResize, onReady }: Props) {
  const holder = useRef<HTMLDivElement>(null);
  // The callbacks are kept in a ref so that a new render does not build the
  // terminal again.
  const callbacks = useRef({ onInput, onResize, onReady });
  callbacks.current = { onInput, onResize, onReady };

  useEffect(() => {
    const element = holder.current;
    if (!element) {
      return;
    }

    const term = new Terminal({
      scrollback: 10_000,
      fontFamily: '"DejaVu Sans Mono", "Liberation Mono", Menlo, monospace',
      fontSize: 14,
      cursorBlink: true,
      theme: { background: '#11131a', foreground: '#d7dae0' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    fit.fit();

    term.onData((data) => callbacks.current.onInput(data));
    term.onResize(({ cols, rows }) => callbacks.current.onResize(cols, rows));

    // xterm writes bytes without a copy, so the caller must not reuse them.
    callbacks.current.onReady({
      write: (bytes) => term.write(bytes),
      writeLine: (text) => term.writeln(text),
      focus: () => term.focus(),
      size: () => ({ cols: term.cols, rows: term.rows }),
    });

    // A resize of the window changes the number of columns and rows, and the
    // onResize handler above then tells the remote host.
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // The element can be hidden during a layout change. Ignore it.
      }
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
      term.dispose();
    };
  }, []);

  return <div className="terminal" ref={holder} />;
}
