import "@liveagent/app/index.css";
import "./fixture.css";
import { t } from "@liveagent/app/i18n/config";
import { ApplicationRail } from "@liveagent/ui/application/ApplicationRail";
import {
  ComposerModelControls,
  type ComposerModelControlsProps,
} from "@liveagent/ui/components/chat/ComposerModelControls";
import { ConversationStarter } from "@liveagent/ui/components/chat/ConversationStarter";
import { BookOpen, FileText, LoaderCircle, MessageSquare } from "@liveagent/ui/components/IconSet";
import { ResourceSelectionCard } from "@liveagent/ui/components/resources/ResourceSelectionCard";
import { AccountAvatar, AccountIdentity } from "@liveagent/ui/components/ui/account-identity";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@liveagent/ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { Input } from "@liveagent/ui/components/ui/input";
import { SegmentedControl } from "@liveagent/ui/components/ui/segmented-control";
import { StatusNotice } from "@liveagent/ui/components/ui/status-notice";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { Textarea } from "@liveagent/ui/components/ui/textarea";
import { TooltipProvider } from "@liveagent/ui/components/ui/tooltip";
import { TooltipButton } from "@liveagent/ui/components/ui/tooltip-button";
import { ZoneFontScaleContext } from "@liveagent/ui/components/ui/zone-font-scale";
import { LocaleContext } from "@liveagent/ui/i18n/LocaleContext";
import { DEFAULT_CHAT_RUNTIME_CONTROLS } from "@liveagent/ui/lib/settings/types";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

// Isolated display data. No account, Gateway, Tauri, upload or model client is mounted.
const models: ComposerModelControlsProps["modelOptions"] = [
  {
    providerId: "sample",
    providerName: "示例分组",
    providerType: "codex",
    model: "sample-reasoning",
    label: "示例模型",
    value: "sample::sample-reasoning",
    nativeWebSearchSupported: true,
  },
  {
    providerId: "sample-two",
    providerName: "第二分组",
    providerType: "gemini",
    model: "sample-long-model",
    label: "用于验证长名称和分组定位的第二个示例模型",
    value: "sample-two::sample-long-model",
    nativeWebSearchSupported: false,
  },
];

function App() {
  const [dark, setDark] = useState(false);
  const [surface, setSurface] = useState<"desktop" | "web">("desktop");
  const [scale, setScale] = useState("1");
  const [mode, setMode] = useState("chat");
  const [resource, setResource] = useState(false);
  const [switchOn, setSwitchOn] = useState(false);
  const [draft, setDraft] = useState("");
  const [receipt, setReceipt] = useState("尚未执行样例动作");
  const [selectedModel, setSelectedModel] = useState(models[0]);
  const [executionMode, setExecutionMode] = useState<"text" | "tools">("tools");
  const [runtime, setRuntime] = useState({ ...DEFAULT_CHAT_RUNTIME_CONTROLS });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    if (surface === "web") document.documentElement.dataset.liveagentWebui = "gateway";
    else delete document.documentElement.dataset.liveagentWebui;
  }, [dark, surface]);

  return (
    <LocaleContext.Provider value={{ locale: "zh-CN", t: (key) => t(key, "zh-CN") }}>
      <ZoneFontScaleContext.Provider value={Number(scale)}>
        <TooltipProvider>
          <main
            className="fixture-shell zone-font-scale"
            style={{ "--zone-font-scale": scale } as React.CSSProperties}
          >
            <header>
              <h1>共享组件验收</h1>
              <p>真实共享组件 · 本地样例数据 · 无账户、模型或文件操作</p>
              <div className="fixture-row">
                <Button variant="outline" aria-pressed={dark} onClick={() => setDark(!dark)}>
                  深色主题
                </Button>
                <SegmentedControl
                  label="宿主样式"
                  value={surface}
                  options={[
                    { value: "desktop", label: "桌面" },
                    { value: "web", label: "Web / 移动" },
                  ]}
                  onChange={setSurface}
                />
                <label className="fixture-row">
                  字号
                  <select
                    aria-label="字号比例"
                    value={scale}
                    onChange={(event) => setScale(event.target.value)}
                  >
                    <option value="1">100%</option>
                    <option value="1.25">125%</option>
                    <option value="1.5">150%</option>
                  </select>
                </label>
              </div>
            </header>

            <section aria-labelledby="controls-heading">
              <h2 id="controls-heading">操作与焦点</h2>
              <p>使用 Tab 检查焦点，鼠标检查悬停和按下；禁用动作不应产生回执。</p>
              <div className="fixture-row">
                <Button onClick={() => setReceipt("主要操作已触发")}>主要操作</Button>
                <Button variant="outline" onClick={() => setReceipt("次要操作已触发")}>
                  次要操作
                </Button>
                <Button variant="ghost" onClick={() => setReceipt("轻量操作已触发")}>
                  轻量操作
                </Button>
                <Button disabled onClick={() => setReceipt("错误：禁用动作被触发")}>
                  不可用
                </Button>
                <Button disabled aria-busy="true">
                  <LoaderCircle className="app-status-busy size-4" />
                  处理中
                </Button>
                <TooltipButton
                  variant="outline"
                  title="选择项目"
                  tooltipShortcut="Ctrl+Alt+Shift+O"
                >
                  快捷键提示
                </TooltipButton>
              </div>
              <div className="fixture-row">
                <SegmentedControl
                  label="输入体验样例"
                  value={mode}
                  options={[
                    { value: "chat", label: "对话" },
                    { value: "work", label: "工作" },
                    { value: "disabled", label: "不可用", disabled: true },
                  ]}
                  onChange={setMode}
                />
                <label className="fixture-row" htmlFor="fixture-switch">
                  开关
                  <Switch
                    id="fixture-switch"
                    aria-label="样例开关"
                    checked={switchOn}
                    onCheckedChange={setSwitchOn}
                  />
                </label>
              </div>
            </section>

            <section aria-labelledby="input-heading">
              <h2 id="input-heading">输入与模型</h2>
              <label htmlFor="fixture-name">
                资料名称
                <Input
                  id="fixture-name"
                  aria-label="资料名称"
                  placeholder="输入一段较长名称，检查缩放与焦点"
                />
              </label>
              <label htmlFor="fixture-draft">
                工作草稿
                <Textarea
                  id="fixture-draft"
                  aria-label="工作草稿"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="选择起步卡片只填草稿，不发送请求"
                />
              </label>
              <div className="fixture-row fixture-model-row">
                <ComposerModelControls
                  showExecutionControls={surface === "desktop"}
                  executionMode={executionMode}
                  hasModels
                  currentModelLabel={selectedModel.label}
                  modelOptions={models}
                  selectedValue={selectedModel.value}
                  chatRuntimeControls={runtime}
                  reasoningOptions={["minimal", "low", "medium", "high", "xhigh", "max"]}
                  thinkingAlwaysOn={false}
                  onSelectModel={(selection) => {
                    const next = models.find((item) => item.model === selection.model);
                    if (next) setSelectedModel(next);
                  }}
                  onSelectExecutionMode={setExecutionMode}
                  onOpenSettings={() => setReceipt("样例厂商设置入口")}
                  onChatRuntimeControlsChange={(patch) =>
                    setRuntime((previous) => ({ ...previous, ...patch }))
                  }
                />
                <span>
                  当前：{selectedModel.label} · {runtime.reasoning}
                </span>
              </div>
            </section>

            <section aria-labelledby="layers-heading">
              <h2 id="layers-heading">菜单与弹窗</h2>
              <div className="fixture-row">
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="outline" />}>
                    打开样例菜单
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem onClick={() => setReceipt("引用样例已触发")}>
                      <FileText className="size-4" />
                      引用资料
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled>不可用操作</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setReceipt("收藏样例已触发")}>
                      收藏
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Dialog>
                  <DialogTrigger render={<Button variant="outline" />}>打开样例弹窗</DialogTrigger>
                  <DialogContent closeLabel="关闭样例弹窗">
                    <DialogHeader>
                      <DialogTitle>验证弹窗和焦点</DialogTitle>
                      <DialogDescription>
                        Tab 不应离开弹窗；Escape 关闭并返回触发入口。
                      </DialogDescription>
                    </DialogHeader>
                    <DialogBody>
                      <Input aria-label="弹窗输入" placeholder="仅在此页保留" />
                    </DialogBody>
                    <DialogFooter>
                      <DialogClose render={<Button variant="outline" />}>返回样板</DialogClose>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </section>

            <section aria-labelledby="feedback-heading">
              <h2 id="feedback-heading">反馈与资源</h2>
              <StatusNotice
                message="资料准备就绪"
                description="成功反馈使用中性表面和状态图标。"
                tone="success"
              />
              <StatusNotice
                message="操作结果待核对"
                description="本页仅展示，不发起任何请求。"
                tone="warning"
                busy
                actions={
                  <Button variant="outline" onClick={() => setReceipt("手动核对样例已触发")}>
                    手动核对
                  </Button>
                }
              />
              <StatusNotice
                message="这是一条长错误说明，用于验证手机下文字换行、操作区和关闭入口，不应遮挡正文。"
                tone="error"
                description="已有草稿保留。"
                actions={
                  <Button variant="outline" onClick={() => setReceipt("编辑样例已触发")}>
                    编辑草稿
                  </Button>
                }
                onDismiss={() => setReceipt("关闭提示样例已触发")}
              />
              <StatusNotice message={receipt} compact />
              <ResourceSelectionCard
                title="示例参考文档"
                description="当前仅选择本地样例，没有上传和认证数据。"
                checked={resource}
                icon={FileText}
                onCheckedChange={setResource}
              />
              <ConversationStarter
                title="整理工作计划"
                description="填写本地草稿，随后由用户决定下一步。"
                icon={<FileText className="size-4" />}
                actionLabel="试一试"
                onSelect={() => setDraft("请帮我整理一份工作计划。")}
              />
            </section>

            <section aria-labelledby="navigation-heading">
              <h2 id="navigation-heading">导航与账户</h2>
              <div className="fixture-navigation">
                <ApplicationRail
                  brand={<span aria-hidden="true">Z</span>}
                  activeId="chat"
                  items={[
                    {
                      id: "chat",
                      label: "对话",
                      icon: <MessageSquare className="size-5" />,
                      onSelect: () => setReceipt("对话导航样例"),
                    },
                    {
                      id: "space",
                      label: "资料空间",
                      icon: <BookOpen className="size-5" />,
                      onSelect: () => setReceipt("资料导航样例"),
                    },
                  ]}
                  footer={<AccountAvatar label="Z" />}
                />
                <div className="fixture-row">
                  <AccountIdentity
                    name="示例账户"
                    description="此处无登录会话"
                    avatar={<AccountAvatar label="Z" />}
                  />
                </div>
              </div>
            </section>
          </main>
        </TooltipProvider>
      </ZoneFontScaleContext.Provider>
    </LocaleContext.Provider>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
