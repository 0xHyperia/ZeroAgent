import { useContext, useState } from "react";
import { useLocale } from "../../../i18n";
import type { ToolResultMessage } from "../../../lib/chat/agentTypes";
import type { AssistantDeliverable } from "../../../lib/chat/assistantResources";
import { toolResultMessageToText } from "../../../lib/chat/uiMessages";
import { Button } from "../../ui/button";
import { StatusNotice } from "../../ui/status-notice";
import {
  AssistantImageGallery,
  AssistantVisualContext,
  VisualCreationPending,
  VisualCreationSettingsNotice,
} from "../AssistantVisuals";

type ImageResult = { status: string; assetIds: string[]; jobId?: string };

export function parseConversationImageResult(output: string): ImageResult {
  try {
    const wire = JSON.parse(output.trimStart().split("\n", 1)[0] ?? "");
    if (typeof wire?.status === "string") {
      return {
        status: wire.status,
        jobId:
          typeof wire.job_id === "string" && /^ij_[\w-]{1,96}$/.test(wire.job_id)
            ? wire.job_id
            : undefined,
        assetIds: Array.isArray(wire.asset_ids)
          ? [
              ...new Set<string>(
                wire.asset_ids.filter(
                  (id: unknown) => typeof id === "string" && /^ia_[\w-]{1,96}$/.test(id),
                ),
              ),
            ].slice(0, 8)
          : [],
      };
    }
  } catch {
    // Unexpected or interrupted tool output has no authorized gallery.
  }
  return { status: "failed", assetIds: [] };
}

export function conversationImageDeliverables(
  result: ImageResult,
  zh: boolean,
): AssistantDeliverable[] {
  if (result.status !== "succeeded" && result.status !== "partial_succeeded") return [];
  return result.assetIds.map((id, index) => ({
    id,
    kind: "artifact",
    role: "output",
    status: "saved",
    name: zh ? `生成图像 ${index + 1}` : `Generated image ${index + 1}`,
    link: { path: id, source: "relative" },
  }));
}

export function ConversationImageTool({
  result,
  running,
}: {
  result?: ToolResultMessage;
  running: boolean;
}) {
  const host = useContext(AssistantVisualContext);
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const [checked, setChecked] = useState<(ImageResult & { jobId: string }) | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  if (!host?.openImage) return null;
  if (!result) return running ? <VisualCreationPending /> : null;
  const original = parseConversationImageResult(toolResultMessageToText(result));
  const view = checked?.jobId && checked.jobId === original.jobId ? checked : original;
  const openImage = host.openImage;
  const items = conversationImageDeliverables(view, zh);
  if (items.length) return <AssistantImageGallery items={items} onOpen={openImage} />;
  if (view.status === "already_requested") return null;
  if (view.status === "needs_configuration" || view.status === "model_unavailable") {
    return (
      <VisualCreationSettingsNotice
        message={
          view.status === "needs_configuration"
            ? zh
              ? "请先选择默认生图模型"
              : "Choose a default image model"
            : zh
              ? "生图模型暂不可用"
              : "The image model is unavailable"
        }
        description={
          zh
            ? "设置完成后，回到当前对话继续创作。"
            : "Return to this conversation after choosing a model."
        }
        onConfigure={host.configureImage}
      />
    );
  }
  const jobId = original.jobId;
  const checkImage = host.checkImage;
  if (
    jobId &&
    checkImage &&
    ["result_unknown", "queued", "running", "saving", "cancel_requested"].includes(view.status)
  ) {
    return (
      <StatusNotice
        compact
        tone="info"
        message={
          checkFailed
            ? zh
              ? "暂时无法核对生图结果"
              : "Could not check the image result"
            : zh
              ? "生图结果尚未确认"
              : "Image result is unconfirmed"
        }
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={checking}
            onClick={() => {
              setChecking(true);
              setCheckFailed(false);
              void checkImage(jobId)
                .then((job) => setChecked({ jobId, ...job }))
                .catch(() => setCheckFailed(true))
                .finally(() => setChecking(false));
            }}
          >
            {zh ? "核对结果" : "Check result"}
          </Button>
        }
      />
    );
  }
  let label = zh ? "图像生成失败" : "Image generation failed";
  if (view.status === "cancelled") label = zh ? "已停止生成图像" : "Image generation stopped";
  if (view.status === "unsupported_edit")
    label = zh ? "所选模型不支持修改图像" : "The selected model does not support image edits";
  if (view.status === "reference_unavailable")
    label = zh
      ? "参考图暂不可用，请重新添加要修改的图片"
      : "The reference is unavailable. Attach the image you want to edit again.";
  return <StatusNotice compact tone="info" message={label} />;
}
