import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileBroker } from "../src/file-broker.ts";

// A real Linux Python runtime validates descriptor/symlink semantics. It only
// creates its own TemporaryDirectory and never calls E2B or a user data path.
const executable = process.platform === "win32" ? "wsl.exe" : "python3";
const prefix = process.platform === "win32" ? ["-d", "Ubuntu", "--", "python3"] : [];
const available =
  spawnSync(executable, [...prefix, "--version"], { timeout: 10_000, windowsHide: true }).status ===
  0;
const harness = String.raw`
import base64,json,os,pathlib,subprocess,sys,tempfile
broker=base64.b64decode(sys.argv[1]).decode()
with tempfile.TemporaryDirectory(prefix='zeroagent-executor-broker-test-') as td:
 root=pathlib.Path(td)/'workspace';outside=pathlib.Path(td)/'outside';outside.mkdir();(outside/'secret').write_text('private')
 def call(action,path='',data='',limit=32):
  payload=json.dumps({'action':action,'root':str(root),'path':path,'data':data,'limit':limit})
  result=subprocess.run([sys.executable,'-c',broker],input=payload,capture_output=True,text=True,timeout=5)
  if result.returncode==0 and json.loads(result.stdout).get('error'): result.returncode=1
  return result
 assert call('init').returncode==0
 assert call('write','nested/a.txt','aGk=').returncode==0
 result=call('read','nested/a.txt');assert result.returncode==0 and json.loads(result.stdout)['data_base64']=='aGk='
 (root/'link').symlink_to(outside,target_is_directory=True)
 assert call('read','link/secret').returncode!=0
 assert call('write','link/new','aGk=').returncode!=0 and not (outside/'new').exists()
 (root/'final').symlink_to(outside/'secret')
 assert call('read','final').returncode!=0
 assert call('write','final','aGk=').returncode==0 and (outside/'secret').read_text()=='private'
 assert (root/'final').read_text()=='hi' and not (root/'final').is_symlink()
 os.link(outside/'secret',root/'hard');assert call('read','hard').returncode!=0
 os.mkfifo(root/'fifo');assert call('read','fifo').returncode!=0
 (root/'large').write_bytes(b'x'*33);assert call('read','large').returncode!=0
 assert call('write','nested/quote\'name','aGk=').returncode==0
 assert call('read','nested/quote\'name').returncode==0
 large=base64.b64encode(b'x'*(1024*1024)).decode()
 assert call('write','one-mib.bin',large,1024*1024).returncode==0
 assert (root/'one-mib.bin').stat().st_size==1024*1024
 print('descriptor-safe file broker: PASS')
`;
test("real Linux descriptor-safe file broker bounds reads and rejects symlink, hardlink, FIFO and oversized escapes", {
  skip: !available,
}, () => {
  const output = execFileSync(
    executable,
    [...prefix, "-c", harness, Buffer.from(fileBroker).toString("base64")],
    { timeout: 30_000, windowsHide: true, encoding: "utf8" },
  );
  assert.match(output, /descriptor-safe file broker: PASS/);
});
