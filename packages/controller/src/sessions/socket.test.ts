import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControllerMessage, SessionMessage } from "@monadeo.com/astrogate-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { SessionServer, type LiveSession } from "./socket.js";

const path = join(tmpdir(), `astrogate-test-${process.pid}.sock`);
let server: SessionServer | undefined;

afterEach(() => server?.close());

describe("SessionServer", () => {
  it("registers a session, relays a tool call, and delivers a reply", async () => {
    const registered: LiveSession[] = [];
    const received: SessionMessage[] = [];
    server = new SessionServer(path, {
      onRegister: (s) => registered.push(s),
      onMessage: (s, m) => {
        received.push(m);
        if (m.kind === "tool") s.send({ kind: "result", id: m.id, result: { ok: true, message: "done" } });
      },
      onClose: () => undefined,
    });
    await server.listen();

    const client = connect(path);
    client.setEncoding("utf8");
    const replies: ControllerMessage[] = [];
    client.on("data", (chunk: string) => {
      for (const line of chunk.split("\n").filter((l) => l.length > 0)) replies.push(JSON.parse(line) as ControllerMessage);
    });
    await new Promise<void>((resolve) => client.once("connect", resolve));
    const send = (m: SessionMessage): boolean => client.write(`${JSON.stringify(m)}\n`);
    send({ kind: "register", registration: { role: "worker", paneId: "w1:p1", sessionFile: "/s.jsonl", ticket: 7, attempt: 1 } });
    send({ kind: "state", state: "working" });
    send({ kind: "tool", id: "t1", call: { tool: "submit", summary: "ready" } });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(registered).toHaveLength(1);
    expect(registered[0].registration.ticket).toBe(7);
    expect(received.map((m) => m.kind)).toEqual(["state", "tool"]);
    expect(replies).toEqual([{ kind: "result", id: "t1", result: { ok: true, message: "done" } }]);
    expect(server.find((r) => r.ticket === 7)).toBeDefined();
    client.destroy();
  });
});
