import { ConversationStarter } from "@liveagent/ui/components/chat/ConversationStarter";
import {
  ChartColumn,
  ChevronDown,
  FileText,
  Lightbulb,
  Search,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { useLocale } from "@liveagent/ui/i18n";
import { useId, useState } from "react";
import type { CloudChatPresentation } from "./CloudChatComposerMenu";

export function CloudChatEmptyState({ mode = "work" }: { mode?: CloudChatPresentation }) {
  const { locale } = useLocale();
  const chatTitle = locale === "en-US" ? "What’s on your mind?" : "今天有什么安排？";
  const workTitle = locale === "en-US" ? "What are we working on?" : "我们要做什么？";
  return (
    <div className="cloud-chat-welcome">
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

const starters = [
  {
    id: "research",
    icon: Search,
    title: "研究一个问题",
    description: "梳理问题与资料，形成有来源的分析。",
    prompt: "请帮我研究一个问题。先与我确认研究目标、范围和需要的资料。",
    en: {
      title: "Research a question",
      description: "Gather sources and build an answer you can check.",
      prompt: "Help me research a question. First, ask me about the goal, scope, and sources.",
    },
  },
  {
    id: "data",
    icon: ChartColumn,
    title: "分析表格与数据",
    description: "整理数据、完成计算，交付清晰的结果。",
    prompt: "请帮我分析表格与数据。先询问数据来源、分析目标和希望交付的结果。",
    en: {
      title: "Analyze a spreadsheet",
      description: "Organize data, run calculations, and explain the results.",
      prompt: "Help me analyze some data. First, ask about the source, goal, and desired result.",
    },
  },
  {
    id: "writing",
    icon: FileText,
    title: "撰写或完善文档",
    description: "明确读者与目标，一起打磨可用的内容。",
    prompt: "请帮我撰写或完善一份文档。先询问用途、读者，以及需要包含的重点。",
    en: {
      title: "Draft or revise a document",
      description: "Shape a draft around its audience and purpose.",
      prompt:
        "Help me draft or revise a document. First, ask about the audience, purpose, and key points.",
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
  const itemsId = useId();
  const [expanded, setExpanded] = useState(false);
  return (
    <nav
      className="cloud-chat-starters"
      aria-label={english ? "Conversation starters" : "对话示例"}
      data-mode={mode}
    >
      {work && (
        <Button
          variant="ghost"
          size="sm"
          className="cloud-starters-trigger"
          aria-expanded={expanded}
          aria-controls={itemsId}
          onClick={() => setExpanded(!expanded)}
        >
          <Lightbulb className="size-4" aria-hidden="true" />
          {english ? "Explore work examples" : "查看工作示例"}
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </Button>
      )}
      <div id={itemsId}>
        {(!work || expanded) && (
          <div className="cloud-starter-items">
            {starters.map((item) => {
              const { title, description, prompt } = english ? item.en : item;
              const Icon = item.icon;
              return (
                <ConversationStarter
                  key={item.id}
                  title={title}
                  description={description}
                  icon={<Icon className="size-5" />}
                  layout={work ? "inline" : "stacked"}
                  onSelect={() => {
                    if (work) setExpanded(false);
                    onSelect(prompt);
                  }}
                />
              );
            })}
          </div>
        )}
      </div>
    </nav>
  );
}
