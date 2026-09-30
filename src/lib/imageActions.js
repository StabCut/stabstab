/*
 * 聊天区图片（用户发送的输入图 / API 返回的结果图）的三种操作。
 * ==========================================================
 * 右键菜单的「复制 / 保存到下载 / 另存为」在这里统一实现，两种来源只用 kind 区分：
 *   kind = 'upload'  用户发送的输入图，文件在 <data>/uploads/
 *   kind = 'result'  API 返回的结果图，文件在 <data>/cache/
 * 真正的文件读写、系统剪贴板与保存对话框都在主进程（electron/main.js 的 image:* 通道），
 * 这里只负责发起调用，并把 {ok, message, path} 归一成一句轻提示；
 * 图片文件不存在（缓存被清理）等失败情况一律返回 {ok:false, message}，不抛异常。
 */

const IMAGE_KINDS = { upload: '输入图', result: '结果图' };

function bridge() {
  return (typeof window !== 'undefined' && window.stab) || null;
}

/** IPC 调用兜底：通道缺失或主进程异常也要变成可提示的返回值 */
async function call(fn) {
  try {
    const r = await fn();
    return r || { ok: false, message: '操作失败。' };
  } catch (e) {
    return { ok: false, message: (e && e.message) || '操作失败。' };
  }
}

/** 复制到系统剪贴板 */
export async function copyImageToClipboard(kind, file) {
  const api = bridge();
  if (!api || !api.copyImageFile) return { ok: false, message: '当前环境不支持剪贴板操作。' };
  return call(() => api.copyImageFile(kind, file));
}

/** 保存到系统「下载」目录（Windows 的「下载」文件夹 / macOS 的 Downloads），不是应用数据目录 */
export async function saveImageToDownloads(kind, file) {
  const api = bridge();
  if (!api || !api.saveImageFile) return { ok: false, message: '当前环境不支持保存操作。' };
  return call(() => api.saveImageFile(kind, file));
}

/** 另存为：主进程弹出系统保存对话框，用户自选保存位置与文件名 */
export async function saveImageAs(kind, file, suggestedName) {
  const api = bridge();
  if (!api || !api.saveImageFileAs) return { ok: false, message: '当前环境不支持另存为操作。' };
  return call(() => api.saveImageFileAs(kind, file, suggestedName));
}

/** 图片文件缺失时的统一提示（右键缺失占位图 / 兜底） */
export function missingImageMessage(kind) {
  return (IMAGE_KINDS[kind] || '图片') + '文件不存在（可能已被清理）。';
}

/**
 * 右键菜单的三个选项。
 * label 就是菜单上显示的文字；hint 只作为鼠标悬停提示，不写进菜单文字。
 * run 收到菜单上下文 { x, y, kind, file, name }，返回主进程的结果对象。
 */
export const IMAGE_MENU_ITEMS = [
  {
    key: 'copy',
    label: '复制',
    hint: '复制到剪贴板',
    icon: 'copy',
    run: ({ kind, file }) => copyImageToClipboard(kind, file),
    // 剪贴板的位图格式没有任何元数据容器；提示词 / 输入图文件名是随 HTML 格式里的原图字节走的
    done: (r) => {
      if (r && r.withPics) return '图片已复制到剪贴板（含提示词与输入图文件名）';
      if (r && r.withPrompt) return '图片已复制到剪贴板（含提示词元数据）';
      return '图片已复制到剪贴板';
    }
  },
  {
    key: 'download',
    label: '保存到下载',
    hint: '保存到系统下载目录',
    icon: 'download',
    run: ({ kind, file }) => saveImageToDownloads(kind, file),
    done: (r) => ({ message: '已保存', path: r.path || '' })
  },
  {
    key: 'save-as',
    label: '另存为',
    hint: '选择保存位置与文件名',
    icon: 'folder',
    run: ({ kind, file, name }) => saveImageAs(kind, file, name),
    done: (r) => ({ message: '已另存为', path: r.path || '' })
  }
];