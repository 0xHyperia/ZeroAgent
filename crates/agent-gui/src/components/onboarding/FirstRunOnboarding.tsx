import "@liveagent/ui/i18n/namespaces/settings";
import { Check, Circle, Loader2 } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useState } from "react";

type FirstRunOnboardingProps = {
  userId: number;
  autoOpen: boolean;
  requested: boolean;
  hasModel: boolean;
  projectName: string;
  onClose: () => void;
  onConfigureModels: () => void;
  onChooseProject: () => Promise<void>;
};

function completed(userId: number) {
  try {
    return localStorage.getItem(`zeroagent.onboarding.v1.${userId}`) === "complete";
  } catch {
    return false;
  }
}

export function FirstRunOnboarding({
  userId,
  autoOpen,
  requested,
  hasModel,
  projectName,
  onClose,
  onConfigureModels,
  onChooseProject,
}: FirstRunOnboardingProps) {
  const { t } = useLocale();
  const [seen, setSeen] = useState(() => completed(userId));
  const [picking, setPicking] = useState(false);
  const [projectError, setProjectError] = useState(false);
  const open = requested || (autoOpen && !seen);

  function dismiss() {
    setSeen(true);
    setProjectError(false);
    try {
      localStorage.setItem(`zeroagent.onboarding.v1.${userId}`, "complete");
    } catch {}
    onClose();
  }

  async function chooseProject() {
    if (picking) return;
    setPicking(true);
    setProjectError(false);
    try {
      await onChooseProject();
    } catch {
      setProjectError(true);
    } finally {
      setPicking(false);
    }
  }

  const modelIcon = hasModel ? <Check className="size-4" /> : <Circle className="size-4" />;
  const projectIcon = projectName ? <Check className="size-4" /> : <Circle className="size-4" />;
  return (
    <Dialog open={open} onOpenChange={(value) => !value && !picking && dismiss()}>
      <DialogContent className="max-w-lg" data-testid="desktop-setup-guide">
        <DialogHeader>
          <DialogTitle>{t("settings.setupGuide.title")}</DialogTitle>
          <DialogDescription>{t("settings.setupGuide.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <ul className="divide-y divide-border rounded-lg border border-border">
            <li className="flex items-center gap-3 p-3">
              <Check aria-hidden="true" className="size-4 shrink-0 text-success" />
              <div>
                <p className="text-sm font-medium">{t("settings.setupGuide.account")}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("settings.setupGuide.accountReady")}
                </p>
              </div>
            </li>
            <li className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="flex min-w-0 items-center gap-3">
                <span aria-hidden="true" className="shrink-0 text-muted-foreground">
                  {modelIcon}
                </span>
                <div>
                  <p className="text-sm font-medium">{t("settings.setupGuide.model")}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t(
                      hasModel
                        ? "settings.setupGuide.modelReady"
                        : "settings.setupGuide.modelMissing",
                    )}
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={picking}
                onClick={() => {
                  dismiss();
                  onConfigureModels();
                }}
              >
                {t("settings.setupGuide.configureModels")}
              </Button>
            </li>
            <li className="space-y-2 p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span aria-hidden="true" className="shrink-0 text-muted-foreground">
                    {projectIcon}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{t("settings.setupGuide.project")}</p>
                    <p className="mt-1 truncate text-xs text-muted-foreground" title={projectName}>
                      {projectName || t("settings.setupGuide.projectMissing")}
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={picking}
                  onClick={() => void chooseProject()}
                >
                  {picking ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                  {t("settings.setupGuide.chooseProject")}
                </Button>
              </div>
              {projectError ? (
                <p role="alert" className="text-xs text-destructive">
                  {t("settings.setupGuide.projectError")}
                </p>
              ) : null}
            </li>
          </ul>
        </DialogBody>
        <DialogFooter>
          <Button variant={hasModel ? "default" : "outline"} disabled={picking} onClick={dismiss}>
            {t(hasModel ? "settings.setupGuide.done" : "settings.setupGuide.skip")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
