import { ChevronUp, LogOut, Settings, User } from "@liveagent/ui/components/IconSet";
import { AccountAvatar, AccountIdentity } from "@liveagent/ui/components/ui/account-identity";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { TooltipButton as Button } from "@liveagent/ui/components/ui/tooltip-button";
import { useRef, useState } from "react";
import type { RelayDashboardStats, RelayUser } from "../../lib/relay/client";

type UserMenuProps = {
  variant?: "sidebar" | "rail";
  user: RelayUser;
  stats: RelayDashboardStats | null;
  onRefreshAccount: () => Promise<void>;
  onOpenAccount: () => void;
  onOpenSettings: () => void;
  onLogout: () => Promise<void>;
};

export function UserMenu({
  variant = "sidebar",
  user,
  onRefreshAccount,
  onOpenAccount,
  onOpenSettings,
  onLogout,
}: UserMenuProps) {
  const refreshInFlightRef = useRef(false);
  const logoutInFlightRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutFailed, setLogoutFailed] = useState(false);
  const displayName = user.username?.trim() || user.email.split("@")[0] || `用户 ${user.id}`;
  const avatarLabel = displayName.slice(0, 1).toUpperCase();
  const rail = variant === "rail";
  const avatar = <AccountAvatar label={avatarLabel} avatarUrl={user.avatar_url || undefined} />;

  const handleOpenChange = (open: boolean) => {
    setOpen(open);
    if (!open || refreshInFlightRef.current || logoutInFlightRef.current) return;
    refreshInFlightRef.current = true;
    void onRefreshAccount()
      .catch(() => undefined)
      .finally(() => {
        refreshInFlightRef.current = false;
      });
  };

  const handleLogout = async () => {
    if (logoutInFlightRef.current) return;
    logoutInFlightRef.current = true;
    setLoggingOut(true);
    setLogoutFailed(false);
    try {
      await onLogout();
      setOpen(false);
    } catch {
      setLogoutFailed(true);
    } finally {
      logoutInFlightRef.current = false;
      setLoggingOut(false);
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            className={
              rail
                ? "application-rail-item size-10 shrink-0 rounded-xl p-0 text-foreground"
                : "h-11 w-full min-w-0 justify-start gap-2.5 rounded-lg px-2 text-foreground shadow-none hover:bg-foreground/[0.08]"
            }
            title="用户菜单"
            aria-label="用户菜单"
          />
        }
      >
        {avatar}
        {!rail ? (
          <>
            <span className="min-w-0 flex-1 truncate text-left text-[calc(13px*var(--zone-font-scale,1))] font-medium">
              {displayName}
            </span>
            <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={rail ? "right" : "top"}
        align={rail ? "end" : "start"}
        sideOffset={8}
        collisionPadding={12}
        className="w-72 max-w-[calc(100vw-24px)] p-2 outline-none"
      >
        {rail ? (
          <>
            <DropdownMenuItem
              onSelect={onOpenAccount}
              aria-label="账户"
              className="min-h-14 gap-3 px-3 py-2"
            >
              <AccountIdentity name={displayName} description={user.email} avatar={avatar} />
            </DropdownMenuItem>
            <DropdownMenuSeparator className="mx-2 my-1.5" />
          </>
        ) : null}
        <DropdownMenuItem onSelect={onOpenAccount} className="gap-2 rounded-md">
          <User className="h-4 w-4" />
          账户
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onOpenSettings} className="gap-2 rounded-md">
          <Settings className="h-4 w-4" />
          设置
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={loggingOut}
          closeOnClick={false}
          onSelect={() => void handleLogout()}
          className="gap-2 rounded-md text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive"
        >
          <LogOut className="h-4 w-4" />
          {loggingOut ? "正在退出…" : logoutFailed ? "重试退出" : "退出账户"}
        </DropdownMenuItem>
        {logoutFailed && (
          <p role="alert" className="px-2.5 py-2 text-xs text-destructive">
            退出未完成，请重试。如系统钥匙串或凭据管理器已锁定，请先解锁。
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
