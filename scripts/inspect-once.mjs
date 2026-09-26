import { NamedPipeCommandTransport } from "../dist/command/transport.js";

const transport = new NamedPipeCommandTransport(
  "\\\\.\\pipe\\dd1-agent-bridge",
  3_000,
);
console.log(await transport.send({ kind: "inspect_state", args: {} }));
