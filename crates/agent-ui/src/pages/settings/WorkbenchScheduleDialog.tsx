import type { ComponentProps } from "react";
import { DialogContent } from "../../components/ui/dialog";

export function WorkbenchScheduleDialog(props: Omit<ComponentProps<typeof DialogContent>, "ref">) {
  return (
    <DialogContent
      {...props}
      layout="fullscreen-mobile"
      showCloseButton
      className="flex max-h-[min(90dvh,760px)] flex-col overflow-hidden max-[720px]:max-h-none sm:max-w-[38rem]"
    />
  );
}
