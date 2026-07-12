import { EventEmitter } from "events";

/**
 * Tiny structured logger. Every line carries ts/level/component/msg/fields and is
 * also pushed onto `logBus` so the read API can stream keeper activity live —
 * the logs themselves are demo material ("watch it settle itself").
 */
export type Level = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  ts: string;
  level: Level;
  component: string;
  msg: string;
  fields?: Record<string, unknown>;
}

export const logBus = new EventEmitter();
logBus.setMaxListeners(100);

const JSON_MODE = process.env.LOG_JSON === "1";
const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN = LEVELS[(process.env.LOG_LEVEL as Level) || "info"] ?? 1;

function emit(rec: LogRecord) {
  if (LEVELS[rec.level] >= MIN) {
    if (JSON_MODE) {
      console.log(JSON.stringify(rec));
    } else {
      const f = rec.fields ? " " + JSON.stringify(rec.fields) : "";
      console.log(
        `${rec.ts} ${rec.level.toUpperCase().padEnd(5)} [${rec.component}] ${
          rec.msg
        }${f}`
      );
    }
  }
  logBus.emit("log", rec);
}

export class Logger {
  constructor(private component: string) {}
  child(sub: string) {
    return new Logger(`${this.component}:${sub}`);
  }
  private rec(level: Level, msg: string, fields?: Record<string, unknown>) {
    emit({
      ts: new Date().toISOString(),
      level,
      component: this.component,
      msg,
      fields,
    });
  }
  debug(msg: string, fields?: Record<string, unknown>) {
    this.rec("debug", msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>) {
    this.rec("info", msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>) {
    this.rec("warn", msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>) {
    this.rec("error", msg, fields);
  }
}
