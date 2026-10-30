#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { matchesGlob, resolve } from "node:path";
import { validateUpstreamRelease } from "./upstream-release.mjs";

const root = resolve(import.meta.dirname, "..");
const failures = [];

function read(path) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) {
    failures.push(`${path}：缺少必需文件`);
    return "";
  }
  return readFileSync(absolute, "utf8");
}

function parseJsonYaml(path) {
  const source = read(path);
  if (!source) return {};
  try {
    return JSON.parse(source);
  } catch (error) {
    failures.push(`${path}：必须保持为兼容 JSON 的 YAML（${error.message}）`);
    return {};
  }
}

function requireMatch(path, pattern, message) {
  const source = read(path);
  if (source && !pattern.test(source)) failures.push(`${path}: ${message}`);
}

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    failures.push(`git ${args.join(" ")}：${result.stderr.trim() || "执行失败"}`);
    return "";
  }
  return result.stdout;
}

for (const path of [
  "AGENTS.md",
  "docs/product/PRODUCT_CONTRACT.md",
  "docs/upstream/template.md",
  ".github/upstream-sync.json",
  ".github/upstream-ownership.yaml",
]) {
  read(path);
}

const catalog = parseJsonYaml("docs/product/features.yaml");
const requiredFeatures = new Set([
  "usa-zero-oauth",
  "managed-provider-keys",
  "cloud-web-chat",
  "device-agent",
  "device-session-management",
  "desktop-local-tools",
  "workspace-history-sync",
  "android-client",
  "gateway-isolation-readiness",
  "dual-repository-release",
  "gateway-image-deployment",
]);
const seenFeatures = new Set();
const allowedFeatureOwners = new Set(["zeroagent", "shared", "upstream"]);
const allowedFeatureStatuses = new Set(["active", "deprecated", "removed"]);
const allowedUpstreamRelations = new Set([
  "adopt",
  "adapt",
  "replace",
  "partial",
  "reject",
  "defer",
]);
const allowedSurfaces = new Set([
  "desktop",
  "webui",
  "android",
  "gateway",
  "release",
  "operations",
]);
for (const feature of catalog.features ?? []) {
  if (!feature?.id || seenFeatures.has(feature.id)) {
    failures.push(`docs/product/features.yaml：功能 ID 缺失或重复：${feature?.id ?? ""}`);
    continue;
  }
  seenFeatures.add(feature.id);
  for (const field of [
    "name",
    "owner",
    "status",
    "surfaces",
    "entrypoints",
    "tests",
    "security",
    "upstream_relation",
  ]) {
    if (feature[field] == null || feature[field].length === 0) {
      failures.push(`docs/product/features.yaml：${feature.id} 缺少 ${field}`);
    }
  }
  for (const path of [...(feature.entrypoints ?? []), ...(feature.tests ?? [])]) {
    if (!existsSync(resolve(root, path))) {
      failures.push(`docs/product/features.yaml：${feature.id} 引用了不存在的路径 ${path}`);
    }
  }
  if (!allowedFeatureOwners.has(feature.owner)) {
    failures.push(`docs/product/features.yaml：${feature.id} 的 owner 无效：${feature.owner}`);
  }
  if (!allowedFeatureStatuses.has(feature.status)) {
    failures.push(`docs/product/features.yaml：${feature.id} 的 status 无效：${feature.status}`);
  }
  if (!allowedUpstreamRelations.has(feature.upstream_relation)) {
    failures.push(
      `docs/product/features.yaml：${feature.id} 的 upstream_relation 无效：${feature.upstream_relation}`,
    );
  }
  for (const surface of feature.surfaces ?? []) {
    if (!allowedSurfaces.has(surface)) {
      failures.push(`docs/product/features.yaml：${feature.id} 的 surface 无效：${surface}`);
    }
  }
  for (const path of feature.tests ?? []) {
    const absolute = resolve(root, path);
    if (existsSync(absolute) && !statSync(absolute).isFile()) {
      failures.push(`docs/product/features.yaml：${feature.id} 的测试必须指向具体文件：${path}`);
    }
  }
}
for (const id of requiredFeatures) {
  if (!seenFeatures.has(id)) failures.push(`docs/product/features.yaml：缺少必需功能 ${id}`);
}

const ownership = parseJsonYaml(".github/upstream-ownership.yaml");
const allowedOwnership = new Set(["zeroagent_owned", "adapted", "upstream_owned"]);
const allowedRisk = new Set(["critical", "high", "medium", "low"]);
const trackedFiles = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
  .split("\0")
  .filter((path) => path && existsSync(resolve(root, path)));
const upstreamSync = parseJsonYaml(".github/upstream-sync.json");
const syncedUpstreamPaths = /^[0-9a-f]{40}$/.test(upstreamSync.base_commit ?? "") &&
  /^[0-9a-f]{40}$/.test(upstreamSync.commit ?? "")
  ? git(["diff", "--name-only", upstreamSync.base_commit, upstreamSync.commit]).split("\n").filter(Boolean)
  : [];
// An owned upstream path may have been deliberately deleted. Such rules remain meaningful when
// supported by the pinned sync range or an actual staged deletion during integration.
const ownershipEvidencePaths = [...trackedFiles, ...syncedUpstreamPaths,
  ...git(["diff", "--cached", "--name-only", "--diff-filter=D"]).split("\n").filter(Boolean)];
const seenGlobs = new Set();
for (const rule of ownership.rules ?? []) {
  if (
    !rule.glob ||
    !allowedOwnership.has(rule.ownership) ||
    !allowedRisk.has(rule.risk) ||
    !Array.isArray(rule.checks) ||
    rule.checks.length === 0
  ) {
    failures.push(`.github/upstream-ownership.yaml：无效的所有权规则 ${JSON.stringify(rule)}`);
    continue;
  }
  if (seenGlobs.has(rule.glob)) {
    failures.push(`.github/upstream-ownership.yaml：重复 Glob ${rule.glob}`);
  }
  seenGlobs.add(rule.glob);
  if (!ownershipEvidencePaths.some((path) => matchesGlob(path, rule.glob))) {
    failures.push(`.github/upstream-ownership.yaml：Glob 没有命中任何受版本控制文件：${rule.glob}`);
  }
}
for (const required of allowedOwnership) {
  if (!(ownership.rules ?? []).some((rule) => rule.ownership === required)) {
    failures.push(`.github/upstream-ownership.yaml：缺少 ${required} 规则`);
  }
}

for (const field of ["base_commit", "commit"]) {
  if (!/^[0-9a-f]{40}$/.test(upstreamSync[field] ?? "")) {
    failures.push(`.github/upstream-sync.json：${field} 必须是完整的 40 位 Commit SHA`);
  }
}
for (const error of validateUpstreamRelease(upstreamSync)) {
  failures.push(`.github/upstream-sync.json：${error}`);
}
if (/^[0-9a-f]{40}$/.test(upstreamSync.commit ?? "")) {
  git(["merge-base", "--is-ancestor", upstreamSync.commit, "HEAD"]);
}
if (
  /^[0-9a-f]{40}$/.test(upstreamSync.base_commit ?? "") &&
  /^[0-9a-f]{40}$/.test(upstreamSync.commit ?? "")
) {
  const changedFiles = git([
    "diff",
    "--name-only",
    upstreamSync.base_commit,
    upstreamSync.commit,
  ])
    .split("\n")
    .filter(Boolean);
  for (const path of changedFiles) {
    if (!(ownership.rules ?? []).some((rule) => rule.glob && matchesGlob(path, rule.glob))) {
      failures.push(`.github/upstream-ownership.yaml：上游变更路径没有所有权规则：${path}`);
    }
  }
}

requireMatch("crates/agent-gui/package.json", /"name"\s*:\s*"zeroagent"/, "Desktop Package 必须命名为 zeroagent");
requireMatch("crates/agent-gui/src-tauri/tauri.conf.json", /"productName"\s*:\s*"ZeroAgent"/, "Tauri productName 必须为 ZeroAgent");
requireMatch("crates/agent-gui/src-tauri/tauri.conf.json", /"identifier"\s*:\s*"top\.usa0\.zeroagent"/, "Tauri identifier 已变化");
requireMatch("crates/agent-gui/browser-extension/manifest.json", /"name"\s*:\s*"ZeroAgent Browser Bridge"/, "随应用分发的浏览器扩展必须显示 ZeroAgent 品牌");
requireMatch(".github/workflows/desktop-release.yml", /RELEASE_REPOSITORY:\s*USA-Zero\/ZeroAgent/, "Desktop 公开发布目标已变化");
requireMatch(".github/workflows/android-release.yml", /RELEASE_REPOSITORY:\s*USA-Zero\/ZeroAgent/, "Android 公开发布目标已变化");
requireMatch(".github/workflows/android-release.yml", /ZeroAgent-.*Android-arm64/, "Android 产物命名已变化");
requireMatch("deploy/production/smoke.sh", /https:\/\/agent\.usa0\.top/, "生产环境访问地址已变化");
requireMatch(".github/workflows/update-model-catalog.yml", /generate-model-catalog\.mjs/, "模型目录刷新流程不可执行");

if (existsSync(resolve(root, ".github/workflows/update-star-history.yml"))) {
    failures.push(".github/workflows/update-star-history.yml：禁止恢复 Star History 自动化");
}

const legacyToolPattern = /HttpGetTest|http_get_test|selectedSystemTools|customSystemTools/;
for (const path of trackedFiles.filter(
  (path) =>
    (path.startsWith("crates/agent-gui/src/") ||
      path.startsWith("crates/agent-gui/src-tauri/src/") ||
      path.startsWith("crates/agent-gateway/internal/") ||
      path.startsWith("crates/agent-gateway/web/src/") ||
      path.startsWith("crates/agent-ui/src/")) &&
    !path.includes("/test/"),
)) {
  if (legacyToolPattern.test(read(path))) {
    failures.push(`${path}：禁止恢复已拒绝的 HttpGetTest 或旧自定义系统工具链`);
  }
}
if (legacyToolPattern.test(read("docs/features/tools.md"))) {
  failures.push("docs/features/tools.md：禁止将已拒绝的旧自定义系统工具描述为受支持功能");
}

for (const path of ["Makefile", ".github/workflows/ci.yml", ".github/workflows/desktop-release.yml"]) {
  if (/--filter\s+liveagent\.\.\./.test(read(path))) {
    failures.push(`${path}：liveagent 包过滤器会跳过 ZeroAgent Desktop Package`);
  }
}

for (const path of [
  "crates/agent-gui/src/agent-ui-adapters/settingsExtension.tsx",
  "crates/agent-gateway/web/src/agent-ui-adapters/settingsExtension.tsx",
]) {
  requireMatch(path, /RelayProvidersSection/, "无法访问 USA-Zero 托管 Provider 设置");
  requireMatch(path, /renderProviders/, "共享设置未接收托管 Provider Renderer");
}
requireMatch("crates/agent-ui/src/pages/settings/SettingsPage.tsx", /extension\.renderProviders/, "Provider 导航绕过了受保护的端适配器");
requireMatch("crates/agent-ui/src/pages/settings/SettingsPage.tsx", /runtimeKind[\s\S]{0,100}web_chat/, "忽略了 Cloud Chat Runtime 能力");
requireMatch("crates/agent-ui/src/pages/settings/SystemSettingsForm.tsx", /showLocalRuntimeSettings/, "仅本地可用的设置没有能力 Gate");
requireMatch("crates/agent-ui/src/pages/settings/providerUtils.ts", /ZeroAgent\/1\.0/, "Provider 预设仍暴露上游 User-Agent");
requireMatch("crates/agent-gui/src-tauri/src/services/provider_usage.rs", /ZeroAgent\/1\.0/, "Rust Provider 预设仍暴露上游 User-Agent");
requireMatch("crates/agent-gui/src-tauri/src/commands/integration/mcp.rs", /"name": "ZeroAgent"/, "MCP 客户端身份不是 ZeroAgent");
requireMatch("crates/agent-gui/src-tauri/src/services/skills/builtin.rs", /name: "zeroagent-code-review"/, "内置 Code Review Skill 未使用 ZeroAgent 身份");
requireMatch("crates/agent-gui/src-tauri/src/services/kbrain_backend.rs", /skills::ensure_backend_builtin_agent_skills\(&backend_dir\)/, "内置 Code Review Skill 未接入当前后端目录");
requireMatch("crates/agent-gui/src-tauri/src/commands/config/settings/skills_http_tests.rs", /canonical_code_review_skill_runtime_through_hub_and_agent/, "Code Review Skill 缺少实际 Hub/后端调用回归");
for (const path of [
  "crates/agent-gui/src/agent-ui-adapters/assistantAvatar.ts",
  "crates/agent-gateway/web/src/agent-ui-adapters/assistantAvatar.ts",
]) {
  requireMatch(path, /\/zeroagent-logo\.png/, "对话助手头像未使用 ZeroAgent Logo");
  if (/icon-simple\.png|iconSimpleUrl/.test(read(path))) {
    failures.push(`${path}：对话助手头像仍引用上游 Logo`);
  }
}
requireMatch(
  "crates/agent-gui/src/agent-ui-adapters/sidebarChrome.tsx",
  /<BrandMark[\s\S]*>ZeroAgent</,
  "Desktop 对话侧栏未使用 ZeroAgent 品牌",
);
requireMatch(
  "crates/agent-ui/src/application/BrandMark.tsx",
  /ZEROAGENT_BRAND_MARK\s*=\s*"\/zeroagent-logo\.png"/,
  "共享品牌标记未引用随应用打包的 ZeroAgent Logo",
);
for (const packagePath of ["crates/agent-gui", "crates/agent-gateway/web"]) {
  const path = `${packagePath}/public/zeroagent-logo.png`;
  if (!existsSync(resolve(root, path))) failures.push(`${path}：共享品牌资源未随宿主打包`);
}

for (const path of [
  "crates/agent-gateway/web/src/i18n/config.ts",
  ".github/CONTRIBUTING.md",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
]) {
  const source = read(path);
  if (/Stack-Cairn\/LiveAgent|update LiveAgent|更新 LiveAgent/.test(source)) {
    failures.push(`${path}：ZeroAgent 自有用户文案泄露了上游产品身份`);
  }
}

for (const path of trackedFiles.filter(
  (path) =>
    (path.startsWith("crates/agent-gui/src/") ||
      path.startsWith("crates/agent-gateway/web/src/") ||
      path.startsWith("crates/agent-ui/src/") ||
      path === "crates/agent-gateway/proto/v2/gateway.proto") &&
    /\.(?:ts|tsx|proto)$/.test(path),
)) {
  if (/LiveAgent|Live Agent/.test(read(path))) {
    failures.push(`${path}：运行时源码仍包含上游产品身份 LiveAgent`);
  }
}

for (const path of trackedFiles.filter((path) =>
  path.startsWith("crates/agent-gui/src-tauri/prompt/") && path.endsWith(".md")
)) {
  if (/LiveAgent/.test(read(path))) {
    failures.push(`${path}：内置运行时 Prompt 仍包含上游产品身份 LiveAgent`);
  }
}

for (const path of [
  "crates/agent-gui/src-tauri/src/services/provider_usage.rs",
  "crates/agent-gui/src-tauri/src/commands/integration/mcp.rs",
  "crates/agent-gui/src-tauri/src/runtime/shell_runner.rs",
  "crates/agent-gui/src-tauri/src/services/memory/maintenance.rs",
  "crates/agent-gui/src-tauri/src/commands/config/settings/ccs_import.rs",
  "crates/agent-gui/src-tauri/src/commands/config/settings/cherry_import.rs",
  "crates/agent-gui/src-tauri/src/services/skills/builtin.rs",
]) {
  if (/LiveAgent/.test(read(path))) {
    failures.push(`${path}：用户或外部系统可见的运行时文案仍包含 LiveAgent`);
  }
}
if (/non-LiveAgent/.test(read("crates/agent-gui/src-tauri/src/commands/workspace/subagent_worktree.rs"))) {
  failures.push("subagent_worktree.rs：工作树错误文案仍包含 LiveAgent");
}

// Native account migrations must not reopen raw credentials through the old device IPC.
for (const path of [
  "crates/agent-gui/src-tauri/src/services/account_session.rs",
  "crates/agent-gui/src-tauri/src/services/account_session/api.rs",
  "crates/agent-gui/src-tauri/src/services/account_session/gateway.rs",
  "crates/agent-gui/src/lib/relay/nativeSession.ts",
  "crates/agent-gui/src/lib/relay/nativeGatewaySocket.ts",
]) {
  if (!read(path).trim()) failures.push(path + "：原生账号边界入口缺失");
}
if (/services::device_credentials::device_credential_(?:get|set|activate|delete)/.test(read("crates/agent-gui/src-tauri/src/lib.rs"))) {
  failures.push("lib.rs：不能重新注册向渲染层读写原始设备凭据的旧命令");
}
requireMatch("crates/agent-gui/src-tauri/src/lib.rs", /KBrainBackendState::with_account_sessions/, "配置守卫必须关联当前 Native 账号状态");
requireMatch("crates/agent-gui/src-tauri/src/services/kbrain_backend.rs", /NativeSessionCredential[\s\S]*session_handle: String/, "Native profile 必须使用不透明会话句柄");
requireMatch("crates/agent-gui/src-tauri/src/services/kbrain_backend.rs", /connection: state\.viewer_connection\(&connection\)\?/, "profile IPC 必须只公开 Native 代理连接");
requireMatch("crates/agent-gui/src-tauri/src/services/kbrain_backend.rs", /pub async fn kbrain_backend_connection[\s\S]*Result<PublicBackendConnection, String>/, "连接 IPC 不能返回可序列化的私有后端连接");
requireMatch("crates/agent-gui/src-tauri/src/services/backend_facade.rs", /profile_live[\s\S]*invalidated/, "Native 传输必须绑定 profile 并取消旧请求");
requireMatch("crates/agent-gui/src-tauri/src/services/account_session/api.rs", /deny_unknown_fields/, "账号请求不得静默接收旧原始凭据字段");
requireMatch("crates/agent-gui/src-tauri/src/services/proxy.rs", /is_account_resource[\s\S]*resource_redirect_policy/, "通用资源代理必须保留账号来源与重定向边界");

if (failures.length > 0) {
  for (const failure of failures) console.error(`错误：${failure}`);
  console.error(`ZeroAgent 产品契约检查失败，共 ${failures.length} 个错误。`);
  process.exit(1);
}

console.log(
  `ZeroAgent 产品契约检查通过（${seenFeatures.size} 项功能，${(ownership.rules ?? []).length} 条所有权规则）。`,
);
