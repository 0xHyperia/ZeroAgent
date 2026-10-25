import { ChevronUp, LogOut, RefreshCw, Settings, User } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useRef } from "react";
import { requestMobileAppUpdateCheck } from "@/lib/mobileAppUpdate";
import { isEmbeddedMobileRuntime } from "@/lib/mobileRuntime";

type UserMenuProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userMenuLabel: string;
  userAvatarLabel: string;
  email: string;
  balance?: number;
  todayTokens?: number;
  avatarUrl?: string;
  online: boolean;
  onRefreshAccount: () => Promise<void>;
  onDismissNavigation: () => void;
  onOpenAccount: () => void;
  onOpenSettings: () => void;
  onLogout: () => void;
};

export function UserMenu(props: UserMenuProps) {
  const { t } = useLocale();
  const {
    open,
    onOpenChange,
    userMenuLabel,
    userAvatarLabel,
    avatarUrl,
    onRefreshAccount,
    onDismissNavigation,
    onOpenAccount,
    onOpenSettings,
    onLogout,
  } = props;
  const refreshInFlightRef = useRef(false);

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen || refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    void onRefreshAccount()
      .catch(() => {
        // Keep the cached account values when the refresh is temporarily unavailable.
      })
      .finally(() => {
        refreshInFlightRef.current = false;
      });
  };

  const dismissNavigation = () => {
    onOpenChange(false);
    onDismissNavigation();
  };

  const handleOpenSettings = () => {
    dismissNavigation();
    onOpenSettings();
  };

  const handleOpenAccount = () => {
    dismissNavigation();
    onOpenAccount();
  };

  const handleCheckForUpdates = () => {
    dismissNavigation();
    requestMobileAppUpdateCheck();
  };

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            className="account-user-menu-trigger h-11 w-full min-w-0 justify-start gap-2.5 rounded-lg px-2 text-foreground shadow-none hover:bg-foreground/[0.08]"
            title={t("account.userMenu")}
          />
        }
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-foreground text-[calc(11px*var(--zone-font-scale,1))] font-semibold text-background">
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            userAvatarLabel || <User className="h-3.5 w-3.5" />
          )}
        </span>
        <span className="account-user-menu-details min-w-0 flex-1 truncate text-left text-[calc(13px*var(--zone-font-scale,1))] font-medium">
          {userMenuLabel}
        </span>
        <ChevronUp className="account-user-menu-chevron h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[224px] rounded-lg border-border/70 bg-popover/95 p-1.5 shadow-xl backdrop-blur supports-[backdrop-filter]:bg-popover/90"
      >
        <DropdownMenuItem onSelect={handleOpenAccount} className="gap-2 rounded-md">
          <User className="h-4 w-4" />
          {t("settings.navAccount")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleOpenSettings} className="gap-2 rounded-md">
          <Settings className="h-4 w-4" />
          {t("tooltip.settings")}
        </DropdownMenuItem>
        {isEmbeddedMobileRuntime() ? (
          <DropdownMenuItem onSelect={handleCheckForUpdates} className="gap-2 rounded-md">
            <RefreshCw className="h-4 w-4" />
            {t("app.checkForUpdates")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onLogout}
          className="gap-2 rounded-md text-destructive focus:bg-destructive/10 focus:text-destructive"
        >
          <LogOut className="h-4 w-4" />
          {t("common.logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
