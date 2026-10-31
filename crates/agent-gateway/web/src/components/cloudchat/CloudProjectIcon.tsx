import {
  BookOpen,
  Brackets,
  Brain,
  CalendarDays,
  ChartColumn,
  FolderClosed,
  Globe,
  ImageIcon,
  Lightbulb,
  Palette,
  SquarePen,
  Star,
  Target,
  Terminal,
  Wrench,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { Input } from "@liveagent/ui/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@liveagent/ui/components/ui/popover";
import { useEffect, useState } from "react";
import { MOBILE_BACK_EVENT } from "@/lib/mobileRuntime";

const icons = [
  { id: "folder", label: "文件夹 项目", icon: FolderClosed },
  { id: "book", label: "书本 学习 阅读", icon: BookOpen },
  { id: "code", label: "代码 开发 编程", icon: Brackets },
  { id: "terminal", label: "终端 命令", icon: Terminal },
  { id: "chart", label: "图表 数据 分析", icon: ChartColumn },
  { id: "palette", label: "调色盘 设计 创作", icon: Palette },
  { id: "globe", label: "地球 旅行 网站", icon: Globe },
  { id: "brain", label: "大脑 思考 研究", icon: Brain },
  { id: "lightbulb", label: "灯泡 灵感", icon: Lightbulb },
  { id: "pen", label: "笔 写作 文档", icon: SquarePen },
  { id: "star", label: "星星 收藏", icon: Star },
  { id: "calendar", label: "日历 计划", icon: CalendarDays },
  { id: "target", label: "目标", icon: Target },
  { id: "wrench", label: "工具 工作", icon: Wrench },
  { id: "image", label: "图片 摄影", icon: ImageIcon },
] as const;
const colors = [
  { id: "default", label: "默认", value: "currentColor" },
  { id: "red", label: "红色", value: "#ef4444" },
  { id: "orange", label: "橙色", value: "#f97316" },
  { id: "amber", label: "黄色", value: "#eab308" },
  { id: "green", label: "绿色", value: "#16a34a" },
  { id: "blue", label: "蓝色", value: "#3b82f6" },
  { id: "violet", label: "紫色", value: "#8b5cf6" },
  { id: "pink", label: "粉色", value: "#ec4899" },
] as const;

export function CloudProjectIcon({
  icon,
  color,
  className = "size-4",
}: {
  icon?: string;
  color?: string;
  className?: string;
}) {
  const Glyph = icons.find((item) => item.id === icon)?.icon ?? FolderClosed;
  const tint = colors.find((item) => item.id === color)?.value ?? "currentColor";
  return <Glyph className={className} style={{ color: tint }} aria-hidden="true" />;
}

export function CloudProjectIconPicker(props: {
  icon: string;
  color: string;
  disabled?: boolean;
  onChange: (appearance: { icon: string; color: string }) => void;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const back = (event: Event) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      setOpen(false);
    };
    window.addEventListener(MOBILE_BACK_EVENT, back, true);
    return () => window.removeEventListener(MOBILE_BACK_EVENT, back, true);
  }, [open]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            className="h-12 w-12 shrink-0 rounded-none border-r p-0"
            aria-label="选择项目图标和颜色"
            disabled={props.disabled}
          />
        }
      >
        <CloudProjectIcon icon={props.icon} color={props.color} className="size-5" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[340px] max-w-[calc(100vw-32px)] rounded-2xl p-4"
        aria-label="项目图标和颜色"
      >
        <Input
          aria-label="搜索图标"
          placeholder="搜索图标"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="mb-4 h-10 rounded-xl"
        />
        <fieldset aria-label="图标颜色" className="mb-4 grid grid-cols-8 gap-2">
          {colors.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-label={item.label}
              aria-pressed={props.color === item.id}
              className="cloud-project-color"
              style={{ color: item.value }}
              onClick={() => props.onChange({ icon: props.icon, color: item.id })}
            >
              <span />
            </button>
          ))}
        </fieldset>
        <fieldset aria-label="项目图标" className="grid grid-cols-5 gap-2">
          {icons
            .filter((item) => `${item.label} ${item.id}`.includes(search.trim().toLowerCase()))
            .map((item) => (
              <Button
                key={item.id}
                type="button"
                variant="ghost"
                className="size-11 rounded-xl p-0 aria-pressed:bg-accent"
                aria-label={item.label.split(" ")[0]}
                aria-pressed={props.icon === item.id}
                onClick={() => {
                  props.onChange({ icon: item.id, color: props.color });
                  setOpen(false);
                }}
              >
                <CloudProjectIcon icon={item.id} color={props.color} className="size-5" />
              </Button>
            ))}
        </fieldset>
        {search &&
        !icons.some((item) => `${item.label} ${item.id}`.includes(search.trim().toLowerCase())) ? (
          <p className="py-4 text-center text-sm text-muted-foreground">未找到图标</p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
