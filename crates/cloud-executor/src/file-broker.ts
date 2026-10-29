import { readFileSync } from "node:fs";
// This is trusted packaged source. Only the VM executes it on untrusted files.
export const fileBroker = readFileSync(
  new URL("../sandbox/file_broker.py", import.meta.url),
  "utf8",
);
export const fileParser = readFileSync(
  new URL("../sandbox/file_parser.py", import.meta.url),
  "utf8",
);
export const archiveExtractor = readFileSync(
  new URL("../sandbox/archive_extract.py", import.meta.url),
  "utf8",
);
function sourceCommand(): string {
  return `python3 -c 'import base64;exec(base64.b64decode("${Buffer.from(fileBroker).toString("base64")}"))'`;
}
export function brokerCommand(payload: Record<string, unknown>): string {
  return `${sourceCommand()} '${Buffer.from(JSON.stringify(payload)).toString("base64")}'`;
}
export function brokerInput(payload: Record<string, unknown>): {
  command: string;
  input: Uint8Array;
} {
  return { command: sourceCommand(), input: Buffer.from(JSON.stringify(payload)) };
}
export function parserInput(payload: Record<string, unknown>): {
  command: string;
  input: Uint8Array;
} {
  return {
    command: `python3 -I -c 'import base64;exec(compile(base64.b64decode("${Buffer.from(fileParser).toString("base64")}"),"file_parser.py","exec"))'`,
    input: Buffer.from(JSON.stringify(payload)),
  };
}
export function archiveInput(payload: Record<string, unknown>): {
  command: string;
  input: Uint8Array;
} {
  return {
    command: `python3 -I -c 'import base64;exec(compile(base64.b64decode("${Buffer.from(archiveExtractor).toString("base64")}"),"archive_extract.py","exec"))'`,
    input: Buffer.from(JSON.stringify(payload)),
  };
}
