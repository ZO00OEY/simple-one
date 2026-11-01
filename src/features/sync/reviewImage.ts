export interface ReviewImage { bytes: Uint8Array; mime: string }
export const reviewImageLimit = 5 * 1024 * 1024;
export const isReviewImage = (path: string): boolean => /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(path);
/** Accept raster signatures only; SVG/HTML never become active preview documents. */
export function reviewImage(bytes: Uint8Array): ReviewImage {
  if (bytes.length > reviewImageLimit) throw new Error("图片超过 5 MB，已省略预览；选择仍采用完整文件。");
  const has = (offset: number, text: string): boolean => [...text].every((char, i) => bytes[offset + i] === char.charCodeAt(0));
  const mime = bytes[0] === 137 && has(1, "PNG\r\n\x1a\n") ? "image/png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
    : has(0, "GIF87a") || has(0, "GIF89a") ? "image/gif"
    : has(0, "RIFF") && has(8, "WEBP") ? "image/webp"
    : has(0, "BM") ? "image/bmp"
    : has(4, "ftyp") && (has(8, "avif") || has(8, "avis")) ? "image/avif" : undefined;
  if (!mime) throw new Error("图片格式不受支持或内容不匹配；选择仍采用完整文件。");
  return { bytes, mime };
}
