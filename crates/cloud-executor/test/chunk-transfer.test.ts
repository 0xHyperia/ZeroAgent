import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileBroker } from "../src/file-broker.ts";

const executable = process.platform === "win32" ? "wsl.exe" : "python3";
const prefix = process.platform === "win32" ? ["-d", "Ubuntu", "--", "python3"] : [];
const available =
  spawnSync(executable, [...prefix, "--version"], { timeout: 10_000, windowsHide: true }).status ===
  0;
const harness = String.raw`
import base64,hashlib,json,os,pathlib,subprocess,sys,tempfile
broker=base64.b64decode(sys.argv[1]).decode()
with tempfile.TemporaryDirectory(prefix='zeroagent-transfer-test-') as td:
 root=pathlib.Path(td)/'workspace'
 def run(payload):
  result=subprocess.run([sys.executable,'-c',broker],input=json.dumps(dict(root=str(root),limit=1048576,**payload)),capture_output=True,text=True,timeout=10)
  assert result.returncode==0,result.stderr
  return json.loads(result.stdout)
 assert run({'action':'init'})=={}
 content=b'0123456789abcdef'*(32*1024*1024//16);sha=hashlib.sha256(content).hexdigest();tid='a'*32
 base={'transfer_id':tid,'scope':'opaque-scope','sandbox_id':'owned-sandbox','total_bytes':len(content),'sha256':sha}
 begin=dict(base,action='upload.begin',path='documents/large.bin')
 assert run(begin)['received_bytes']==0
 assert run(dict(base,action='upload.finalize',path='documents/large.bin'))['error']=='transfer_incomplete'
 def chunk(offset,data): return run(dict(base,action='upload.chunk',offset=offset,data_base64=base64.b64encode(data).decode()))
 assert chunk(1048576,content[:1048576])['error']=='transfer_out_of_order'
 assert chunk(0,content[:1048576])['received_bytes']==1048576
 assert chunk(0,content[:1048576])['duplicate'] is True
 assert chunk(0,b'corrupt')['error']=='transfer_conflict'
 assert run(dict(begin,scope='other-owner'))['error']=='transfer_conflict'
 for offset in range(1048576,len(content),1048576): assert chunk(offset,content[offset:offset+1048576])['received_bytes']==offset+1048576
 final=dict(base,action='upload.finalize',path='documents/large.bin')
 assert run(final)['finalized'] is True
 assert run(final)['finalized'] is True
 assert (root/'documents/large.bin').stat().st_size==len(content)
 assert run(dict(base,action='upload.abort'))['error']=='transfer_finalized'
 out=run({'action':'download.chunk','path':'documents/large.bin','offset':31*1048576,'max_bytes':1048576,'expected_sha256':sha})
 assert out['eof'] and out['total_bytes']==len(content) and base64.b64decode(out['data_base64'])==content[-1048576:]
 assert run({'action':'download.chunk','path':'documents/large.bin','offset':0,'max_bytes':1,'expected_sha256':'0'*64})['error']=='digest_mismatch'
 stage=root/'.zeroagent-transfers';tid2='b'*32;b2=dict(base,transfer_id=tid2,total_bytes=3,sha256=hashlib.sha256(b'abc').hexdigest())
 assert run(dict(b2,action='upload.begin',path='other.bin'))['received_bytes']==0
 part=stage/(tid2+'.part');part.unlink();part.symlink_to(root/'documents/large.bin')
 assert run(dict(b2,action='upload.chunk',offset=0,data_base64='YWJj'))['error']=='invalid_path'
 part.unlink();part.write_bytes(b'')
 manifest=stage/(tid2+'.json');backup=stage/'backup';manifest.rename(backup);manifest.symlink_to(backup)
 assert run(dict(b2,action='upload.begin',path='other.bin'))['error']=='invalid_path'
 manifest.unlink();manifest.hardlink_to(backup)
 assert run(dict(b2,action='upload.begin',path='other.bin'))['error']=='file_limit'
 manifest.unlink();backup.rename(manifest)
 assert run(dict(b2,action='upload.abort'))['aborted']
 tid3='c'*32;b3=dict(b2,transfer_id=tid3)
 run(dict(b3,action='upload.begin',path='corrupt.bin'));run(dict(b3,action='upload.chunk',offset=0,data_base64='YWJj'))
 (stage/(tid3+'.part')).write_bytes(b'bad')
 assert run(dict(b3,action='upload.finalize',path='corrupt.bin'))['error']=='digest_mismatch' and not (root/'corrupt.bin').exists()
 assert run(dict(b3,action='upload.abort'))['aborted']
 print('32 MiB chunk transfer: PASS')
`;
test("real Linux 32 MiB transfer handles ordering, duplicate frames, corruption, scope and link rejection", {
  skip: !available,
}, () => {
  const output = execFileSync(
    executable,
    [...prefix, "-c", harness, Buffer.from(fileBroker).toString("base64")],
    { timeout: 60_000, windowsHide: true, encoding: "utf8" },
  );
  assert.match(output, /32 MiB chunk transfer: PASS/);
});
