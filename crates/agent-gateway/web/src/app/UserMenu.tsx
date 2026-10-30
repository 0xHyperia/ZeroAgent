import { ChevronUp, LogOut, RefreshCw, Settings, User } from "@liveagent/ui/components/IconSet";
import { AccountAvatar, AccountIdentity } from "@liveagent/ui/components/ui/account-identity";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { TooltipButton as Button } from "@liveagent/ui/components/ui/tooltip-button";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useRef } from "react";
import { requestMobileAppUpdateCheck } from "@/lib/mobileAppUpdate";
import { isEmbeddedMobileRuntime } from "@/lib/mobileRuntime";

type UserMenuProps = {
  variant?: "sidebar" | "rail";
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
    variant = "sidebar",
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
  const rail = variant === "rail";
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

  const avatar = <AccountAvatar label={userAvatarLabel} avatarUrl={avatarUrl} />;
  const itemClassName = rail ? "min-h-10 gap-3 rounded-xl px-3 font-normal" : "gap-2 rounded-md";

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            className={cn(
              "account-user-menu-trigger min-w-0 text-foreground shadow-none hover:bg-foreground/[0.08]",
              rail
                ? "application-rail-item size-10 shrink-0 justify-center rounded-xl p-0 data-[popup-open]:bg-foreground/[0.08]"
                : "h-11 w-full justify-start gap-2.5 rounded-lg px-2",
            )}
            title={t("account.userMenu")}
            aria-label={t("account.userMenu")}
          />
        }
      >
        {avatar}
        {!rail ? (
          <>
            <span className="account-user-menu-details min-w-0 flex-1 truncate text-left text-[calc(13px*var(--zone-font-scale,1))] font-medium">
              {userMenuLabel}
            </span>
            <ChevronUp className="account-user-menu-chevron h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={rail ? "right" : "top"}
        align={rail ? "end" : "start"}
        sideOffset={8}
        collisionPadding={12}
        variant="soft"
        className={
          rail
            ? "cloud-account-menu w-72 max-w-[calc(100vw-24px)] rounded-2xl p-2 outline-none"
            : "w-72 max-w-[calc(100vw-24px)] p-2 outline-none"
        }
      >
        {rail ? (
          <>
            <DropdownMenuItem
              onSelect={handleOpenAccount}
              aria-label={t("settings.navAccount")}
              className="min-h-14 gap-3 rounded-xl px-3 py-2"
            >
              <AccountIdentity
                name={userMenuLabel}
                description={t("settings.navAccount")}
                avatar={avatar}
              />
            </DropdownMenuItem>
            <DropdownMenuSeparator className="mx-2 my-1.5" />
          </>
        ) : (
          <DropdownMenuItem onSelect={handleOpenAccount} className={itemClassName}>
            <User className="h-4 w-4" />
            {t("settings.navAccount")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={handleOpenSettings} className={itemClassName}>
          <Settings className="h-4 w-4" />
          {t("tooltip.settings")}
        </DropdownMenuItem>
        {isEmbeddedMobileRuntime() ? (
          <DropdownMenuItem onSelect={handleCheckForUpdates} className={itemClassName}>
            <RefreshCw className="h-4 w-4" />
            {t("app.checkForUpdates")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator className={rail ? "mx-2 my-1.5" : undefined} />
        <DropdownMenuItem
          onSelect={onLogout}
          className={
            rail
              ? itemClassName
              : cn(itemClassName, "text-destructive focus:bg-destructive/10 focus:text-destructive")
          }
        >
          <LogOut className="h-4 w-4" />
          {t("common.logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
