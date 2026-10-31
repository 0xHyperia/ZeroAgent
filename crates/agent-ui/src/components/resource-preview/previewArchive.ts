import { Unzip, UnzipInflate } from "fflate";

export type PreviewArchiveEntry = { name: string; size: number; directory: boolean };
const MAX_ENTRIES = 2000;
const MAX_EXPANDED_BYTES = 96 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;

/** Streaming validation checks actual expanded bytes as well as central metadata.
 * Runs in a terminable worker for uploaded files. Nothing is written to disk. */
export function inspectPreviewArchive(bytes: Uint8Array): PreviewArchiveEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  const minimum = Math.max(0, bytes.length - 65557);
  while (end >= minimum && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < minimum || end + 22 + view.getUint16(end + 20, true) !== bytes.length)
    throw new Error("压缩文件目录损坏。");
  const count = view.getUint16(end + 10, true);
  if (
    view.getUint32(end + 4, true) !== 0 ||
    count !== view.getUint16(end + 8, true) ||
    count > MAX_ENTRIES ||
    count === 65535
  )
    throw new Error("压缩文件分卷或条目数量不受支持。");
  let offset = view.getUint32(end + 16, true);
  const entries = new Map<string, PreviewArchiveEntry>();
  let declaredTotal = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50)
      throw new Error("压缩文件目录不完整。");
    const flags = view.getUint16(offset + 8, true);
    const size = view.getUint32(offset + 24, true);
    const length = view.getUint16(offset + 28, true);
    const next =
      offset + 46 + length + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    if (next > end || flags & 1 || size === 0xffffffff)
      throw new Error("加密或 ZIP64 文件暂不支持在线预览。");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(offset + 46, offset + 46 + length),
    );
    if (
      !name ||
      name.length > 512 ||
      /[\\:]/.test(name) ||
      [...name].some((character) => character.charCodeAt(0) < 32) ||
      name.startsWith("/") ||
      name.split("/").some((part) => part === ".." || part === ".") ||
      entries.has(name)
    )
      throw new Error("压缩文件包含无效或重复路径。");
    declaredTotal += size;
    if (size > MAX_ENTRY_BYTES || declaredTotal > MAX_EXPANDED_BYTES)
      throw new Error("文件展开后较大，请下载原件查看。");
    entries.set(name, { name, size, directory: name.endsWith("/") });
    offset = next;
  }
  let actualTotal = 0;
  const finished = new Set<string>();
  const started = new Set<string>();
  const unzip = new Unzip((file) => {
    const entry = entries.get(file.name);
    if (!entry || started.has(file.name)) throw new Error("压缩文件本地目录不一致。");
    started.add(file.name);
    let actual = 0;
    file.ondata = (error, data, final) => {
      if (error) throw error;
      actual += data.length;
      actualTotal += data.length;
      if (actual > entry.size || actual > MAX_ENTRY_BYTES || actualTotal > MAX_EXPANDED_BYTES)
        throw new Error("压缩文件实际大小超过预览限制。");
      if (final) {
        if (actual !== entry.size) throw new Error("压缩文件内容不完整。");
        finished.add(file.name);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let start = 0; start < bytes.length; start += 16384)
    unzip.push(bytes.subarray(start, start + 16384), start + 16384 >= bytes.length);
  if (finished.size !== entries.size) throw new Error("压缩文件条目不完整。");
  return [...entries.values()];
}
