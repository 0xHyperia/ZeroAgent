import { CLOUD_FILE_ACCEPT, CLOUD_FILE_MAX_BYTES } from "./cloudChatFiles";

/** Preflight is feedback only; the file service remains the authority. */
export function prepareCloudFileBatch(
  files: File[],
  limit: number,
  directories = 0,
  locale: "zh-CN" | "en-US" = "zh-CN",
) {
  const text = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
  const accepted: File[] = [],
    rejected: string[] = [];
  const extensions = CLOUD_FILE_ACCEPT.split(",");
  if (directories)
    rejected.push(
      text("暂不支持拖入文件夹，请选择其中的文件。", "Select individual files from the folder."),
    );
  for (const file of files) {
    if (file.size > CLOUD_FILE_MAX_BYTES)
      rejected.push(text(`${file.name}超过单个文件32 MiB的限制。`, `${file.name} exceeds 32 MiB.`));
    else if (!extensions.some((extension) => file.name.toLowerCase().endsWith(extension)))
      rejected.push(
        text(`${file.name}的格式暂不支持上传。`, `${file.name} is in an unsupported format.`),
      );
    else if (accepted.length >= limit)
      rejected.push(
        text(
          `本次最多添加${limit}个文件，其余文件尚未上传。`,
          `Up to ${limit} files can be added at once.`,
        ),
      );
    else accepted.push(file);
  }
  return { files: accepted, message: [...new Set(rejected)].slice(0, 5).join(" ") };
}
