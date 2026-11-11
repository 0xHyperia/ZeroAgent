import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { executeApproved, main, plan, readLock, specification, validateApproval } from './build.mjs';

test('real pinned SDK logger response mismatch is avoided without network by omitting the optional logger', async () => {
  const localRequire = createRequire(import.meta.url);
  const sdkPath = localRequire.resolve('e2b');
  const sdkRequire = createRequire(sdkPath);
  const sdkSource = await readFile(sdkPath, 'utf8');
  const factory = sdkSource.match(/function createApiLogger\(logger\) \{[\s\S]*?\n\}/)?.[0];
  assert(factory, 'pinned SDK logger source changed; review the compatibility fixture');
  const makeLogger = new Function(`return (${factory});`)();
  const createClient = sdkRequire('openapi-fetch').default;
  const OtherResponse = sdkRequire('undici').Response;
  assert.notEqual(OtherResponse, globalThis.Response);
  let networkCalls = 0;
  const fixture = (logger) => {
    const client = createClient({ baseUrl: 'https://synthetic.invalid', fetch: async () => { networkCalls++; return new OtherResponse('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }); } });
    if (logger) client.use(makeLogger(logger));
    return client;
  };
  await assert.rejects(fixture({ info() {}, error() {} }).GET('/v2/templates'), /onResponse: must return new Response/);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zeroagent-template-test-'));
  try {
    const prepared = await plan();
    await executeApproved(approval(prepared, path.join(directory, 'receipt.json')), prepared, async (_template, _alias, options) => {
      assert.equal(options.logger, undefined);
      assert.deepEqual((await fixture(options.logger).GET('/v2/templates')).data, []);
      return { templateId: 'synthetic_template', buildId: 'synthetic_build' };
    });
    assert.equal(networkCalls, 2); // Two in-memory fetch callbacks; no socket API is used.
  } finally { await cleanupTemporary(directory); }
});

function approval(prepared, receipt) {
  return { format: 1, api_key: 'synthetic-template-key-never-real', alias: 'zeroagent-test:20261029',
    approved_plan_sha256: prepared.plan_sha256, budget_reference: 'local_fixture_only',
    approved_until: new Date(Date.now() + 600000).toISOString(), max_build_requests: 1,
    acknowledge_no_provider_spend_cap: true, receipt_path: receipt };
}

async function cleanupTemporary(directory) {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.match(path.basename(directory), /^zeroagent-template-test-/);
  await rm(directory, { recursive: true, force: true });
}

test('default/check use installed SDK serialization without API or ambient credentials', async () => {
  const previous = globalThis.fetch;
  const key = process.env.E2B_API_KEY;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('network forbidden in offline check'); };
  process.env.E2B_API_KEY = 'ambient-secret-must-never-appear';
  try {
    const empty = await main([]);
    const checked = await main(['check']);
    assert.equal(empty.plan_sha256, checked.plan_sha256);
    assert.equal(calls, 0);
    assert.equal(checked.api_calls, 0);
    assert.equal(JSON.stringify(checked).includes(process.env.E2B_API_KEY), false);
    assert.equal(checked.base, 'nlhz8vlwyupq845jsdg9:696af675-2a44-45ce-a889-7e09c65eb749');
    assert.equal(checked.sdk.fromTemplate, checked.base);
    assert.equal(checked.base_inventory_verified, true);
    assert.equal(checked.sdk.startCmd, undefined);
    assert.equal(checked.sdk.readyCmd, undefined);
    assert.equal(checked.dockerfile, null);
    const steps = checked.sdk.steps;
    const commands = steps.filter((step) => step.type === 'RUN').map((step) => step.args[0]);
    assert.match(commands[0], /check_environment.py --base-only$/);
    assert.match(commands[1], /--require-hashes --no-deps/);
    assert.deepEqual(steps.at(-3).args, ['user']);
    assert.match(steps.at(-2).args[0], /test_file_tool\.py$/);
    assert.deepEqual(steps.at(-1).args, ['/home/user']);
    assert.ok(commands.includes('python3 -IB /opt/zeroagent-template/configure_fonts.py'));
    assert.ok(checked.files.matplotlibrc);
    assert.ok(checked.files['configure_fonts.py']);
    assert.ok(checked.files['font-assets.lock.json']);
    assert.ok(commands.includes('python3 -IB /opt/zeroagent-template/install_fonts.py'));
    await assert.rejects(main(['--dockerfile', 'unused-output']), /provider_template_cannot_export_dockerfile/);
    assert.equal(checked.remote_verified, false);
  } finally {
    globalThis.fetch = previous;
    if (key === undefined) delete process.env.E2B_API_KEY;
    else process.env.E2B_API_KEY = key;
  }
});

test('mutable aliases cannot become the base and startup remains inherited from the verified immutable build', async () => {
  const lock = await readLock();
  for (const template of ['code-interpreter-v1', 'nlhz8vlwyupq845jsdg9:latest', lock.template_id,
    `${lock.template_id}:696af675-2a44-45ce-a889-7e09c65eb740`]) {
    assert.throws(() => specification({ ...lock, template }), /immutable_template_build_required/);
  }
  assert.throws(() => specification({ ...lock, image: 'e2bdev/code-interpreter:latest' }), /immutable_template_build_required/);
  assert.equal(lock.inventory_verified, true);
  assert.equal(lock.python, '3.13.16');
  assert.equal(Object.keys(lock.startup_files).length, 3);
  assert.throws(() => specification({ ...lock, start_command: 'replacement' }), /base_startup_inheritance_required/);
  assert.throws(() => specification({ ...lock, startup_contract: 'custom' }), /base_startup_inheritance_required/);
  assert.equal(lock.envd.live_acceptance_required, true);
  assert.equal(lock.envd.public_base_metadata_version, '0.10.0');
});

test('remote approval requires exact plan, explicit bounded budget marker, new receipt and recent expiry', async () => {
  const prepared = await plan();
  const config = approval(prepared, path.resolve('test-receipt-unused.json'));
  for (const patch of [
    { approved_plan_sha256: '0'.repeat(64) }, { max_build_requests: 2 }, { budget_reference: '' },
    { acknowledge_no_provider_spend_cap: false }, { api_key: '' }, { alias: 'latest' },
    { receipt_path: 'relative.json' }, { approved_until: '2020-01-01' },
    { approved_until: new Date(Date.now() + 48 * 3600000).toISOString() }, { extra: 'forbidden' },
  ]) assert.throws(() => validateApproval({ ...config, ...patch }, prepared.plan_sha256));
  assert.equal(validateApproval(config, prepared.plan_sha256), config);
  await assert.rejects(main(['--execute']), /use_plan_or_explicit_execute/);
});

test('approved submission is one SDK build request with fixed official endpoint, no retries, no key in receipt', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zeroagent-template-test-'));
  try {
    const prepared = await plan();
    const config = approval(prepared, path.join(directory, 'receipt.json'));
    let count = 0;
    const fake = async (_template, alias, options) => {
      count++;
      assert.equal(alias, config.alias);
      assert.equal(options.apiKey, config.api_key);
      assert.equal(options.apiUrl, 'https://api.e2b.app');
      assert.equal(options.domain, 'e2b.app');
      assert.equal(options.retries, 0);
      assert.equal(options.cpuCount, 2);
      assert.equal(options.memoryMB, 2048);
      assert.equal(options.debug, false);
      assert.equal(options.logger, undefined);
      const before = JSON.parse(await readFile(config.receipt_path, 'utf8'));
      assert.equal(before.state, 'submission_unknown');
      return { templateId: 'synthetic_template', buildId: 'synthetic_build' };
    };
    const result = await executeApproved(config, prepared, fake);
    assert.equal(result.state, 'submitted_not_verified');
    await assert.rejects(executeApproved(config, prepared, fake), { code: 'EEXIST' });
    assert.equal(count, 1);
    assert.equal((await readFile(config.receipt_path, 'utf8')).includes(config.api_key), false);
  } finally { await cleanupTemporary(directory); }
});

test('lost submission reply retains unknown receipt and never exposes SDK error or reissues build', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zeroagent-template-test-'));
  try {
    const prepared = await plan();
    const config = approval(prepared, path.join(directory, 'receipt.json'));
    let count = 0;
    const fake = async () => { count++; throw new Error(`https://secret.invalid/${config.api_key}`); };
    await assert.rejects(executeApproved(config, prepared, fake), { message: 'remote_build_outcome_unknown_no_retry' });
    const receipt = await readFile(config.receipt_path, 'utf8');
    assert.equal(JSON.parse(receipt).state, 'submission_unknown');
    assert.equal(receipt.includes(config.api_key), false);
    await assert.rejects(executeApproved(config, prepared, fake), { code: 'EEXIST' });
    assert.equal(count, 1);
  } finally { await cleanupTemporary(directory); }
});
