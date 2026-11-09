import { createContext } from "react";

export type ConversationImageComposerEdit = {
  value: string;
  label: string;
  placeholder: string;
  sendLabel: string;
  pending: boolean;
  canSend: boolean;
  hidden?: boolean;
  stoppingRun?: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
};

export const ConversationFocusComposer = createContext<{
  target: HTMLElement | null;
  setTarget: (element: HTMLElement | null) => void;
  edit: ConversationImageComposerEdit | null;
  setEdit: (edit: ConversationImageComposerEdit | null) => void;
} | null>(null);

export const ConversationReaderLayout = createContext<{
  expanded: boolean;
  canSplit: boolean;
  toggleExpanded: () => void;
} | null>(null);
