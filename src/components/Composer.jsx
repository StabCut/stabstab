import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, useToast } from '../lib/store.jsx';
import { fileToDataUrl, readImageMeta, isImageFile } from '../lib/images.js';
import { formatBytes } from '../lib/util.js';
import { sendNew, buildParams } from '../lib/send.js';

const MAX_IMAGES = 3; // API 规则：最多 3 张输入图片

function ParamsPanel({ params, setParams, sizeOptions }) {
  const set = (k, v) => setParams((p) => ({ ...p, [k]: v }));
  return (
    <div className="params-panel">
      <div className="params-row">
        <label>生成张数 n</label>
        <select value={params.n} onChange={(e) => set('n', Number(e.target.value))}>
          {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n} 张</option>)}
        </select>
      </div>
      <div className="params-row">
        <label>反向提示词</label>
        <input
          type="text"
          placeholder="希望排除的内容，如：模糊、多余的手指"
          value={params.negative_prompt}
          onChange={(e) => set('negative_prompt', e.target.value)}
        />
      </div>
      <div className="params-row toggles">
        <label className="checkbox-label">
          <input type="checkbox" checked={!!params.watermark} onChange={(e) => set('watermark', e.target.checked)} />
          添加水印
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={params.prompt_extend !== false} onChange={(e) => set('prompt_extend', e.target.checked)} />
          提示词改写
        </label>
      </div>
      <div className="params-row">
        <label>随机种子 seed</label>
        <input
          type="number"
          placeholder="留空为随机"
          min={0}
          max={2147483647}
          value={params.seed}
          onChange={(e) => set('seed', e.target.value)}
        />
      </div>
    </div>
  );
}

export default function Composer({ conv, busy }) {
  const { state, dispatch } = useApp();
  const toast = useToast();
  const settings = state.settings;
  const mode = settings.requestMode || 'sync';

  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [modelId, setModelId] = useState(settings.defaultModelId);
  const [params, setParams] = useState({ size: 'auto', n: 1, negative_prompt: '', watermark: false, prompt_extend: true, seed: '' });
  const [paramsOpen, setParamsOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  const taRef = useRef(null);
  const paramsWrapRef = useRef(null);
  const dragCounter = useRef(0);

  // 模型列表变化时纠正选择
  useEffect(() => {
    const models = settings.models || [];
    if (!models.find((m) => m.id === modelId)) {
      setModelId(settings.defaultModelId || (models[0] && models[0].id));
    }
  }, [settings.models, settings.defaultModelId, modelId]);

  // 点击外部关闭参数面板
  useEffect(() => {
    if (!paramsOpen) return;
    const onDoc = (e) => {
      if (paramsWrapRef.current && !paramsWrapRef.current.contains(e.target)) setParamsOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [paramsOpen]);

  // 切换会话时重置输入区
  const convId = conv ? conv.id : null;
  useEffect(() => {
    setText('');
    setAttachments([]);
    setSending(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId]);

  const currentModel = useMemo(
    () => (settings.models || []).find((m) => m.id === modelId) || null,
    [settings.models, modelId]
  );
  const protocolInfo = useMemo(() => {
    if (!currentModel) return null;
    return state.protocols.find((p) => p.id === currentModel.protocol) || null;
  }, [state.protocols, currentModel]);
  const sizeOptions = (protocolInfo && protocolInfo.sizeOptions) || ['auto'];

  const log = (level, message, extra) => window.stab.log(level, message, extra);

  /** 添加本地 File 对象（粘贴 / 拖拽） */
  const addFiles = async (fileList) => {
    const files = Array.from(fileList || []).filter(isImageFile);
    if (!files.length) { toast('未识别到图片文件', 'warn'); return; }
    const room = MAX_IMAGES - attachments.length;
    if (room <= 0) { toast(`最多只能添加 ${MAX_IMAGES} 张图片`, 'warn'); return; }
    const use = files.slice(0, room);
    if (files.length > room) toast(`最多只能添加 ${MAX_IMAGES} 张图片，已忽略多余部分`, 'warn');

    const added = [];
    for (const f of use) {
      try {
        const dataUrl = await fileToDataUrl(f);
        const meta = await readImageMeta(dataUrl);
        const saved = await window.stab.saveAttachment({ name: f.name || 'image.png', mime: f.type || 'image/png', dataUrl });
        if (!saved.ok) throw new Error(saved.message);
        added.push({
          file: saved.file, name: f.name || 'image.png', mime: f.type || 'image/png',
          width: meta.width || saved.width, height: meta.height || saved.height,
          bytes: saved.bytes, dataUrl
        });
      } catch (e) {
        toast(`添加图片失败: ${e.message}`, 'error');
        log('error', '添加图片失败', { name: f.name, error: e.message });
      }
    }
    if (added.length) setAttachments((prev) => [...prev, ...added]);
  };

  /** “+” 按钮：资源管理器多选 */
  const pickFiles = async () => {
    const r = await window.stab.pickImages();
    if (!r.ok || !r.files || !r.files.length) return;
    const room = MAX_IMAGES - attachments.length;
    if (room <= 0) { toast(`最多只能添加 ${MAX_IMAGES} 张图片`, 'warn'); return; }
    const use = r.files.slice(0, room);
    if (r.files.length > room) toast(`最多只能添加 ${MAX_IMAGES} 张图片，已忽略多余部分`, 'warn');

    const added = [];
    for (const f of use) {
      try {
        const meta = await readImageMeta(f.dataUrl);
        const saved = await window.stab.saveAttachment({ name: f.name, mime: f.mime, dataUrl: f.dataUrl });
        if (!saved.ok) throw new Error(saved.message);
        added.push({
          file: saved.file, name: f.name, mime: f.mime,
          width: meta.width || saved.width, height: meta.height || saved.height,
          bytes: saved.bytes, dataUrl: f.dataUrl
        });
      } catch (e) {
        toast(`添加图片失败: ${e.message}`, 'error');
      }
    }
    if (added.length) setAttachments((prev) => [...prev, ...added]);
  };

  const onPaste = (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f && isImageFile(f)) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
    // 纯文字粘贴走默认行为
  };

  const onDrop = (e) => {
    e.preventDefault();
    dragCounter.current = 0;
    setDragActive(false);
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  };

  const canSend = !!conv && !sending && !busy && (text.trim().length > 0 || attachments.length > 0);

  const doSend = async () => {
    if (!conv) { toast('请先新建一个对话', 'warn'); return; }
    if (!text.trim() && attachments.length === 0) { toast('请输入文字或添加图片', 'warn'); return; }
    if (busy) return;
    setSending(true);
    try {
      await sendNew({
        dispatch, state, conv,
        text: text.trim(),
        attachments,
        params: buildParams(params),
        modelId,
        log
      });
      setText('');
      setAttachments([]);
      if (taRef.current) taRef.current.focus();
    } catch (e) {
      toast('发送失败: ' + e.message, 'error');
      log('error', '发送失败', { error: e.message });
    } finally {
      setSending(false);
    }
  };

  const stopWaiting = () => {
    if (!busy) return;
    dispatch({ type: 'BUSY_CLEAR', convId: conv.id });
    toast('已停止等待；结果返回后仍会显示并保存', 'info');
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) doSend();
    }
  };

  if (!conv) {
    return (
      <div className="composer disabled-composer">
        <div className="composer-hint">点击左上角「＋ 新建对话」开始</div>
      </div>
    );
  }

  const sizeLabel = (s) => (s === 'auto' ? '尺寸：自动（模型推荐）' : `尺寸：${s.replace('*', '×')}`);

  return (
    <div
      className={`composer ${dragActive ? 'drag-over' : ''}`}
      onDragEnter={(e) => { e.preventDefault(); dragCounter.current++; setDragActive(true); }}
      onDragLeave={(e) => { e.preventDefault(); dragCounter.current--; if (dragCounter.current <= 0) setDragActive(false); }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      {dragActive && <div className="drop-mask">松开以添加图片</div>}

      {attachments.length > 0 && (
        <div className="attach-row">
          {attachments.map((a, i) => (
            <div className="attach-item" key={a.file || i} title={`${a.name} · ${a.width || '?'}×${a.height || '?'} · ${formatBytes(a.bytes)}`}>
              <img src={a.dataUrl} alt={a.name} />
              <button
                className="attach-remove"
                title="移除图片"
                onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
              >✕</button>
            </div>
          ))}
        </div>
      )}

      <div className="composer-input-row">
        <button className="icon-btn attach-btn" title="添加图片（可多选）" onClick={pickFiles}>＋</button>
        <textarea
          ref={taRef}
          className="composer-textarea"
          placeholder={settings.api && settings.api.apiKey ? '描述你想生成的图片，或输入图片编辑指令…（Enter 发送，Shift+Enter 换行，可粘贴/拖入图片）' : '尚未配置 API Key：请在 设置 → 模型设置 中填写'}
          value={text}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
      </div>

      <div className="composer-toolbar">
        <select
          className="model-select"
          value={modelId || ''}
          onChange={(e) => setModelId(e.target.value)}
          title="选择模型"
        >
          {(settings.models || []).map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>

        <select
          className="size-select"
          value={params.size}
          onChange={(e) => setParams((p) => ({ ...p, size: e.target.value }))}
          title="输出尺寸 / 比例"
        >
          {sizeOptions.map((s) => <option key={s} value={s}>{sizeLabel(s)}</option>)}
        </select>

        <div className="params-wrap" ref={paramsWrapRef}>
          <button
            className={`ghost-btn ${paramsOpen ? 'active' : ''}`}
            onClick={() => setParamsOpen((v) => !v)}
            title="高级参数：n / 反向提示词 / 水印 / 提示词改写 / 种子"
          >
            参数 ⚙
          </button>
          {paramsOpen && <ParamsPanel params={params} setParams={setParams} sizeOptions={sizeOptions} />}
        </div>

        <div className="toolbar-spacer" />

        <span className="mode-hint">{mode === 'sync' ? '同步：需等待返回' : '异步：后台轮询任务'}</span>

        {busy && mode === 'sync' ? (
          <>
            <button className="ghost-btn stop-btn" onClick={stopWaiting} title="解锁输入框；请求继续在后台进行，结果返回后仍会显示">
              ⏹ 停止等待
            </button>
            <button className="send-btn" disabled>发送中…</button>
          </>
        ) : (
          <button className="send-btn" disabled={!canSend} onClick={doSend} title="Enter 发送">
            {sending ? '处理中…' : '发送'}
          </button>
        )}
      </div>
    </div>
  );
}
