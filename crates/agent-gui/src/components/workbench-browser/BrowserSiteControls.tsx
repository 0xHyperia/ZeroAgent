import { useId } from "react";

export type SiteControlValue = string | number | boolean;
export type SiteControlValues = Record<string, SiteControlValue>;

type Control = { callback: string; label: string } & (
  | { type: "toggle"; value: boolean }
  | { type: "color"; value: string }
  | { type: "select"; value: string; options: { label: string; value: string }[] }
  | { type: "range"; value: number; min: number; max: number; step: number }
);

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function label(value: unknown, max = 80) {
  return typeof value === "string" && value.length <= max && /^[^\p{Cc}\p{Cf}]+$/u.test(value)
    ? value
    : null;
}

function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 10_000;
}

export function parseSiteControls(serialized?: string): Control[] {
  if (!serialized || serialized.length > 8192) return [];
  try {
    const source = JSON.parse(serialized);
    if (!Array.isArray(source) || source.length > 12) return [];
    const controls: Control[] = [];
    const callbacks = new Set<string>();
    for (const entry of source) {
      const input = object(entry);
      if (
        !input ||
        typeof input.callback !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(input.callback)
      )
        continue;
      const text = label(input.label);
      if (!text || callbacks.has(input.callback)) continue;
      const common = { callback: input.callback, label: text };
      const value = input.currentValue ?? input.defaultValue;
      if (input.type === "toggle") {
        if (value !== undefined && typeof value !== "boolean") continue;
        controls.push({ ...common, type: "toggle", value: value ?? false });
      } else if (input.type === "color") {
        if (value !== undefined && (typeof value !== "string" || !/^#[a-f0-9]{6}$/i.test(value)))
          continue;
        controls.push({ ...common, type: "color", value: value ?? "#ffffff" });
      } else if (input.type === "range") {
        const { min, max, step } = input;
        if (
          !number(min) ||
          !number(max) ||
          !number(step) ||
          min >= max ||
          step < 0.001 ||
          step > max - min
        )
          continue;
        if (value !== undefined && (!number(value) || value < min || value > max)) continue;
        controls.push({ ...common, type: "range", min, max, step, value: value ?? min });
      } else if (
        input.type === "select" &&
        Array.isArray(input.options) &&
        input.options.length > 0 &&
        input.options.length <= 12
      ) {
        const options = input.options.flatMap((item) => {
          const option = object(item);
          const optionLabel = label(option?.label);
          const optionValue = label(option?.value, 512);
          return optionLabel && optionValue ? [{ label: optionLabel, value: optionValue }] : [];
        });
        if (
          options.length !== input.options.length ||
          new Set(options.map((item) => item.value)).size !== options.length
        )
          continue;
        if (
          value !== undefined &&
          (typeof value !== "string" || !options.some((item) => item.value === value))
        )
          continue;
        controls.push({ ...common, type: "select", options, value: value ?? options[0].value });
      } else {
        continue;
      }
      callbacks.add(input.callback);
    }
    return controls;
  } catch {
    return [];
  }
}

export function encodeSiteControlChanges(controls: readonly Control[], values: SiteControlValues) {
  const changes = controls.flatMap(({ callback, label, value }) => {
    const next = Object.hasOwn(values, callback) ? values[callback] : value;
    return next === value ? [] : [{ callback, label, previousValue: value, value: next }];
  });
  const encoded = changes.length ? JSON.stringify(changes) : undefined;
  return encoded && new TextEncoder().encode(encoded).length <= 8192 ? encoded : undefined;
}

export function BrowserSiteControls({
  controls,
  values,
  title,
  onChange,
}: {
  controls: readonly Control[];
  values: SiteControlValues;
  title: string;
  onChange(callback: string, value: SiteControlValue): void;
}) {
  const controlGroup = useId();
  return (
    <fieldset className="max-h-40 space-y-2 overflow-auto border-t border-border px-3 py-2 text-xs">
      <legend className="px-1 text-muted-foreground">{title}</legend>
      {controls.map((control) => {
        const { callback, label, type } = control;
        const id = `${controlGroup}-${callback}`;
        const value = Object.hasOwn(values, callback) ? values[callback] : control.value;
        return (
          <label key={callback} htmlFor={id} className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate" title={label}>
              {label}
            </span>
            {type === "toggle" ? (
              <input
                id={id}
                type="checkbox"
                checked={value === true}
                onChange={(event) => onChange(callback, event.currentTarget.checked)}
              />
            ) : type === "range" ? (
              <span className="flex items-center gap-2">
                <input
                  id={id}
                  type="range"
                  className="w-24"
                  min={control.min}
                  max={control.max}
                  step={control.step}
                  value={Number(value)}
                  onChange={(event) => onChange(callback, event.currentTarget.valueAsNumber)}
                />
                <span className="w-9 text-end tabular-nums" aria-hidden="true">
                  {String(value)}
                </span>
              </span>
            ) : type === "select" ? (
              <select
                id={id}
                className="max-w-[60%] rounded-md border border-border bg-background px-1 py-0.5"
                value={String(value)}
                onChange={(event) => onChange(callback, event.currentTarget.value)}
              >
                {control.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={id}
                type="color"
                value={String(value)}
                onChange={(event) => onChange(callback, event.currentTarget.value)}
              />
            )}
          </label>
        );
      })}
    </fieldset>
  );
}
