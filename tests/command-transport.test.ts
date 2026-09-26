import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import test from "node:test";

import { NamedPipeCommandTransport } from "../src/command/transport.js";

test("named-pipe transport correlates acknowledgement without claiming execution", async () => {
  const pipePath = `\\\\.\\pipe\\dd1-agent-bridge-test-${process.pid}-${randomUUID()}`;
  const server = createServer((socket) => {
    let input = "";
    socket.on("data", (chunk: Buffer) => {
      input += chunk.toString("utf8");
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline)) as {
        commandId: string;
        command: { kind: string };
      };
      assert.equal(request.command.kind, "select_skill");
      socket.write(
        `${JSON.stringify({ commandId: request.commandId, status: "queued" })}\n`,
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, resolve);
  });

  try {
    const transport = new NamedPipeCommandTransport(pipePath, 2_000);
    const acknowledgement = await transport.send({
      kind: "select_skill",
      args: { skillId: "opened_vein" },
    });
    assert.equal(acknowledgement.transport, "named_pipe");
    assert.equal(acknowledgement.status, "queued");
    assert.equal("executed" in acknowledgement, false);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("corrupt acknowledgements after submission remain uncertain", async () => {
  const pipePath = `\\\\.\\pipe\\dd1-agent-bridge-corrupt-${process.pid}-${randomUUID()}`;
  const server = createServer((socket) => socket.once("data", () => socket.write('{"commandId":"wrong","status":"queued"}\n')));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(pipePath, resolve); });
  try {
    const acknowledgement = await new NamedPipeCommandTransport(pipePath, 100).send({ kind: "key_press", args: { sym: 13 } });
    assert.equal(acknowledgement.status, "timeout");
    assert.match(acknowledgement.reason ?? "", /commandId/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
