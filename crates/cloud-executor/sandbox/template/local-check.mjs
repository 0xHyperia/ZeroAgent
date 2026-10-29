import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { directory, plan } from './build.mjs';

// Uses an already-built local image; never pulls/builds/publishes or calls E2B.
export async function localCheck(image, output) {
  if (!/^zeroagent-cloudchat-template:[a-zA-Z0-9_.-]+$/.test(image)) throw new Error('explicit_local_image_required');
  output = path.resolve(output);
  if (output.includes(',') || output.includes('\0')) throw new Error('invalid_output_path');
  await mkdir(output, { recursive: false }); // Existing evidence must not be overwritten.
  const prepared = await plan();
  const id = randomUUID();
  const name = `zeroagent-template-check-${id}`;
  const label = `zeroagent.cloudchat.template-check=${id}`;
  const record = { format: 1, id, name, image, plan_sha256: prepared.plan_sha256, e2b_allocations: 0, success: false };
  let created = false;
  function docker(args, timeout = 20000) {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(`docker_step_failed:${args[0]}`);
    return (args[0] === 'start' ? result.stdout + result.stderr : result.stdout).trim();
  }
  try {
    const metadata = JSON.parse(docker(['image', 'inspect', image]))[0];
    record.image_id = metadata.Id;
    record.container_id = docker(['create', '--pull', 'never', '--name', name, '--label', label,
      '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--user', '1000:1000', '--memory', '1536m', '--memory-swap', '1536m', '--cpus', '1', '--pids-limit', '64',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
      '--tmpfs', '/home/user:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=64m',
      '--mount', `type=bind,source=${path.join(directory, '../file_parser.py')},target=/opt/zeroagent-parser.py,readonly`,
      '--mount', `type=bind,source=${output},target=/evidence`,
      '--entrypoint', 'python3', image, '-IB', '/opt/zeroagent-template/acceptance.py',
      '--parser', '/opt/zeroagent-parser.py', '--report', '/evidence/report.json']);
    created = true;
    for (const [file, hash] of Object.entries(prepared.candidate.files)) {
      const target = path.join(output, `packaged-${file}`);
      docker(['cp', `${name}:/opt/zeroagent-template/${file}`, target]);
      if (createHash('sha256').update(await readFile(target)).digest('hex') !== hash) throw new Error('stale_candidate_image');
    }
    record.parser_sha256 = createHash('sha256').update(await readFile(path.join(directory, '../file_parser.py'))).digest('hex');
    // stdout can include Python diagnostics; never includes credentials (none supplied).
    const completed = docker(['start', '--attach', name], 120000);
    await writeFile(path.join(output, 'container.log'), completed + '\n', { flag: 'wx' });
    if (/Missing colon in file|Duplicate key in file|Glyph .*missing from font/.test(completed)) throw new Error('matplotlib_configuration_or_glyph_warning');
    const state = JSON.parse(docker(['inspect', name]))[0];
    if (state.State.ExitCode !== 0 || state.State.OOMKilled || state.HostConfig.NetworkMode !== 'none'
      || !state.HostConfig.ReadonlyRootfs || state.Config.User !== '1000:1000'
      || state.HostConfig.Memory !== 1536 * 1024 * 1024
      || state.HostConfig.MemorySwap !== state.HostConfig.Memory || state.HostConfig.PidsLimit !== 64
      || state.HostConfig.NanoCpus !== 1000000000 || Object.keys(state.HostConfig.PortBindings ?? {}).length !== 0
      || !state.HostConfig.SecurityOpt.includes('no-new-privileges:true')
      || !state.HostConfig.CapDrop.includes('ALL')) throw new Error('container_boundary_failed');
    const report = JSON.parse(await readFile(path.join(output, 'report.json'), 'utf8'));
    if (report.local_only !== true || report.sum !== '124.75' || Object.keys(report.parsed).length !== 4) throw new Error('output_contract_failed');
    if (report.chinese_font?.family !== 'Noto Sans SC' || report.chinese_font?.required_glyphs !== 6
      || report.chinese_font?.missing_glyphs !== 0 || report.chinese_font?.missing_glyph_warnings !== 0
      || report.chinese_font?.pdf_text_verified !== true) throw new Error('chinese_font_contract_failed');
    record.success = true;
    record.boundaries = { uid: state.Config.User, memory_bytes: state.HostConfig.Memory,
      readonly: true, network: 'none', no_new_privileges: state.HostConfig.SecurityOpt.includes('no-new-privileges:true') };
    return record;
  } finally {
    if (created) {
      const owned = JSON.parse(docker(['inspect', name]))[0];
      if (owned.Id !== record.container_id || owned.Config.Labels['zeroagent.cloudchat.template-check'] !== id) throw new Error('cleanup_ownership_changed');
      docker(['rm', '--force', name]);
      record.container_removed = true;
    }
    await writeFile(path.join(output, 'manifest.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error('usage: local-check.mjs LOCAL_IMAGE NEW_EVIDENCE_DIRECTORY');
  localCheck(process.argv[2], process.argv[3]).then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
