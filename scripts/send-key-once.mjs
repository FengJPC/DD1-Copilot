import { NamedPipeCommandTransport } from "../dist/command/transport.js";

const sym = Number.parseInt(process.argv[2] ?? "", 0);
if (!Number.isInteger(sym)) throw new Error("Pass an SDL key symbol.");

const transport = new NamedPipeCommandTransport(
  "\\\\.\\pipe\\dd1-agent-bridge",
  3_000,
);
console.log(
  await transport.send({ kind: "key_press", args: { sym, mod: 0 } }),
);
