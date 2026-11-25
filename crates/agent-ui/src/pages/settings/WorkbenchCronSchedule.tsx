import "@liveagent/ui/i18n/namespaces/scheduledTasks";
import { useId, useRef } from "react";
import { timeZoneDisplayName } from "../../components/settings/TimeZonePicker";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { useLocale } from "../../i18n";

const weekdays = [1, 2, 3, 4, 5, 6, 0] as const;
const intervals = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60, 120, 180, 240, 360, 480, 720];
type Frequency = "daily" | "workdays" | "weekly" | "monthly" | "interval" | "custom";
type WorkbenchSchedule =
  | { frequency: "daily" | "workdays"; time: string }
  | { frequency: "weekly"; time: string; days: Set<number> }
  | { frequency: "monthly"; time: string; day: number }
  | { frequency: "interval"; interval: number }
  | { frequency: "custom" };

function parseSchedule(expression: string): WorkbenchSchedule {
  const [seconds, minute, hour, day, month, days, ...rest] = expression.trim().split(/\s+/);
  if (seconds === "0" && month === "*" && !rest.length) {
    if (hour === "*" && day === "*" && days === "*" && minute?.startsWith("*/")) {
      const interval = Number(minute.slice(2));
      if (interval < 60 && intervals.includes(interval))
        return { frequency: "interval", interval } as const;
    }
    if (minute === "0" && day === "*" && days === "*") {
      const interval = hour === "*" ? 60 : hour?.startsWith("*/") ? Number(hour.slice(2)) * 60 : 0;
      if (interval >= 60 && intervals.includes(interval))
        return { frequency: "interval", interval } as const;
    }
    if (
      /^\d{1,2}$/.test(minute ?? "") &&
      Number(minute) <= 59 &&
      /^\d{1,2}$/.test(hour ?? "") &&
      Number(hour) <= 23
    ) {
      const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
      if (day === "*" && days === "*") return { frequency: "daily", time } as const;
      if (day === "*" && days === "1-5") return { frequency: "workdays", time } as const;
      if (day === "*" && /^[0-6](,[0-6])*$/.test(days ?? ""))
        return { frequency: "weekly", time, days: new Set(days.split(",").map(Number)) } as const;
      if (days === "*" && /^\d{1,2}$/.test(day ?? "") && Number(day) >= 1 && Number(day) <= 31)
        return { frequency: "monthly", time, day: Number(day) } as const;
    }
  }
  return { frequency: "custom" } as const;
}

function intervalExpression(minutes: number) {
  if (minutes < 60) return `0 */${minutes} * * * *`;
  return minutes === 60 ? "0 0 * * * *" : `0 0 */${minutes / 60} * * *`;
}

function clockExpression(frequency: Frequency, time: string, monthDay = 1, weekDays = "1") {
  const [hour, minute] = time.split(":").map(Number);
  const day = frequency === "monthly" ? monthDay : "*";
  const days = frequency === "workdays" ? "1-5" : frequency === "weekly" ? weekDays : "*";
  return `0 ${minute} ${hour} ${day} * ${days}`;
}

const row = "flex min-h-11 flex-wrap items-center justify-between gap-2 px-3 py-1 text-sm";
const trigger = "w-fit max-w-[70%] border-transparent bg-transparent text-muted-foreground";

/** Only converts patterns whose six-field Cron interpretation is exact. */
export function WorkbenchCronSchedule({
  expression,
  timeZone,
  onExpression,
}: {
  expression: string;
  timeZone?: string;
  onExpression: (expression: string) => void;
}) {
  const { locale, t } = useLocale();
  const id = useId();
  const text = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
  const schedule = parseSchedule(expression);
  const time = "time" in schedule ? schedule.time : "09:00";
  const frequencies: Record<Frequency, string> = {
    daily: text("每天", "Daily"),
    workdays: text("工作日", "Weekdays"),
    weekly: text("每周", "Weekly"),
    monthly: text("每月", "Monthly"),
    interval: text("按间隔", "At intervals"),
    custom: text("自定义 Cron", "Custom Cron"),
  };
  const intervalLabel = (minutes: number) =>
    minutes < 60
      ? text(`${minutes} 分钟`, `${minutes} min`)
      : text(`${minutes / 60} 小时`, `${minutes / 60} hr`);

  return (
    <div className="divide-y divide-border/60 rounded-2xl border border-border/60">
      <div className={row}>
        <label htmlFor={`${id}-frequency`}>{text("重复", "Repeat")}</label>
        <Select
          value={schedule.frequency}
          onValueChange={(value) => {
            if (!value || !(value in frequencies)) return;
            const frequency = value as Frequency;
            if (frequency === "custom") onExpression("");
            else if (frequency === "interval") onExpression(intervalExpression(60));
            else onExpression(clockExpression(frequency, time));
          }}
        >
          <SelectTrigger id={`${id}-frequency`} variant="plain" className={trigger}>
            <SelectValue>{frequencies[schedule.frequency]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {Object.entries(frequencies).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {schedule.frequency === "custom" ? (
        <div className="space-y-1.5 px-3 py-2.5">
          <Input
            aria-label={t("settings.cronExpression")}
            className="font-mono"
            value={expression}
            placeholder={t("settings.cronExpressionPlaceholder")}
            onChange={(event) => onExpression(event.currentTarget.value)}
          />
          <p className="text-xs text-muted-foreground">{t("settings.cronExpressionHint")}</p>
        </div>
      ) : schedule.frequency === "interval" ? (
        <div className={row}>
          <label htmlFor={`${id}-interval`}>{text("每隔", "Every")}</label>
          <Select
            value={String(schedule.interval)}
            onValueChange={(value) => {
              if (intervals.includes(Number(value)))
                onExpression(intervalExpression(Number(value)));
            }}
          >
            <SelectTrigger id={`${id}-interval`} variant="plain" className={trigger}>
              <SelectValue>{intervalLabel(schedule.interval)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {intervals.map((value) => (
                <SelectItem key={value} value={String(value)}>
                  {intervalLabel(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <>
          {schedule.frequency === "weekly" && (
            <fieldset className="flex min-w-0 flex-wrap gap-1.5 px-3 py-2">
              <legend className="sr-only">{text("每周运行日", "Days of the week")}</legend>
              {weekdays.map((day) => {
                const date = new Date(Date.UTC(2026, 0, 4 + day));
                const options = { timeZone: "UTC" } as const;
                const label = new Intl.DateTimeFormat(locale, {
                  weekday: "long",
                  ...options,
                }).format(date);
                const short = new Intl.DateTimeFormat(locale, {
                  weekday: "short",
                  ...options,
                }).format(date);
                const active = schedule.days.has(day);
                return (
                  <button
                    type="button"
                    key={day}
                    aria-label={label}
                    aria-pressed={active}
                    className={`min-h-9 rounded-lg px-2 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active ? "bg-muted font-medium" : "text-muted-foreground"}`}
                    disabled={active && schedule.days.size === 1}
                    onClick={() => {
                      const days = new Set(schedule.days);
                      if (active) days.delete(day);
                      else days.add(day);
                      onExpression(
                        clockExpression("weekly", time, undefined, [...days].sort().join(",")),
                      );
                    }}
                  >
                    {short}
                  </button>
                );
              })}
            </fieldset>
          )}
          {schedule.frequency === "monthly" && (
            <div className={row}>
              <label htmlFor={`${id}-month-day`}>{text("每月日期", "Day of the month")}</label>
              <Select
                value={String(schedule.day)}
                onValueChange={(value) => {
                  if (value) onExpression(clockExpression("monthly", time, Number(value)));
                }}
              >
                <SelectTrigger id={`${id}-month-day`} variant="plain" className={trigger}>
                  <SelectValue>{schedule.day}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                    <SelectItem key={day} value={String(day)}>
                      {day}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className={row}>
            <label htmlFor={`${id}-time`}>{text("时间", "Time")}</label>
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-muted-foreground">
              <span className="text-xs">
                {timeZone && timeZone !== "Local"
                  ? timeZoneDisplayName(timeZone, locale)
                  : text("设备时区", "Device time zone")}
              </span>
              <Input
                type="time"
                id={`${id}-time`}
                value={time}
                className="w-auto border-transparent bg-transparent"
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  if (/^\d\d:\d\d$/.test(value))
                    onExpression(
                      clockExpression(
                        schedule.frequency,
                        value,
                        "day" in schedule ? schedule.day : undefined,
                        "days" in schedule ? [...schedule.days].join(",") : undefined,
                      ),
                    );
                }}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function WorkbenchCronLimits({
  remaining,
  onRemaining,
}: {
  remaining: string;
  onRemaining: (remaining: string) => void;
}) {
  const { locale, t } = useLocale();
  const id = useId();
  const text = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
  const endMode = remaining ? "count" : "never";
  const once = remaining === "1";
  const repeatedCount = useRef("");

  return (
    <div className="divide-y divide-border/60 rounded-xl border border-border/60">
      <div className={row}>
        <label htmlFor={`${id}-repeat`}>{text("重复执行任务", "Repeat task")}</label>
        <Switch
          id={`${id}-repeat`}
          checked={!once}
          onCheckedChange={(repeat) => {
            if (!repeat) repeatedCount.current = remaining;
            onRemaining(repeat ? repeatedCount.current : "1");
          }}
        />
      </div>
      {once ? (
        <p className="px-3 py-2.5 text-xs text-muted-foreground">
          {text("仅在下次匹配的时间执行。", "Runs only at the next matching time.")}
        </p>
      ) : (
        <div className={row}>
          <label htmlFor={`${id}-end`}>{text("结束重复", "End repeat")}</label>
          <Select
            value={endMode}
            onValueChange={(value) => {
              if (value) onRemaining(value === "count" ? remaining || "2" : "");
            }}
          >
            <SelectTrigger id={`${id}-end`} variant="plain" className={trigger}>
              <SelectValue>
                {remaining ? text("按次数", "After a number of runs") : text("永不", "Never")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="never">{text("永不", "Never")}</SelectItem>
              <SelectItem value="count">{text("按次数", "After a number of runs")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      {!once && endMode === "count" && (
        <div className={row}>
          <label htmlFor={`${id}-count`}>{t("settings.cronRemainingExecutions")}</label>
          <Input
            id={`${id}-count`}
            type="number"
            min={0}
            value={remaining}
            className="w-24 text-right"
            onChange={(event) => {
              if (/^\d+$/.test(event.currentTarget.value)) onRemaining(event.currentTarget.value);
            }}
          />
        </div>
      )}
    </div>
  );
}
