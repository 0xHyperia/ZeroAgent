import { useDirectoryPicker } from "@liveagent/adapters/directoryPicker";
import { toModelValue } from "@liveagent/ui/lib/models/modelValue";
import type { AppSettings } from "@liveagent/ui/lib/settings/types";
import {
  CronTaskModal,
  useCronTaskEditorOptions,
} from "@liveagent/ui/pages/settings/CronTaskModal";
import type { DeviceScheduleEditorProps } from "../../lib/deviceScheduleHost";

export function DeviceScheduleEditor({
  settings,
  target,
  timeZone,
  task,
  name,
  prompt,
  onUseCloud,
  preview,
  onSave,
  onClose,
}: DeviceScheduleEditorProps & { settings: AppSettings }) {
  const { pickDirectory, directoryPickerElement } = useDirectoryPicker();
  const { modelOptions, workspaceOptions } = useCronTaskEditorOptions(settings);
  const selected = settings.selectedModel;
  const modelValue = selected && toModelValue(selected.customProviderId, selected.model);

  return (
    <>
      <CronTaskModal
        mode={task ? "edit" : "add"}
        initialData={task}
        workbench={{
          target,
          timeZone,
          name,
          prompt,
          onUseCloud,
          preview,
          modelValue: modelOptions.some((option) => option.value === modelValue)
            ? modelValue
            : undefined,
        }}
        modelOptions={modelOptions}
        providers={settings.customProviders}
        workspaceOptions={workspaceOptions}
        executionMode={settings.system.executionMode}
        onPickWorkdir={pickDirectory}
        onSave={onSave}
        onClose={onClose}
      />
      {directoryPickerElement}
    </>
  );
}
