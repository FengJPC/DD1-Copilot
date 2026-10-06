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

for (const scenario of ['split_utf8', 'invalid_reason', 'closed_pipe'] as const) {
  test(`command acknowledgement audit: ${scenario}`, async () => {
    const path = `\\\\.\\pipe\\dd1-ack-audit-${process.pid}-${randomUUID()}`;
    const server = createServer(socket => socket.once('data', data => {
      const request = JSON.parse(data.toString('utf8'));
      if (scenario === 'closed_pipe') { socket.end(); return; }
      const payload = Buffer.from(JSON.stringify({ commandId: request.commandId, status: 'queued',
        reason: scenario === 'invalid_reason' ? { bad: true } : '游戏线程已接收' }) + '\n');
      if (scenario === 'split_utf8') {
        const split = payload.indexOf(Buffer.from('游')) + 1;
        socket.write(payload.subarray(0, split));
        setTimeout(() => socket.end(payload.subarray(split)), 10);
      } else socket.end(payload);
    }));
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
    try {
      const ack = await new NamedPipeCommandTransport(path, 2_000).send({ kind: 'inspect_state', args: {} });
      assert.equal(ack.status, scenario === 'split_utf8' ? 'queued' : 'timeout');
      assert.match(ack.reason ?? '', scenario === 'split_utf8' ? /游戏线程已接收/u : scenario === 'invalid_reason' ? /reason must be a string/ : /closed before acknowledgement/);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}
