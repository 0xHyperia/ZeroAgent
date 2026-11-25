import "@liveagent/ui/i18n/namespaces/settings";
import type { ReactNode } from "react";
import { ImageIcon, Video, WandSparkles } from "../../components/IconSet";
import { Button } from "../../components/ui/button";
import { useLocale } from "../../i18n";
import type { ModelType } from "../../lib/models/modelTypes";
import { ModelPicker, type ModelPickerOption } from "./modelPicker";
import { DrawerSectionHeader } from "./ProviderPresentation";

export function GenerationModelsCard({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  return (
    <section
      className="rounded-xl bg-settings-tile p-4"
      aria-label={t("settings.customSettingsModelsTitle")}
    >
      <DrawerSectionHeader
        icon={<WandSparkles className="size-3.5" />}
        title={t("settings.customSettingsModelsTitle")}
      />
      <div className="mt-3.5 space-y-3">{children}</div>
    </section>
  );
}

export function ModelPreferenceField(props: {
  label: string;
  hint: string;
  options: ModelPickerOption[];
  modelType: ModelType;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  noneLabel: string;
  disabled?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <div className="text-sm font-medium">{props.label}</div>
        <p className="text-xs leading-5 text-muted-foreground">{props.hint}</p>
      </div>
      <ModelPicker {...props} ariaLabel={props.label} variant="plain" />
    </div>
  );
}

export function ImageModelPreference(props: {
  options: ModelPickerOption[];
  value: string;
  onChange: (value: string) => void;
  onRefresh?: () => void;
  loading: boolean;
  saving?: boolean;
  disabled?: boolean;
  error?: string;
  notice?: string;
}) {
  const unavailable =
    !!props.value && !props.options.some((option) => option.value === props.value);
  return (
    <section className="space-y-4 rounded-xl bg-settings-tile p-4" aria-label="媒体生成模型">
      <div className="flex items-start gap-2.5">
        <ImageIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-3">
          <ModelPreferenceField
            label="生图模型"
            modelType="image"
            hint="用于新建图像创作。未配置时需先选择模型，已有草稿和任务保留原模型。"
            options={props.options}
            value={props.value}
            onChange={props.onChange}
            disabled={props.disabled || props.loading || props.saving}
            placeholder={
              props.loading
                ? "正在读取…"
                : props.saving
                  ? "正在保存…"
                  : unavailable
                    ? "已选模型暂不可用，请重新选择"
                    : "未配置"
            }
            noneLabel="未配置"
            onRefresh={props.onRefresh}
            refreshing={props.loading}
          />
          {props.notice ? (
            <p role="status" className="text-xs text-muted-foreground">
              {props.notice}
            </p>
          ) : null}
          {props.error ? (
            <div className="space-y-1">
              <p role="alert" className="text-xs leading-5 text-destructive">
                {props.error}
              </p>
              {props.onRefresh ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={props.loading || props.saving}
                  onClick={props.onRefresh}
                >
                  重新读取
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex items-start gap-2.5 border-t border-border/50 pt-4">
        <Video className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div>
          <h2 className="text-sm font-medium">视频生成</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            当前运行环境暂不支持视频生成。
          </p>
        </div>
      </div>
    </section>
  );
}
