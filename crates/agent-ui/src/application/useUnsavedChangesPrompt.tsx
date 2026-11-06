import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";

/** A discarded draft never authorizes navigation captured under another account. */
export function useUnsavedChangesPrompt(scope: string | number) {
  const dirty = useRef(false);
  const currentScope = useRef(scope);
  const pending = useRef<{ scope: string | number; action: () => void } | null>(null);
  const [open, setOpen] = useState(false);
  currentScope.current = scope;
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new account scope retires pending navigation and draft ownership.
  useEffect(() => {
    dirty.current = false;
    pending.current = null;
    setOpen(false);
  }, [scope]);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (!dirty.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, []);
  const setDirty = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);
  const isDirty = useCallback(() => dirty.current, []);
  const request = useCallback((action: () => void) => {
    if (!dirty.current) {
      action();
      return;
    }
    pending.current = { scope: currentScope.current, action };
    setOpen(true);
  }, []);
  return {
    setDirty,
    isDirty,
    request,
    dialog: (
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) pending.current = null;
          setOpen(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>保留项目修改？</AlertDialogTitle>
            <AlertDialogDescription>
              项目中还有未保存的内容。你可以继续编辑，或放弃本次修改后离开。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                pending.current = null;
                setOpen(false);
              }}
            >
              继续编辑
            </Button>
            <Button
              onClick={() => {
                const navigation = pending.current;
                pending.current = null;
                setOpen(false);
                if (navigation?.scope !== currentScope.current) return;
                dirty.current = false;
                navigation.action();
              }}
            >
              放弃修改并离开
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    ),
  };
}
