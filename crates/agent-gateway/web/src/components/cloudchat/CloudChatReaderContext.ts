import { createContext } from "react";

// Keep context identity independent of component hot updates. A reader must never
// fall back to a modal because its provider and consumer refreshed separately.
export const CloudChatResourcePresentation = createContext<"panel" | "page" | "inline">("panel");
export const CloudChatReaderLayout = createContext<{
  expanded: boolean;
  canSplit: boolean;
  toggleExpanded: () => void;
} | null>(null);
