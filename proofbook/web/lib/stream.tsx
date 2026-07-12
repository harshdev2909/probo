"use client";

/**
 * One SSE connection to the keeper, multiplexed (score/market/receipt/log),
 * shared app-wide via context. Auto-reconnects with backoff; exposes a
 * connection status for the nav indicator. Never polls.
 */
import {
  createContext, useContext, useEffect, useRef, useState, useCallback,
} from "react";
import { KEEPER_API } from "./api";

export type StreamStatus = "connecting" | "live" | "down";
export interface ScoreEvent {
  fixtureId: number; seq: number; statusId?: number;
  score?: { p1?: number; p2?: number }; ts: number;
}
export interface LogEvent {
  ts: string; level: string; component: string; msg: string;
  fields?: Record<string, unknown>;
}

type Listener = (type: string, data: unknown) => void;

const Ctx = createContext<{
  status: StreamStatus;
  subscribe: (fn: Listener) => () => void;
} | null>(null);

export function StreamProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const listeners = useRef(new Set<Listener>());

  const subscribe = useCallback((fn: Listener) => {
    listeners.current.add(fn);
    return () => listeners.current.delete(fn);
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    let backoff = 1000;
    let timer: ReturnType<typeof setTimeout>;
    let closed = false;

    const connect = () => {
      if (closed) return;
      setStatus("connecting");
      es = new EventSource(`${KEEPER_API}/stream`);
      const fan = (type: string) => (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          listeners.current.forEach((fn) => fn(type, data));
        } catch { /* heartbeat */ }
      };
      for (const t of ["score", "market", "receipt", "log"]) {
        es.addEventListener(t, fan(t));
      }
      es.onopen = () => { setStatus("live"); backoff = 1000; };
      es.onerror = () => {
        es?.close();
        setStatus("down");
        timer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 15000);
      };
    };
    connect();
    return () => { closed = true; clearTimeout(timer); es?.close(); };
  }, []);

  return <Ctx.Provider value={{ status, subscribe }}>{children}</Ctx.Provider>;
}

export function useStreamStatus(): StreamStatus {
  return useContext(Ctx)?.status ?? "down";
}

/** Subscribe to one event type. Handler identity may change freely. */
export function useStreamEvent<T = unknown>(type: string, handler: (data: T) => void) {
  const ctx = useContext(Ctx);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!ctx) return;
    return ctx.subscribe((t, data) => {
      if (t === type) ref.current(data as T);
    });
  }, [ctx, type]);
}
