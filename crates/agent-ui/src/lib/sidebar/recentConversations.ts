import type { SidebarConversation } from "./types";

/** Project conversations belong in the canonical workspace tree. Unscoped tasks remain reachable
 * in Recent; pinned tasks are already rendered by the shared pinned section in project mode. */
export function selectRecentSidebarConversations(
  items: readonly SidebarConversation[],
  showProjects: boolean,
): readonly SidebarConversation[] {
  return showProjects ? items.filter((item) => !item.cwd?.trim() && !item.isPinned) : items;
}
