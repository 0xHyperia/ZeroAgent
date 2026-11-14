import type { WebSearchFallbackState } from "../../lib/providers/webSearchFallback";
import type {
  ChatRuntimeControls,
  ExecutionMode,
  ProviderId,
  ReasoningLevel,
  SelectedModel,
} from "@liveagent/app/lib/settings";
import type { SharedModelOption } from "@liveagent/ui/lib/models/modelOptions";
import { memo } from "react";
import { ComposerInlineModelControls } from "./ComposerInlineModelControls";
export type ComposerModelControlsProps = {
  presentation?: "standard" | "inline";
  /** Local/device hosts retain mode and native-search controls in the shared popup. */
  showExecutionControls?: boolean;
  /** Compact chat shows effort; its accessible name still identifies the selected model. */
  compactLabel?: boolean;
  mobileSheet?: boolean;
  showProviderIcon?: boolean;
  executionMode: ExecutionMode;
  hasModels: boolean;
  currentModelLabel: string;
  modelOptions: SharedModelOption<ProviderId>[];
  selectedValue?: string;
  chatRuntimeControls: ChatRuntimeControls;
  webSearchFallback?: WebSearchFallbackState;
  reasoningOptions: ReasoningLevel[];
  thinkingAlwaysOn: boolean;
  disabled?: boolean;
  modelsRefreshing?: boolean;
  onRefreshModels?: () => void | Promise<void>;
  onSelectModel: (selection: SelectedModel) => void;
  onSelectExecutionMode: (mode: "text" | "tools") => void;
  onOpenSettings: (section?: "providers" | "model-preferences" | "webSearch", providerId?: string) => void;
  onChatRuntimeControlsChange: (patch: Partial<ChatRuntimeControls>) => void;
  /** 受控开关（/model 指令从外部打开）；缺省时弹层自管开关。 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/** All hosts use one model/effort surface; only host capabilities differ. */
export const ComposerModelControls = memo(function ComposerModelControls(
  props: ComposerModelControlsProps,
) {
  return (
    <ComposerInlineModelControls
      {...props}
      showExecutionControls={props.showExecutionControls ?? props.presentation !== "inline"}
    />
  );
});
