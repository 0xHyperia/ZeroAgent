import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readStyleSource } from "../../../agent-ui/test-support/style-values.mjs";
import { parseTypeScriptSource, walkSyntaxTree } from "../../../../scripts/typescript-source-tools.mjs";

function readShared(path) {
  return readFileSync(new URL(`../../../agent-ui/src/${path}`, import.meta.url), "utf8");
}

const providersSectionSource = readShared("pages/settings/ProvidersSection.tsx");
const modelPickerSource = readShared("pages/settings/modelPicker.tsx");
const baseStylesSource = readStyleSource(
  new URL("../../../agent-ui/src/styles/base.css", import.meta.url),
);

const popupPortalSources = [
  ["Select", readShared("components/ui/select.tsx")],
  ["DropdownMenu", readShared("components/ui/dropdown-menu.tsx")],
  ["Popover", readShared("components/ui/popover.tsx")],
  ["Tooltip", readShared("components/ui/tooltip.tsx")],
];

const modalPortalSources = [
  ["Dialog", readShared("components/ui/dialog.tsx")],
  ["Sheet", readShared("components/ui/sheet.tsx")],
  ["AlertDialog", readShared("components/ui/alert-dialog.tsx")],
];

function layerValue(name) {
  const match = baseStylesSource.match(new RegExp(`${name}:\\s*(\\d+);`));
  assert.ok(match, `${name} should be declared`);
  return Number(match[1]);
}

function collectSourceFiles(directoryUrl) {
  const files = [];
  const pending = [fileURLToPath(directoryUrl)];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) pending.push(path);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
    }
  }
  return files;
}

test("the provider failover queue uses the shared model picker", () => {
  assert.match(providersSectionSource, /<ModelPicker[\s\S]*options=\{addableProviderOptions\}/);
  assert.match(providersSectionSource, /ariaLabel=\{t\("settings\.failoverQueueAdd"\)\}/);
  assert.match(providersSectionSource, /placeholder=\{t\("settings\.failoverQueueAdd"\)\}/);
  assert.match(providersSectionSource, /collapsibleGroups=\{false\}/);
});

test("the shared model picker delegates group and provider-only selection to shared content", () => {
  const contentSource = readFileSync(new URL("../../../agent-ui/src/components/models/ModelPickerContent.tsx", import.meta.url), "utf8");
  const optionsSource = readFileSync(new URL("../../../agent-ui/src/lib/models/modelPickerOptions.ts", import.meta.url), "utf8");
  assert.match(modelPickerSource, /collapsibleGroups = true/);
  assert.match(modelPickerSource, /collapsibleGroups=\{collapsibleGroups\}/);
  assert.match(contentSource, /props\.collapsibleGroups === false/);
  assert.match(modelPickerSource, /searchPlaceholder\?: string/);
  assert.match(modelPickerSource, /emptyLabel\?: string/);
  assert.match(optionsSource, /option\.description/);
  assert.match(providersSectionSource, /selectionKind="provider"/);
  const failoverSource = providersSectionSource.slice(providersSectionSource.indexOf("function FailoverSettingsCard"), providersSectionSource.indexOf("function CustomSettingsModelField"));
  assert.doesNotMatch(failoverSource, /baseUrl|queueEntryDetail/);
  const modelFieldSource = providersSectionSource.slice(providersSectionSource.indexOf("function CustomSettingsModelField"), providersSectionSource.indexOf("export function ProviderSettingsDialog"));
  assert.doesNotMatch(modelFieldSource, /collapsibleGroups=\{false\}/);
});

test("all shared popup primitives use the semantic popover layer", () => {
  for (const [name, source] of popupPortalSources) {
    // 允许 Portal 带属性（如 dropdown-menu 的 container={portalContainer}）。
    assert.match(source, /<\w+(?:Primitive)?\.Portal(?:\s[^>]*)?>/, `${name} should render through a Portal`);
    assert.match(source, /className="layer-popover(?: [^"]*)?"/, `${name} should use layer-popover`);
  }
});

test("all shared modal primitives use the semantic modal layer", () => {
  for (const [name, source] of modalPortalSources) {
    assert.match(source, /Portal/, `${name} should render through a Portal`);
    assert.match(source, /layer-modal fixed/, `${name} should use layer-modal`);
  }
});

test("modal and nested popup portals share a DOM-ordered interaction plane", () => {
  const popoverLayer = layerValue("--layer-popover");
  const modalLayer = layerValue("--layer-modal");
  const toastLayer = layerValue("--layer-toast");
  const criticalLayer = layerValue("--layer-critical");

  assert.equal(popoverLayer, modalLayer);
  assert.ok(toastLayer > modalLayer);
  assert.ok(criticalLayer > toastLayer);
});

test("custom React portals declare an overlay layer or an explicit layout-only desktop chrome slot", () => {
  const sourceRoots = [
    new URL("../../../agent-ui/src/", import.meta.url),
    new URL("../../src/", import.meta.url),
    new URL("../../../agent-gateway/web/src/", import.meta.url),
  ];
  const portalFiles = sourceRoots
    .flatMap(collectSourceFiles)
    .map((path) => [path, readFileSync(path, "utf8")])
    .filter(([, source]) => source.includes("createPortal("));

  assert.ok(portalFiles.length > 0);
  for (const [path, source] of portalFiles) {
    const portalCalls = [];
    walkSyntaxTree(parseTypeScriptSource(source, path), (node) => {
      if (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "createPortal") portalCalls.push(node);
    });
    for (const [index, call] of portalCalls.entries()) {
      const content = call.arguments[0];
      const attributes = content?.type === "JSXElement" ? content.openingElement.attributes : [];
      const attribute = (name) => attributes.find((entry) => entry.type === "JSXAttribute" && entry.name?.name === name);
      const chrome = attribute("data-desktop-remote-chrome-slot");
      const targetSource = source.slice(call.arguments[1]?.start, call.arguments[1]?.end);
      if (
        content?.type === "Identifier" &&
        content.name === "surface" &&
        targetSource === "target" &&
        call.arguments[2]?.name === "slot" &&
        source.includes("export function mountWorkbenchLayout(")
      ) {
        assert.match(source, /slot: "account-content" \| "account-sidebar" \| "task-result"/);
        assert.doesNotMatch(source, /document\.body|aria-modal|layer-(?:popover|modal|toast|critical)/);
        continue;
      }
      if (content?.type === "Identifier" && content.name === "children" && targetSource === "target" && source.includes('data-navigation-rail-placeholder=""')) {
        assert.match(source, /target\?: HTMLElement \| null/);
        assert.doesNotMatch(source, /aria-modal|role="(?:dialog|alertdialog)"|\blayer-(?:popover|modal|toast|critical)\b|className="[^"]*\b(?:fixed|absolute)\b/);
        continue;
      }
      if (content?.type === "Identifier" && content.name === "children" && targetSource === "mount" && source.includes("useContext(ConversationFocusComposer)")) {
        // The composer keeps one mount and moves it inside the existing image overlay.
        assert.match(source, /element\.style\.display = "contents"/);
        assert.match(source, /next\.append\(mount\)/);
        assert.doesNotMatch(source, /aria-modal|role="(?:dialog|alertdialog)"|className="[^"]*\b(?:fixed|absolute)\b/);
        continue;
      }
      if (content?.type === "Identifier" && content.name === "children" && targetSource === "contentHost" && source.includes("export function WorkspaceToolsPanel(")) {
        assert.match(source, /const mount = mobile && open && mobileMount \? mobileMount : desktopMount\.current/);
        assert.match(source, /mount\.append\(contentHost\)/);
        assert.match(source, /<SheetContent[\s\S]*ref=\{setMobileMount\}/);
        assert.doesNotMatch(source, /document\.body/);
        continue;
      }
      if (content?.type === "Identifier" && content.name === "focus" && targetSource === "document.body" &&
          source.includes('className="za-conversation-image-focus"')) {
        const styles = readShared("components/resource-preview/conversation-image-preview.css");
        assert.match(styles, /\.za-conversation-image-focus\s*\{[^}]*z-index:\s*calc\(var\(--layer-modal\) - 1\)/);
        continue;
      }
      if (content?.type === "Identifier" && content.name === "controls" && targetSource === "captionMount" &&
          source.includes("getImagePreviewWindowChrome")) {
        assert.match(source, /mount\.style\.display = "contents"/);
        assert.match(source, /const target = slot \?\? home\.current;[\s\S]*target\.append\(captionMount\)/);
        continue;
      }
      if (source.includes("useContext(PreviewToolbarMount)") && ["target", "mount.leadingTarget", "mount.pageTarget"].includes(targetSource)) {
        // The shared reader explicitly provides in-layout toolbar mount nodes.
        // These portals move controls into that toolbar, without creating overlays.
        assert.match(readShared("components/resource-preview/PreviewChrome.tsx"), /export const PreviewToolbarMount = createContext/);
        assert.doesNotMatch(source, /aria-modal|role="(?:dialog|alertdialog)"|className="[^"]*\b(?:fixed|absolute)\b/);
        continue;
      }
      if (targetSource === "props.tabbedToolbarTarget" && source.includes("<PreviewToolbarMount.Provider value={toolbarMount}>")) {
        assert.match(source, /tabbedToolbarTarget\?: HTMLElement \| null/);
        assert.equal(source.slice(content.start, content.end), "props.headerActions");
        continue;
      }
      if (attribute("data-workspace-editor-toolbar-slot") && targetSource === "embeddedToolbarTarget") {
        assert.match(source, /embeddedToolbarTarget\?: HTMLElement \| null/);
        assert.equal(attribute("className")?.value?.value, "contents");
        assert.doesNotMatch(source.slice(content.start, content.end), /aria-modal|\b(?:fixed|absolute)\b|layer-(?:popover|modal|toast|critical)/);
        continue;
      }
      if (content?.type === "Identifier" && content.name === "review" && targetSource === "selectionEdit.inlineHost" && source.includes("useWorkspaceMarkdownSelectionEdit(")) {
        const host = readShared("components/workspace-editor/useWorkspaceMarkdownSelectionEdit.ts");
        assert.match(host, /host\.className = "za-markdown-review-widget"/);
        assert.match(host, /Decoration\.widget\(\{ widget, block: true, side: 1 \}\)/);
        const review = readShared("components/workspace-editor/WorkspaceMarkdownSelectionReview.tsx");
        assert.doesNotMatch(review, /document\.body|aria-modal|role="(?:dialog|alertdialog)"|className="[^"]*\b(?:fixed|absolute)\b/);
        continue;
      }
      if (chrome) {
        assert.ok(["device", "window", "update"].includes(chrome.value?.value), `${path} chrome slot must declare device/window/update ownership`);
        assert.equal(attribute("className")?.value?.value, "contents", `${path} chrome slots participate in layout without creating an overlay plane`);
        const contentSource = source.slice(content.start, content.end);
        assert.doesNotMatch(contentSource, /\brole\s*=\s*["'](?:dialog|alertdialog)["']|aria-modal|\blayer-(?:popover|modal|toast|critical)\b|\b(?:fixed|absolute)\b/, `${path} chrome layout portals cannot also become dialog/overlay surfaces`);
        continue;
      }
      // Preserve the existing semantic-layer requirement for every ordinary
      // portal; classification depends on the actual JSX contract, not a path.
      const portalCall = source.slice(call.start + "createPortal(".length);
      assert.match(
        portalCall,
        /layer-(?:popover|modal|toast|critical)/,
        `${path} createPortal call ${index + 1} should use a semantic overlay layer`,
      );
    }
  }
});
