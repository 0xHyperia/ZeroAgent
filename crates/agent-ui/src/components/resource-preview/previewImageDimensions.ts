/** Check raster dimensions before handing bytes to a browser decoder. */
export function previewImageDimensions(bytes: Uint8Array, mime: string) {
  let width = 0,
    height = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    mime === "image/png" &&
    bytes.length >= 33 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) &&
    view.getUint32(8) === 13 &&
    String.fromCharCode(...bytes.subarray(12, 16)) === "IHDR"
  ) {
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (mime === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let position = 2;
    while (position + 8 < bytes.length && position < 256 * 1024) {
      if (bytes[position++] !== 0xff) break;
      while (bytes[position] === 0xff) position++;
      const marker = bytes[position++];
      if (marker === 0xda || marker === 0xd9 || position + 2 > bytes.length) break;
      if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const size = view.getUint16(position);
      if (size < 2 || position + size > bytes.length) break;
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        ) &&
        size >= 8
      ) {
        height = view.getUint16(position + 3);
        width = view.getUint16(position + 5);
        break;
      }
      position += size;
    }
  } else if (
    mime === "image/gif" &&
    bytes.length >= 10 &&
    ["GIF87a", "GIF89a"].includes(new TextDecoder().decode(bytes.subarray(0, 6)))
  ) {
    width = view.getUint16(6, true);
    height = view.getUint16(8, true);
  } else if (
    mime === "image/webp" &&
    bytes.length >= 30 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    const chunk = String.fromCharCode(...bytes.subarray(12, 16));
    if (chunk === "VP8X") {
      width = 1 + bytes[24] + bytes[25] * 256 + bytes[26] * 65536;
      height = 1 + bytes[27] + bytes[28] * 256 + bytes[29] * 65536;
    } else if (chunk === "VP8L" && bytes[20] === 0x2f) {
      width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
      height = 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10);
    } else if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      width = view.getUint16(26, true) & 0x3fff;
      height = view.getUint16(28, true) & 0x3fff;
    }
  } else if (
    mime === "image/bmp" &&
    bytes.length >= 30 &&
    bytes[0] === 66 &&
    bytes[1] === 77 &&
    view.getUint32(14, true) >= 40
  ) {
    width = view.getInt32(18, true);
    height = Math.abs(view.getInt32(22, true));
  } else if (
    mime === "image/avif" &&
    bytes.length >= 16 &&
    String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp" &&
    ["avif", "avis"].includes(String.fromCharCode(...bytes.subarray(8, 12)))
  ) {
    let atoms = 0;
    function inspect(start: number, end: number, depth: number) {
      if (depth > 8) throw new Error("AVIF 元数据过于复杂，请下载原件。");
      while (start + 8 <= end) {
        if (++atoms > 4096) throw new Error("AVIF 元数据过于复杂，请下载原件。");
        let size = view.getUint32(start),
          header = 8;
        const type = String.fromCharCode(...bytes.subarray(start + 4, start + 8));
        if (size === 1) {
          if (start + 16 > end) break;
          size = Number(view.getBigUint64(start + 8));
          header = 16;
        }
        if (size === 0) size = end - start;
        if (!Number.isSafeInteger(size) || size < header || start + size > end) break;
        if (type === "ispe" && size >= header + 12) {
          width = Math.max(width, view.getUint32(start + header + 4));
          height = Math.max(height, view.getUint32(start + header + 8));
        }
        if (["meta", "iprp", "ipco"].includes(type))
          inspect(start + header + (type === "meta" ? 4 : 0), start + size, depth + 1);
        start += size;
      }
    }
    inspect(0, bytes.length, 0);
  }
  if (
    !width ||
    !height ||
    width < 0 ||
    width > 8192 ||
    height > 8192 ||
    width * height > 16_000_000
  )
    throw new Error("图片格式或尺寸不适合当前预览，请下载原件查看。");
  return { width, height };
}
