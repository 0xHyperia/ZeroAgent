import { cn } from "../../lib/shared/utils";
import { User } from "../IconSet";

/** Display-only account identity; refresh, credentials and logout stay in the host. */
export function AccountAvatar({
  label,
  avatarUrl,
  className,
}: {
  label: string;
  avatarUrl?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "account-user-avatar inline-flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-foreground text-xs font-semibold text-background",
        className,
      )}
      aria-hidden="true"
    >
      {avatarUrl ? (
        <img src={avatarUrl} alt="" className="size-full object-cover" />
      ) : (
        label || <User className="size-3.5" />
      )}
    </span>
  );
}

export function AccountIdentity({
  name,
  description,
  avatar,
}: {
  name: string;
  description: string;
  avatar: ReactNode;
}) {
  return (
    <>
      <span className="shrink-0">{avatar}</span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="block truncate text-xs font-normal text-muted-foreground">
          {description}
        </span>
      </span>
    </>
  );
}

import type { ReactNode } from "react";
