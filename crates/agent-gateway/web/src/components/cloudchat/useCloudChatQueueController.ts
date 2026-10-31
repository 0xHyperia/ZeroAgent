import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  type CloudChatQueueClient,
  CloudChatQueueController,
  type CloudChatQueueHost,
  cloudChatQueuedPreviews,
} from "@/lib/cloudChatQueueController";
import type { CloudChatRun } from "@/lib/cloudChatRuns";

type Options = CloudChatQueueHost & {
  userId: number;
  conversationId: string;
  client: CloudChatQueueClient;
  activeRun: CloudChatRun | null;
  /** An unresolved ordinary send/upload or other host gate prevents dispatch. */
  blocked?: boolean;
};

/** Retains uncertain identities across conversation navigation, never across accounts. */
export function useCloudChatQueueController(options: Options) {
  const owner = useRef(options.userId);
  const controllers = useRef(new Map<string, CloudChatQueueController>());
  if (owner.current !== options.userId) {
    // Invalidate synchronously, but never notify the previous owner's React subscriber
    // while the replacement account is rendering. Effect cleanup detaches it next.
    for (const controller of controllers.current.values()) controller.suspend(false);
    controllers.current.clear();
    owner.current = options.userId;
  }
  let controller = controllers.current.get(options.conversationId);
  if (!controller) {
    controller = new CloudChatQueueController(options.conversationId, options.client, options);
    controllers.current.set(options.conversationId, controller);
  }
  controller.setClient(options.client);
  controller.setHost(options);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    if (options.userId > 0 && options.conversationId) controller.activate();
    return () => controller.suspend();
  }, [controller, options.userId, options.conversationId]);
  useEffect(() => {
    controller.setRuntime(options.activeRun, !!options.blocked);
  }, [controller, options.activeRun, options.blocked]);
  return {
    ...state,
    items: state.queue?.items ?? [],
    queuedPreviews: cloudChatQueuedPreviews(state.queue?.items ?? []),
    refresh: controller.refresh,
    enqueue: controller.enqueue,
    beginEdit: controller.beginEdit,
    saveEdit: controller.saveEdit,
    cancelEdit: controller.cancelEdit,
    remove: controller.remove,
    reorder: controller.reorder,
    moveUp: controller.moveUp,
    runNow: controller.runNow,
    pause: controller.pause,
    resume: controller.resume,
    reconcileUnknown: controller.reconcileUnknown,
  };
}
