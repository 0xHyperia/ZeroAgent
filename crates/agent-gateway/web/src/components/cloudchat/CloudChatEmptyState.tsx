import { ChartColumn, FileText, Lightbulb, Search } from "@liveagent/ui/components/IconSet";
import type { CloudChatPresentation } from "./CloudChatComposerMenu";

export function CloudChatEmptyState({ mode = "work" }: { mode?: CloudChatPresentation }) {
  return (
    <div className="cloud-chat-welcome">
      <h1 className="cloud-welcome-titles" data-mode={mode}>
        <span className="sr-only">{mode === "chat" ? "今天有什么安排？" : "我们要做什么？"}</span>
        <span aria-hidden="true" data-visible={mode === "chat"}>
          今天有什么安排？
        </span>
        <span aria-hidden="true" data-visible={mode === "work"}>
          我们要做什么？
        </span>
      </h1>
    </div>
  );
}

const starters = [
  {
    id: "research",
    icon: Search,
    title: "研究一个问题",
    description: "梳理问题与资料，形成有来源的分析。",
    prompt: "请帮我研究一个问题。先与我确认研究目标、范围和需要的资料。",
  },
  {
    id: "data",
    icon: ChartColumn,
    title: "分析表格与数据",
    description: "整理数据、完成计算，交付清晰的结果。",
    prompt: "请帮我分析表格与数据。先询问数据来源、分析目标和希望交付的结果。",
  },
  {
    id: "writing",
    icon: FileText,
    title: "撰写或完善文档",
    description: "明确读者与目标，一起打磨可用的内容。",
    prompt: "请帮我撰写或完善一份文档。先询问用途、读者，以及需要包含的重点。",
  },
] as const;

export function CloudChatStarters({
  mode = "work",
  onSelect,
}: {
  mode?: CloudChatPresentation;
  onSelect: (prompt: string) => void;
}) {
  return (
    <nav className="cloud-chat-starters" aria-label="开始使用" data-mode={mode}>
      <p className="cloud-starters-caption" aria-hidden={mode !== "work"}>
        <Lightbulb className="size-4" />
        看看工作模式能做什么
      </p>
      <div className="cloud-starter-items">
        {starters.map(({ id, icon: Icon, title, description, prompt }) => (
          <button key={id} type="button" className="cloud-starter" onClick={() => onSelect(prompt)}>
            <span className="cloud-starter-top">
              <Icon className="size-5" aria-hidden="true" />
              <span className="cloud-starter-try" aria-hidden="true">
                试一试
              </span>
            </span>
            <span className="cloud-starter-title">{title}</span>
            <span className="cloud-starter-description">{description}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
