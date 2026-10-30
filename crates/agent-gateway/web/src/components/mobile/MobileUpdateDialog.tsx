import { Download, Loader2 } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@liveagent/ui/components/ui/dialog";
export type MobileUpdateDetails = {
  currentVersion: string;
  version: string;
  title: string;
  notes: string;
};

export function MobileUpdateDialog({
  update,
  open,
  downloading,
  onClose,
  onDownload,
}: {
  update: MobileUpdateDetails | null;
  open: boolean;
  downloading: boolean;
  onClose: () => void;
  onDownload: () => void;
}) {
  return (
    <Dialog open={Boolean(update && open)} onOpenChange={(next) => !next && onClose()}>
      {update ? (
        <DialogContent
          layout="bottom-sheet-mobile"
          className="mobile-update-sheet"
          closeDisabled={downloading}
          closeLabel="稍后更新"
          showCloseButton
        >
          <div className="min-w-0 pr-10">
            <p className="text-xs font-medium text-primary">发现新版本 v{update.version}</p>
            <DialogTitle className="mt-1 truncate text-base leading-normal">
              {update.title}
            </DialogTitle>
            <p className="mt-1 text-xs text-muted-foreground">当前版本 v{update.currentVersion}</p>
          </div>
          <div className="mobile-update-notes">{update.notes}</div>
          <div className="mt-5 flex gap-3">
            <Button
              type="button"
              variant="outline"
              className="h-11 flex-1"
              disabled={downloading}
              onClick={onClose}
            >
              稍后
            </Button>
            <Button
              type="button"
              className="h-11 flex-[1.5] gap-2"
              disabled={downloading}
              onClick={onDownload}
            >
              {downloading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {downloading ? "正在打开" : "下载更新"}
            </Button>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
