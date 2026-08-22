/* 通用小工具 */
export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatClock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/** 本地图片地址（主进程 appfile:// 协议） */
export function cacheUrl(file) {
  return `appfile://cache/${encodeURIComponent(file)}`;
}
export function uploadUrl(file) {
  return `appfile://uploads/${encodeURIComponent(file)}`;
}

/** 从形如 2688*1536 的字符串得到 {w, h, label} */
export function parseSize(sizeStr) {
  const m = /^(\d+)\s*[*x×]\s*(\d+)$/i.exec(String(sizeStr || '').trim());
  if (!m) return null;
  return { w: parseInt(m[1], 10), h: parseInt(m[2], 10), label: `${m[1]}×${m[2]}` };
}
