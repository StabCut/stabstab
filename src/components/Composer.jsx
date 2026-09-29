import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, useToast } from '../lib/store.jsx';
import { fileToDataUrl, readImageMeta, isImageFile } from '../lib/images.js';
import { formatBytes } from '../lib/util.js';
import { sendNew, buildParams, defaultParams } from '../lib/send.js';
import { allModels, resolveModel, sizeLabel } from '../lib/models.js';
import Icon from './Icon.jsx';

const MAX_IMAGES = 3; // API 规则：最多 3 张输入图片

/** 参数面板：字段完全由当前模型所属协议的 paramSchema 决定 */
export function ParamsPanel({ params, setParams, schema }) {
  const set = (k, v) => setParams((p) => ({ ...p, [k]: v }));
  const entries = Object.entries(schema || {});
  if (!entries.length) {
    return <div className="params-panel"><p className="field-hint">该模型没有额外可调参数，尺寸请用上方下拉框选择。</p></div>;
  }

  const rows = [];
  let boolBuf = [];
  const flushBools = () => {
    if (!boolBuf.length) return;
    rows.push(
      <div className="params-row toggles" key={`toggles-${boolBuf[0][0]}`}>
        {boolBuf.map(([k, def]) => (
          <label className="checkbox-label" key={k}>
            <input type="checkbox" checked={!!params[k]} onChange={(e) => set(k, e.target.checked)} />
            {def.label || k}
          </label>
        ))}
      </div>
    );
    boolBuf = [];
  };

  for (const [k, def] of entries) {
    const type = (def && def.type) || 'string';
    if (type === 'bool') { boolBuf.push([k, def]); continue; }
    flushBools();
    if (type === 'int' || type === 'number') {
      rows.push(
        <div className="params-row" key={k}>
          <label>{def.label || k}</label>
          <input
            type="number"
            min={def.min}
            max={def.max}
            placeholder={def.placeholder || ''}
            value={params[k] === undefined || params[k] === null ? '' : params[k]}
            onChange={(e) => set(k, e.target.value)}
          />
        </div>
      );
    } else if (type === 'enum') {
      rows.push(
        <div className="params-row" key={k}>
          <label>{def.label || k}</label>
          <select value={params[k] === undefined || params[k] === null ? '' : params[k]} onChange={(e) => set(k, e.target.value)}>
            {(def.options || []).map((o) => <option key={o} value={o}>{o === '' ? '默认（不发送）' : o}</option>)}
          </select>
        </div>
      );
    } else {
      rows.push(
        <div className="params-row" key={k}>
          <label>{def.label || k}</label>
          <input
            type="text"
            placeholder={def.placeholder || ''}
            value={params[k] === undefined || params[k] === null ? '' : params[k]}
            onChange={(e) => set(k, e.target.value)}
          />
        </div>
      );
    }
  }
  flushBools();

  return <div className="params-panel">{rows}</div>;
}

export default function Composer({ conv, busy }) {
  const { state, dispatch } = useApp();
  const toast = useToast();
  const settings = state.settings;

  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [modelId, setModelId] = useState(settings.defaultModelId);
  const [params, setParams] = useState({ size: 'auto' });
  const [paramsOpen, setParamsOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  const taRef = useRef(null);
  const paramsWrapRef = useRef(null);
  const dragCounter = useRef(0);

  const models = useMemo(
    () => allModels(settings, state.modelSeries),
    [settings.modelGroups, state.modelSeries]
  );

  const current = useMemo(
    () => resolveModel(settings, state.modelSeries, state.protocols, modelId),
    [settings, state.modelSeries, state.protocols, modelId]
  );

  const mode = current ? current.mode : 'sync';
  const schema = (current && current.paramSchema) || {};
  const sizeOptions = (current && current.sizeOptions) || ['auto'];
  const protocol = current ? current.protocol : null;

  // 模型列表变化时纠正选择
  useEffect(() => {
    if (!models.length) return;
    if (!models.find((m) => m.id === modelId)) {
      const def = models.find((m) => m.id === settings.defaultModelId);
      setModelId(def ? def.id : models[0].id);
    }
  }, [models, settings.defaultModelId, modelId]);

  // 换模型/换协议时重置参数面板（保留尺寸选择）
  useEffect(() => {
    setParams((p) => ({ size: p.size || 'auto', ...defaultParams(schema) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [protocol]);

  // 尺寸不在当前模型的候选列表里时纠正
  useEffect(() => {
    if (!sizeOptions.includes(params.size)) {
      setParams((p) => ({ ...p, size: sizeOptions[0] || 'auto' }));
    }
  }, [sizeOptions, params.size]);

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

  const canSend = !!conv && !sending && !busy && !!current && (text.trim().length > 0 || attachments.length > 0);

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
        params: buildParams(params, schema),
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
        <div className="composer-hint">点击左上角「新建对话」开始</div>
      </div>
    );
  }

  const placeholder = !models.length
    ? '尚未添加模型：请在 设置 → 模型设置 中添加模型系列与模型'
    : (current && !current.hasKey
      ? `尚未配置 API Key：请在 设置 → 模型设置 → ${current.seriesLabel} 中填写`
      : '描述你想生成的图片，或输入图片编辑指令…（Enter 发送，Shift+Enter 换行，可粘贴/拖入图片）');

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
              ><Icon name="close" size={13} strokeWidth={2.2} /></button>
            </div>
          ))}
        </div>
      )}

      <div className="composer-input-row">
        <button className="icon-btn attach-btn" title="添加图片（可多选）" onClick={pickFiles}><Icon name="plus" size={18} /></button>
        <textarea
          ref={taRef}
          className="composer-textarea"
          placeholder={placeholder}
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
          title="选择模型（按模型系列分组）"
        >
          {!models.length && <option value="">（未添加模型）</option>}
          {groupBySeries(models).map(([seriesLabel, list]) => (
            <optgroup key={seriesLabel} label={seriesLabel}>
              {list.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </optgroup>
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
            title="高级参数（随模型系列不同而不同）"
          >
            <Icon name="sliders" size={15} /> 参数
          </button>
          {paramsOpen && <ParamsPanel params={params} setParams={setParams} schema={schema} />}
        </div>

        <div className="toolbar-spacer" />

        <span className="mode-hint" title={current ? `${current.seriesLabel} · ${current.sourceLabel}` : ''}>
          {mode === 'sync' ? '同步：需等待返回' : '异步：后台轮询任务'}
        </span>

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

/** 下拉框按系列分组（同一系列内保持添加顺序） */
function groupBySeries(models) {
  const map = new Map();
  for (const m of models) {
    const key = m.seriesLabel || '未分组';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(m);
  }
  return Array.from(map.entries());
}
