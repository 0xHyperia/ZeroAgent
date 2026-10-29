import { Ledger } from "../src/ledger.ts";

const ledger = new Ledger(process.argv[2], 100);
await ledger.init();
await ledger.save({
  operation_id: "crash-operation",
  action: "sandbox.create",
  state: "executing",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  scope_hash: "scope-crash",
  request_hash: "request-crash",
  result: { sandbox_id: "possibly-created-before-crash" },
});
setInterval(() => {}, 1000);
process.send?.({ ready: true });
await new Promise(() => {});
