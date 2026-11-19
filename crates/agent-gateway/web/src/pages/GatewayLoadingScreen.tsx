import { cn } from "@liveagent/ui/lib/shared/utils";
import type { ReactNode } from "react";
import {
  GATEWAY_CHAT_FRAME_CLASS,
  GATEWAY_EMBEDDED_SHELL_CLASS,
  GATEWAY_MAIN_BACKDROP_CLASS,
  GATEWAY_MAIN_SHELL_CLASS,
  GATEWAY_SHELL_CLASS,
} from "@/lib/webStyleClasses";

export function GatewayLoadingScreen({
  children,
  embedded = false,
}: {
  children: ReactNode;
  embedded?: boolean;
}) {
  return (
    <div className={embedded ? GATEWAY_EMBEDDED_SHELL_CLASS : GATEWAY_SHELL_CLASS}>
      <main className={GATEWAY_MAIN_SHELL_CLASS}>
        <div className={GATEWAY_MAIN_BACKDROP_CLASS} />
        <div
          className={cn(
            GATEWAY_CHAT_FRAME_CLASS,
            "relative flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center px-4",
          )}
        >
          {children}
        </div>
      </main>
    </div>
  );
}

export function GatewayLoadingCard({ label }: { label: string }) {
  return (
    <div
      className={cn(
        "relative z-1 flex max-w-full flex-col items-center gap-18px overflow-hidden text-center",
        "rounded-24px border border-solid border-white/70 bg-white/55",
        "px-46px pt-38px pb-32px",
        "shadow-login-container backdrop-blur-40px backdrop-saturate-160",
        "dark:border-white/8 dark:bg-hsl-224-20-12-0p6 dark:shadow-login-container-2",
      )}
      role="status"
      aria-live="polite"
    >
      <div
        className={cn(
          "pointer-events-none absolute top-minus-80px left-minus-64px -z-1 size-200px",
          "rounded-full bg-hsl-210-100-86-0p55 opacity-(--ui-opacity-0p55) blur-60px dark:bg-hsl-210-80-32-0p25",
        )}
        aria-hidden="true"
      />
      <div
        className={cn(
          "pointer-events-none absolute right-minus-54px bottom-minus-72px -z-1 size-170px",
          "rounded-full bg-hsl-250-70-86-0p45 opacity-(--ui-opacity-0p55) blur-60px dark:bg-hsl-250-60-32-0p2",
        )}
        aria-hidden="true"
      />

      <div className="relative flex items-center justify-center size-60px mt-2px">
        <div className="relative flex size-60px items-center justify-center">
          <img
            src="/zeroagent-logo.png"
            alt=""
            width={60}
            height={60}
            className="block size-60px drop-shadow-sync-loading-logo select-none"
            draggable={false}
          />
        </div>
      </div>

      <strong className="text-sm font-semibold tracking-minus-0p01em text-foreground">
        {label}
      </strong>

      <span
        className={cn(
          "inline-flex h-8px items-center gap-6px",
          "[&>i]:size-7px [&>i]:animate-[syncDotBounce_var(--ui-duration-1200ms)_ease-in-out_infinite] [&>i]:rounded-full [&>i]:bg-primary [&>i]:will-change-[transform,opacity] motion-reduce:[&>i]:animate-none [&>i:nth-child(2)]:[animation-delay:var(--ui-duration-160ms)] [&>i:nth-child(3)]:[animation-delay:var(--ui-duration-320ms)]",
        )}
        aria-hidden="true"
      >
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}
