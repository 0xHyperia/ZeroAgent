import { BrandMark } from "@liveagent/ui/application/BrandMark";
import { ConversationStarter } from "@liveagent/ui/components/chat/ConversationStarter";
import {
  ChartColumn,
  FileText,
  Lightbulb,
  ListChecks,
  Search,
} from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n";
import type { CloudChatPresentation } from "./CloudChatComposerMenu";

export function CloudChatEmptyState({ mode = "work" }: { mode?: CloudChatPresentation }) {
  const { locale } = useLocale();
  const chatTitle = locale === "en-US" ? "What’s on your mind?" : "今天有什么安排？";
  const workTitle = locale === "en-US" ? "What are we working on?" : "我们要做什么？";
  return (
    <div className="cloud-chat-welcome">
      <BrandMark alt="" aria-hidden="true" className="cloud-welcome-logo" />
      <h1 className="cloud-welcome-titles" data-mode={mode}>
        <span className="sr-only">{mode === "chat" ? chatTitle : workTitle}</span>
        <span aria-hidden="true" data-visible={mode === "chat"}>
          {chatTitle}
        </span>
        <span aria-hidden="true" data-visible={mode === "work"}>
          {workTitle}
        </span>
      </h1>
    </div>
  );
}

const workStarters = [
  {
    id: "research",
    icon: Search,
    title: "制作对比报告",
    description: "比较方案，列出依据与建议",
    prompt:
      "请根据我提供的资料制作一份方案对比报告。按成本、收益和风险比较，标注依据与待验证假设，并给出推荐方案。请先向我确认要比较的方案和决策目标。",
    en: {
      title: "Compare options",
      description: "A report with evidence and a recommendation",
      prompt:
        "Create a comparison report from the material I provide. Compare costs, benefits, and risks, flag assumptions, and recommend an option. First, ask which options I’m considering and what I want to decide.",
    },
  },
  {
    id: "data",
    icon: ChartColumn,
    title: "分析一份表格",
    description: "找出趋势、异常和关键数字",
    prompt:
      "请分析我提供的表格。找出主要趋势和异常，汇总关键数字并注明计算口径。如果我还没有提供表格或分析目标，请先问我。",
    en: {
      title: "Analyze a spreadsheet",
      description: "Trends, anomalies, and key figures",
      prompt:
        "Analyze the spreadsheet I provide. Identify trends and anomalies, summarize the key figures, and explain how they were calculated. If I haven’t provided the spreadsheet or a goal, ask me for them first.",
    },
  },
  {
    id: "writing",
    icon: FileText,
    title: "整理项目周报",
    description: "汇总进展、风险和下一步",
    prompt:
      "请把我提供的项目记录整理成一份周报，包含本周进展、风险与待决事项、下周计划。资料里有负责人和期限就列出来，缺失的标为待确认。请先问我周报的读者和时间范围。",
    en: {
      title: "Write a weekly update",
      description: "Progress, risks, and next steps",
      prompt:
        "Turn my project notes into a weekly update covering progress, risks and open decisions, and next steps. Include owners and deadlines where supplied, and flag missing details. First, ask about the audience and reporting period.",
    },
  },
] as const;

const chatStarters = [
  {
    id: "explain",
    icon: Lightbulb,
    title: "用例子解释一个概念",
    prompt: "我想弄懂一个概念。请先问我想了解什么，再用通俗的例子解释。",
    en: {
      title: "Explain a concept with examples",
      prompt: "Ask which concept I want to understand, then explain it with a simple example.",
    },
  },
  {
    id: "summary",
    icon: FileText,
    title: "提炼一段文字的要点",
    prompt: "请把我接下来提供的文字提炼成三条要点，保留关键事实。",
    en: {
      title: "Summarize a passage",
      prompt: "Summarize the text I provide next in three points, keeping the key facts.",
    },
  },
  {
    id: "plan",
    icon: ListChecks,
    title: "把一个目标拆成步骤",
    prompt: "请先问我想完成的目标和期限，再帮我拆成可以逐项完成的步骤。",
    en: {
      title: "Break a goal into steps",
      prompt: "Ask about my goal and deadline, then help me break it down into manageable steps.",
    },
  },
] as const;

export function CloudChatStarters({
  mode = "work",
  onSelect,
}: {
  mode?: CloudChatPresentation;
  onSelect: (prompt: string) => void;
}) {
  const { locale } = useLocale();
  const english = locale === "en-US";
  const work = mode === "work";
  return (
    <fieldset
      className="cloud-chat-starters m-0 min-w-0 border-0 p-0"
      aria-label={
        work
          ? english
            ? "Work examples"
            : "工作示例"
          : english
            ? "Conversation starters"
            : "对话示例"
      }
      data-mode={mode}
    >
      <div className="cloud-starter-items">
        {(work ? workStarters : chatStarters).map((item) => {
          const example = english ? item.en : item;
          const Icon = item.icon;
          return (
            <ConversationStarter
              key={item.id}
              title={example.title}
              description={"description" in example ? example.description : undefined}
              icon={<Icon className="size-5" />}
              layout="inline"
              onSelect={() => onSelect(example.prompt)}
            />
          );
        })}
      </div>
    </fieldset>
  );
}
