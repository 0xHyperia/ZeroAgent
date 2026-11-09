import { createContext } from "react";

export const WorkbenchBrowserLink = createContext<((url: string) => void) | null>(null);

export function workbenchBrowserLinkUrl(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
