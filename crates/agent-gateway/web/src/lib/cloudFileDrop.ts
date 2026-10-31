import { CLOUD_FILE_ACCEPT, CLOUD_FILE_MAX_BYTES } from "./cloudChatFiles";

/** Preflight is feedback only; the file service remains the authority. */
export function prepareCloudFileBatch(files: File[], limit: number, directories = 0) {
  const accepted: File[] = [],
    rejected: string[] = [];
  const extensions = CLOUD_FILE_ACCEPT.split(",");
  if (directories) rejected.push("暂不支持拖入文件夹，请选择其中的文件。");
  for (const file of files) {
    if (file.size > CLOUD_FILE_MAX_BYTES) rejected.push(`${file.name}超过单个文件32 MiB的限制。`);
    else if (!extensions.some((extension) => file.name.toLowerCase().endsWith(extension)))
      rejected.push(`${file.name}的格式暂不支持上传。`);
    else if (accepted.length >= limit)
      rejected.push(`本次最多添加${limit}个文件，其余文件尚未上传。`);
    else accepted.push(file);
  }
  return { files: accepted, message: [...new Set(rejected)].slice(0, 5).join(" ") };
}
