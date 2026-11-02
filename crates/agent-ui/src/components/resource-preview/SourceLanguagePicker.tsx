import { useEffect, useState } from "react";
import { sourceLanguages } from "../../lib/sourceLanguages";
import { Check } from "../IconSet";
import { Button } from "../ui/button";
import {
  Command,
  CommandDialog,
  CommandDialogDescription,
  CommandDialogPopup,
  CommandDialogTitle,
  CommandFooter,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
} from "../ui/command";

const options = [
  { id: "", name: "自动识别", aliases: ["auto"] },
  { id: "plaintext", name: "纯文本", aliases: ["plain", "text", "txt"] },
  ...sourceLanguages,
];

export function SourceLanguagePicker(props: {
  open: boolean;
  value: string;
  onOpenChange: (value: boolean) => void;
  onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!props.open) setQuery("");
  }, [props.open]);
  const needle = query.trim().toLowerCase();
  const selected = options.find((item) => item.id === props.value);
  const ordered = selected ? [selected, ...options.filter((item) => item !== selected)] : options;
  const items = ordered.filter((item) =>
    [item.name, item.id, ...item.aliases].some((name) => name.toLowerCase().includes(needle)),
  );
  return (
    <CommandDialog
      open={props.open}
      onOpenChange={(open) => {
        setQuery("");
        props.onOpenChange(open);
      }}
    >
      <CommandDialogPopup className="za-source-languages max-w-sm max-h-[min(600px,80dvh)]">
        <CommandDialogTitle className="sr-only">代码语言</CommandDialogTitle>
        <CommandDialogDescription className="sr-only">
          选择原文的语法高亮语言，文件内容保持不变。
        </CommandDialogDescription>
        <Command
          items={items}
          value={query}
          onValueChange={setQuery}
          itemToStringValue={(item) => item.name}
          filter={null}
          mode="none"
        >
          <CommandInput aria-label="搜索代码语言" placeholder="搜索语言或别名…" />
          <CommandPanel>
            {items.length === 0 ? (
              <div role="status" className="p-6 text-center text-sm text-muted-foreground">
                没有匹配的语言
              </div>
            ) : null}
            <CommandList aria-label="代码语言" className="max-h-[min(52vh,400px)]">
              {items.map((item) => (
                <CommandItem
                  key={item.id}
                  value={item}
                  onClick={() => {
                    props.onChange(item.id);
                    props.onOpenChange(false);
                  }}
                >
                  <span className="flex w-full items-center gap-3">
                    <span className="min-w-0 flex-1">{item.name}</span>
                    {props.value === item.id ? <Check className="size-4 shrink-0" /> : null}
                  </span>
                </CommandItem>
              ))}
            </CommandList>
          </CommandPanel>
        </Command>
        <CommandFooter>
          <span>{sourceLanguages.length} 种语言</span>
          <Button variant="ghost" size="sm" onClick={() => props.onOpenChange(false)}>
            取消
          </Button>
        </CommandFooter>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
