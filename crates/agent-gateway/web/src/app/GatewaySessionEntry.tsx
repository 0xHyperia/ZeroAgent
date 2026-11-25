import { type ReactNode, useState } from "react";
import { getDesktopRemoteHost } from "@/lib/desktopRemoteHost";
import { parseHistoryShareToken } from "@/lib/historyShare";
import { AccountLoginPage } from "@/pages/AccountLoginPage";
import { useGatewaySession } from "./hooks/useGatewaySession";

export type GatewaySession = ReturnType<typeof useGatewaySession>;

export function GatewayStartupStatus({ label }: { label: string }) {
  return (
    <main
      className="app-auth-restoring flex min-h-dvh w-full min-w-0 flex-1 items-center justify-center bg-background"
      role="status"
      aria-label={label}
    >
      <img
        src="/zeroagent-logo.png"
        alt=""
        width={48}
        height={48}
        className="h-12 w-12 shrink-0 animate-pulse"
        draggable={false}
      />
    </main>
  );
}

export function GatewaySessionEntry({
  children,
}: {
  children: (session: GatewaySession, historyShareToken: string | null) => ReactNode;
}) {
  const [historyShareToken] = useState(() =>
    getDesktopRemoteHost() ? null : parseHistoryShareToken(),
  );
  const session = useGatewaySession(historyShareToken);
  if (historyShareToken) return children(session, historyShareToken);
  if (session.authInitializing) {
    return <GatewayStartupStatus label="正在恢复登录状态" />;
  }
  if (!session.accountUser) {
    return (
      <AccountLoginPage
        error={session.authError}
        isSubmitting={session.authSubmitting}
        twoFactorRequired={session.twoFactorRequired}
        onSubmit={(email, password) => void session.login(email, password)}
        onRegister={(input) => void session.register(input)}
        onSubmitTwoFactor={(code) => void session.verifyTwoFactor(code)}
        onClearError={() => session.setAuthError(null)}
        onSetError={session.setAuthError}
      />
    );
  }
  return children(session, null);
}
