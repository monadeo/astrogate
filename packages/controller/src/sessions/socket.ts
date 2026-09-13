import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import type { ControllerMessage, SessionMessage, SessionRegistration } from "@monadeo.com/astrogate-protocol";
import { log } from "../log.js";

export interface LiveSession {
  registration: SessionRegistration;
  manual: boolean;
  send: (message: ControllerMessage) => void;
}

export interface SessionServerHandlers {
  onRegister: (session: LiveSession) => void;
  onMessage: (session: LiveSession, message: SessionMessage) => void;
  onClose: (session: LiveSession) => void;
}

function isSessionMessage(value: unknown): value is SessionMessage {
  return typeof value === "object" && value !== null && typeof (value as { kind?: unknown }).kind === "string";
}

/** Newline-delimited JSON over a Unix socket; one connection per Pi session. */
export class SessionServer {
  readonly path: string;
  readonly #server: Server;
  readonly #sessions = new Map<Socket, LiveSession>();

  constructor(path: string, handlers: SessionServerHandlers) {
    this.path = path;
    this.#server = createServer((socket) => this.#attach(socket, handlers));
  }

  #attach(socket: Socket, handlers: SessionServerHandlers): void {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line.trim().length === 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          log("socket", "dropping malformed line");
          continue;
        }
        if (!isSessionMessage(parsed)) continue;
        this.#dispatch(socket, parsed, handlers);
      }
    });
    socket.on("close", () => {
      const session = this.#sessions.get(socket);
      if (session) {
        this.#sessions.delete(socket);
        handlers.onClose(session);
      }
    });
    socket.on("error", (error) => log("socket", `connection error: ${error.message}`));
  }

  #dispatch(socket: Socket, message: SessionMessage, handlers: SessionServerHandlers): void {
    if (message.kind === "register") {
      const session: LiveSession = {
        registration: message.registration,
        manual: false,
        send: (out) => socket.write(`${JSON.stringify(out)}\n`),
      };
      this.#sessions.set(socket, session);
      handlers.onRegister(session);
      return;
    }
    const session = this.#sessions.get(socket);
    if (!session) {
      log("socket", `message before registration: ${message.kind}`);
      return;
    }
    if (message.kind === "manual") session.manual = message.enabled;
    handlers.onMessage(session, message);
  }

  listen(): Promise<void> {
    if (existsSync(this.path)) unlinkSync(this.path);
    return new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(this.path, () => {
        // The worker OS user must be able to connect.
        chmodSync(this.path, 0o666);
        log("socket", `listening on ${this.path}`);
        resolve();
      });
    });
  }

  sessions(): LiveSession[] {
    return [...this.#sessions.values()];
  }

  find(predicate: (registration: SessionRegistration) => boolean): LiveSession | undefined {
    return this.sessions().find((s) => predicate(s.registration));
  }

  close(): void {
    this.#server.close();
    if (existsSync(this.path)) unlinkSync(this.path);
  }
}
