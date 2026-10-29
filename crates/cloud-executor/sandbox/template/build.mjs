import { createHash } from 'node:crypto';
import { lstat, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Template } from 'e2b';

export const directory = path.dirname(fileURLToPath(import.meta.url));
const sourceFiles = ['base.lock.json', 'requirements.lock.txt', 'check_environment.py', 'acceptance.py', 'matplotlibrc', 'configure_fonts.py', 'font-assets.lock.json', 'install_fonts.py'];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code) => { throw new Error(code); };
export async function readLock() {
  return JSON.parse(await readFile(path.join(directory, 'base.lock.json'), 'utf8'));
}

export function specification(lock) {
  if (lock.base_kind !== 'official_public_template_build'
    || !/^[a-z0-9]{20}:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(lock.template)
    || lock.template !== `${lock.template_id}:${lock.build_id}` || lock.image !== undefined) fail('immutable_template_build_required');
  if (lock.startup_contract !== 'inherit_immutable_base_start_and_ready'
    || lock.start_command !== undefined) fail('base_startup_inheritance_required');
  return Template({ fileContextPath: directory })
    .fromTemplate(lock.template)
    .setUser('root')
    .copy(sourceFiles, '/opt/zeroagent-template/', { user: 'root', mode: 0o644, resolveSymlinks: false })
    .runCmd('python3 -IB /opt/zeroagent-template/check_environment.py --base-only')
    .runCmd('python3 -m pip install --disable-pip-version-check --no-cache-dir --only-binary=:all: --require-hashes --no-deps --index-url https://pypi.org/simple -r /opt/zeroagent-template/requirements.lock.txt')
    .runCmd('python3 -IB /opt/zeroagent-template/check_environment.py')
    .runCmd('python3 -IB /opt/zeroagent-template/install_fonts.py')
    .runCmd('python3 -IB /opt/zeroagent-template/configure_fonts.py')
    .runCmd('install -d -o user -g user -m 0700 /home/user/zeroagent-workspace')
    .setUser(lock.user)
    .setWorkdir(lock.workdir);
}

export async function plan() {
  const lock = await readLock();
  const pkg = JSON.parse(await readFile(path.join(directory, '../../package.json'), 'utf8'));
  for (const [name, version] of Object.entries(lock.sdk)) {
    if (pkg.dependencies[name] !== version) fail('sdk_pin_changed');
  }
  const parserPins = (await readFile(path.join(directory, '../requirements.txt'), 'utf8'))
    .split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
  const requirements = await readFile(path.join(directory, 'requirements.lock.txt'), 'utf8');
  for (const pin of parserPins) if (!requirements.includes(pin)) fail('parser_pin_changed');
  const fontAssets = JSON.parse(await readFile(path.join(directory, 'font-assets.lock.json'), 'utf8'));
  if (fontAssets.format !== 1 || fontAssets.font_modified !== false || fontAssets.family !== lock.matplotlib_defaults.family
    || fontAssets.assets?.length !== 2 || fontAssets.assets.some((asset) => !/^[a-f0-9]{64}$/.test(asset.sha256)
      || !/^https:\/\/raw\.githubusercontent\.com\/(notofonts\/noto-cjk|google\/fonts)\/[a-f0-9]{40}\//.test(asset.url))) fail('invalid_font_asset_pin');
  const files = {};
  for (const name of sourceFiles) {
    const file = path.join(directory, name);
    const info = await lstat(file);
    if (!info.isFile() || info.nlink !== 1 || info.size > 65536) fail('untrusted_build_file');
    files[name] = sha256(await readFile(file));
  }
  const template = specification(lock);
  // SDK serialization is local. fromTemplate has no Dockerfile representation in this SDK.
  const sdk = JSON.parse(await Template.toJSON(template, true));
  const candidate = { format: 2, base: lock.template, base_kind: lock.base_kind,
    base_inventory_verified: lock.inventory_verified, platform: lock.platform, sdk_versions: lock.sdk,
    files, sdk, dockerfile: null, dockerfile_unavailable: 'provider_template_build_has_no_local_image',
    build_resources: { cpuCount: 2, memoryMB: 2048 },
    runtime_network: 'deny-all-configured-by-executor-at-create',
    remote_verified: false, envd_minimum: lock.envd.minimum_version };
  // SDK copy hashes are portable; local fileContextPath is deliberately not part of the public receipt.
  const planSha256 = sha256(JSON.stringify(candidate));
  return { candidate, plan_sha256: planSha256, template };
}

export function validateApproval(config, currentPlan, now = Date.now()) {
  const keys = ['format', 'api_key', 'alias', 'approved_plan_sha256', 'budget_reference',
    'approved_until', 'max_build_requests', 'acknowledge_no_provider_spend_cap', 'receipt_path'];
  if (Object.keys(config).some((key) => !keys.includes(key)) || config.format !== 1) fail('invalid_private_config');
  if (typeof config.api_key !== 'string' || config.api_key.length < 16 || config.api_key.length > 512) fail('private_key_required');
  if (typeof config.alias !== 'string' || !/^[a-z][a-z0-9-]{2,48}:[a-z0-9][a-z0-9.-]{0,48}$/.test(config.alias)) fail('explicit_versioned_alias_required');
  if (config.approved_plan_sha256 !== currentPlan) fail('approved_plan_changed');
  if (typeof config.budget_reference !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(config.budget_reference)
    || config.max_build_requests !== 1 || config.acknowledge_no_provider_spend_cap !== true) fail('budget_approval_required');
  const expiry = Date.parse(config.approved_until);
  if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 24 * 60 * 60 * 1000) fail('approval_expired_or_unbounded');
  if (typeof config.receipt_path !== 'string' || !path.isAbsolute(config.receipt_path)) fail('absolute_receipt_path_required');
  return config;
}

async function readPrivate(filename) {
  if (!path.isAbsolute(filename)) fail('absolute_private_config_required');
  const info = await lstat(filename);
  if (!info.isFile() || info.nlink !== 1 || info.size > 8192) fail('invalid_private_config_file');
  if (process.platform !== 'win32' && (info.mode & 0o077)) fail('private_config_permissions');
  return JSON.parse(await readFile(filename, 'utf8'));
}

export async function executeApproved(config, prepared, build = Template.buildInBackground.bind(Template)) {
  validateApproval(config, prepared.plan_sha256);
  // Exclusive receipt is written BEFORE submission. A lost response is unknown and cannot be reissued.
  const receipt = await open(config.receipt_path, 'wx', 0o600);
  const base = { format: 1, alias: config.alias, plan_sha256: prepared.plan_sha256,
    budget_reference: config.budget_reference, submitted_at: new Date().toISOString() };
  async function persist(value) {
    await receipt.truncate(0);
    await receipt.write(JSON.stringify(value, null, 2) + '\n', 0, 'utf8');
    await receipt.sync();
  }
  try {
    await persist({ ...base, state: 'submission_unknown' });
    let result;
    try {
      result = await build(prepared.template, config.alias, { ...prepared.candidate.build_resources,
        apiKey: config.api_key, domain: 'e2b.app', apiUrl: 'https://api.e2b.app',
        sandboxUrl: 'https://sandbox.e2b.app', debug: false, retries: 0,
        requestTimeoutMs: 60000, signal: AbortSignal.timeout(90000) });
    } catch {
      fail('remote_build_outcome_unknown_no_retry');
    }
    if (!result || !/^[a-zA-Z0-9_-]{1,128}$/.test(result.templateId)
      || !/^[a-zA-Z0-9_-]{1,128}$/.test(result.buildId)) fail('remote_build_outcome_unknown_no_retry');
    const accepted = { ...base, state: 'submitted_not_verified', template_id: result.templateId, build_id: result.buildId };
    await persist(accepted);
    return accepted;
  } finally {
    await receipt.close();
  }
}

export async function main(args) {
  const prepared = await plan();
  if (args.length === 0 || (args.length === 1 && ['plan', 'check'].includes(args[0]))) {
    return { ...prepared.candidate, plan_sha256: prepared.plan_sha256, api_calls: 0 };
  }
  if (args.length === 2 && args[0] === '--dockerfile') {
    if (prepared.candidate.dockerfile === null) fail('provider_template_cannot_export_dockerfile');
    const target = path.resolve(args[1]);
    await writeFile(target, prepared.candidate.dockerfile, { flag: 'wx', mode: 0o600 });
    return { dockerfile: target, plan_sha256: prepared.plan_sha256, api_calls: 0 };
  }
  if (args.length !== 3 || args[0] !== '--execute' || args[1] !== '--private-config') fail('use_plan_or_explicit_execute_private_config');
  return executeApproved(await readPrivate(args[2]), prepared);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(error.message?.startsWith('remote_') ? error.message : 'template_candidate_check_failed'); process.exitCode = 1; });
}
