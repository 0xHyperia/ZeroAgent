import { MODEL_VENDOR_ORDER, resolveModelVendor } from "../providers/modelVendor";
import type { ProviderId } from "../settings/types";
import type { ProviderSortMode } from "./modelOptions";
import { type ModelType, modelTypesFor } from "./modelTypes";
import { parseModelValue } from "./modelValue";

export type ModelPickerOption = {
  value: string;
  label: string;
  description?: string;
  providerName: string;
  providerId?: string;
  providerType?: ProviderId;
  model?: string;
  modelTypes?: readonly ModelType[];
  disabledReason?: string;
  badges?: readonly string[];
  reasoning?: boolean;
  vision?: boolean;
  contextWindow?: number;
};

export type ModelPickerView = "provider" | "vendor";
export type ModelPickerEntry = {
  id: string;
  label: string;
  options: ModelPickerOption[];
};
export type ModelPickerGroup = {
  id: string;
  name: string;
  providerType?: ProviderId;
  iconModel?: string;
  entries: ModelPickerEntry[];
};

const VIEW_STORAGE_KEY = "chatModelPickerView";

export function modelIdOf(option: ModelPickerOption): string {
  return option.model ?? parseModelValue(option.value)?.model ?? option.value;
}

export function modelPickerTypes(option: ModelPickerOption): readonly ModelType[] {
  return modelTypesFor(modelIdOf(option), option);
}

export function readModelPickerView(): ModelPickerView {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === "vendor" ? "vendor" : "provider";
  } catch {
    return "provider";
  }
}

export function persistModelPickerView(view: ModelPickerView) {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Browsing and selection still work without preference storage.
  }
}

/** Classifying a model never changes its concrete provider/value routing. */
export function buildModelPickerGroups(
  options: readonly ModelPickerOption[],
  view: ModelPickerView,
  search: string,
  providerFilter: string,
  sort: ProviderSortMode,
): ModelPickerGroup[] {
  const query = search.trim().toLowerCase();
  const groups = new Map<string, ModelPickerGroup>();
  for (const option of options) {
    const providerId = option.providerId ?? option.providerName;
    const model = modelIdOf(option);
    const vendor = resolveModelVendor({ id: model });
    // Searching all groups retains the composer's existing search behavior.
    if (!query && providerFilter && providerFilter !== providerId) continue;
    if (
      query &&
      ![model, option.label, option.providerName, option.description ?? "", vendor].some((value) =>
        value.toLowerCase().includes(query),
      )
    )
      continue;
    const id = view === "vendor" ? vendor : providerId;
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        name: view === "vendor" ? vendor : option.providerName,
        providerType: option.providerType,
        iconModel: view === "vendor" ? model : undefined,
        entries: [],
      };
      groups.set(id, group);
    }
    const entryId = view === "vendor" ? model : option.value;
    const existing = group.entries.find((entry) => entry.id === entryId);
    if (existing) {
      if (!existing.options.some((item) => item.value === option.value))
        existing.options.push(option);
    } else {
      group.entries.push({ id: entryId, label: option.label, options: [option] });
    }
  }
  const result = Array.from(groups.values());
  const protocols = Array.from(new Set(result.map((group) => group.providerType)));
  const vendors: readonly string[] = MODEL_VENDOR_ORDER;
  const rank = (group: ModelPickerGroup) =>
    view === "vendor"
      ? vendors.includes(group.id)
        ? vendors.indexOf(group.id)
        : vendors.length
      : protocols.indexOf(group.providerType);
  return result.sort((left, right) =>
    sort === "alpha"
      ? left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" })
      : rank(left) - rank(right),
  );
}
