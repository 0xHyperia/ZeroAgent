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
import { type Locale, useLocale } from "@liveagent/ui/i18n";
import { useEffect, useState } from "react";
import { MOBILE_BACK_EVENT } from "@/lib/mobileRuntime";

const icons = [
  { id: "folder", zh: "文件夹", en: "Folder", keywords: "项目 project", icon: FolderClosed },
  { id: "book", zh: "书本", en: "Book", keywords: "学习 阅读 study reading", icon: BookOpen },
  {
    id: "code",
    zh: "代码",
    en: "Code",
    keywords: "开发 编程 development programming",
    icon: Brackets,
  },
  { id: "terminal", zh: "终端", en: "Terminal", keywords: "命令 command shell", icon: Terminal },
  { id: "chart", zh: "图表", en: "Chart", keywords: "数据 分析 data analytics", icon: ChartColumn },
  { id: "palette", zh: "调色盘", en: "Palette", keywords: "设计 创作 design art", icon: Palette },
  { id: "globe", zh: "地球", en: "Globe", keywords: "旅行 网站 travel web", icon: Globe },
  { id: "brain", zh: "大脑", en: "Brain", keywords: "思考 研究 thinking research", icon: Brain },
  {
    id: "lightbulb",
    zh: "灯泡",
    en: "Light bulb",
    keywords: "灵感 idea inspiration",
    icon: Lightbulb,
  },
  { id: "pen", zh: "笔", en: "Pen", keywords: "写作 文档 writing document", icon: SquarePen },
  { id: "star", zh: "星星", en: "Star", keywords: "收藏 favorite", icon: Star },
  {
    id: "calendar",
    zh: "日历",
    en: "Calendar",
    keywords: "计划 schedule planning",
    icon: CalendarDays,
  },
  { id: "target", zh: "目标", en: "Target", keywords: "goal", icon: Target },
  { id: "wrench", zh: "工具", en: "Wrench", keywords: "工作 tool work", icon: Wrench },
  { id: "image", zh: "图片", en: "Image", keywords: "摄影 photo photography", icon: ImageIcon },
] as const;
const colors = [
  { id: "default", zh: "默认", en: "Default", value: "currentColor" },
  { id: "red", zh: "红色", en: "Red", value: "#ef4444" },
  { id: "orange", zh: "橙色", en: "Orange", value: "#f97316" },
  { id: "amber", zh: "黄色", en: "Yellow", value: "#eab308" },
  { id: "green", zh: "绿色", en: "Green", value: "#16a34a" },
  { id: "blue", zh: "蓝色", en: "Blue", value: "#3b82f6" },
  { id: "violet", zh: "紫色", en: "Purple", value: "#8b5cf6" },
  { id: "pink", zh: "粉色", en: "Pink", value: "#ec4899" },
] as const;

export function projectAppearanceLabel(field: "icon" | "color", value: string, locale: Locale) {
  const options = field === "icon" ? icons : colors;
  const item = value ? options.find((option) => option.id === value) : options[0];
  return item?.[locale === "en-US" ? "en" : "zh"] ?? value;
}

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
  const { locale } = useLocale();
  const english = locale === "en-US";
  const labelKey = english ? "en" : "zh";
  const searchLabel = english ? "Search icons" : "搜索图标";
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const terms = search.trim().toLowerCase().split(/\s+/);
  const matchingIcons = icons.filter((item) => {
    const searchable = `${item.zh} ${item.en} ${item.keywords} ${item.id}`.toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
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
            aria-label={english ? "Choose project icon and color" : "选择项目图标和颜色"}
            disabled={props.disabled}
          />
        }
      >
        <CloudProjectIcon icon={props.icon} color={props.color} className="size-5" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[340px] max-w-[calc(100vw-32px)] rounded-2xl p-4"
        aria-label={english ? "Project icon and color" : "项目图标和颜色"}
      >
        <Input
          aria-label={searchLabel}
          placeholder={searchLabel}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="mb-4 h-10 rounded-xl"
        />
        <fieldset
          aria-label={english ? "Icon color" : "图标颜色"}
          className="mb-4 grid grid-cols-8 gap-2"
        >
          {colors.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-label={item[labelKey]}
              aria-pressed={props.color === item.id}
              className="cloud-project-color"
              style={{ color: item.value }}
              onClick={() => props.onChange({ icon: props.icon, color: item.id })}
            >
              <span />
            </button>
          ))}
        </fieldset>
        <fieldset
          aria-label={english ? "Project icon" : "项目图标"}
          className="grid grid-cols-5 gap-2"
        >
          {matchingIcons.map((item) => (
            <Button
              key={item.id}
              type="button"
              variant="ghost"
              className="size-11 rounded-xl p-0 aria-pressed:bg-accent"
              aria-label={item[labelKey]}
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
        {!matchingIcons.length ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {english ? "No icons found" : "未找到图标"}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
