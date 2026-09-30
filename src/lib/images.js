/*
 * 图片处理：File/dataUrl 转换、尺寸读取、按设置自动压缩。
 * 压缩策略：超过阈值 MB 时，渐进降低质量 / 缩放尺寸，直到低于阈值或达到下限。
 * （与 API 规则一致：动态 GIF 仅处理第一帧，canvas 天然只取第一帧）
 */

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('读取文件失败'));
    fr.readAsDataURL(file);
  });
}

/** dataUrl 的近似字节数 */
export function dataUrlBytes(dataUrl) {
  const idx = String(dataUrl).indexOf('base64,');
  if (idx < 0) return 0;
  const b64 = dataUrl.slice(idx + 7);
  return Math.floor(b64.length * 3 / 4);
}

export function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = dataUrl;
  });
}

export async function readImageMeta(dataUrl) {
  try {
    const img = await loadImage(dataUrl);
    return { width: img.naturalWidth, height: img.naturalHeight };
  } catch (e) {
    return { width: null, height: null };
  }
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), mime, quality);
  });
}

/**
 * 若启用压缩且 dataUrl 字节数超过 maxMB，则压缩。
 * @returns {Promise<{dataUrl, mime, compressed, originalBytes, finalBytes}>}
 */
export async function compressIfNeeded(dataUrl, mime, { enabled, maxMB }) {
  const originalBytes = dataUrlBytes(dataUrl);
  const threshold = Math.max(0.5, Number(maxMB) || 10) * 1024 * 1024;
  if (!enabled || originalBytes <= threshold) {
    return { dataUrl, mime, compressed: false, originalBytes, finalBytes: originalBytes };
  }

  let img;
  try {
    img = await loadImage(dataUrl);
  } catch (e) {
    return { dataUrl, mime, compressed: false, originalBytes, finalBytes: originalBytes };
  }

  // PNG 保留格式先试一次；其余格式统一转 JPEG（质量可调）
  let targetMime = mime === 'image/png' ? 'image/png' : 'image/jpeg';
  let scale = 1;
  let quality = 0.92;
  let best = null;

  for (let i = 0; i < 12; i++) {
    const w = Math.max(64, Math.round(img.naturalWidth * scale));
    const h = Math.max(64, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (targetMime === 'image/jpeg') {
      // JPEG 无透明通道，先铺白底
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await canvasToBlob(canvas, targetMime, quality);
    const outUrl = await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.readAsDataURL(blob);
    });
    best = { dataUrl: outUrl, mime: targetMime, bytes: blob.size };
    if (blob.size <= threshold) break;

    // 仍有超出：优先缩放，其次降质；PNG 降质无效则转 JPEG
    if (scale > 0.35) {
      scale *= 0.85;
    } else if (targetMime === 'image/png') {
      targetMime = 'image/jpeg';
      quality = 0.9;
    } else if (quality > 0.55) {
      quality -= 0.1;
    } else {
      break;
    }
  }

  if (!best) {
    return { dataUrl, mime, compressed: false, originalBytes, finalBytes: originalBytes };
  }
  return {
    dataUrl: best.dataUrl,
    mime: best.mime,
    compressed: true,
    originalBytes,
    finalBytes: best.bytes
  };
}

export const ACCEPTED_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff'];

export function isImageFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith('image/')) return true;
  const name = (file.name || '').toLowerCase();
  return ACCEPTED_IMAGE_EXTS.some((e) => name.endsWith('.' + e));
}

/**
 * 用户输入图的**真实文件名**（写进结果图 picN 的那个名字）。
 * 只认用户自己的文件（资源管理器拖入 / 对话框选择）；名字里只保留文件名本身，不带路径。
 * 注意：系统剪贴板粘贴 / 从别的程序直接复制过来的图片，浏览器给的名字是 "image.png" 这类
 * 占位名，不是用户文件的名字 —— 这类来源根本不要调用本函数（调用方按来源传 named=false），
 * 保持 pic 项为空串，但 pic 项依然存在（见 lib/send.js 的 imageNames）。
 */
export function sourceFileName(file) {
  const name = file && typeof file.name === 'string' ? file.name.trim() : '';
  if (!name) return '';
  return name.split(/[\\/]/).pop() || '';
}
