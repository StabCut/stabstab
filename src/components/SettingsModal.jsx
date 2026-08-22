import React, { useEffect, useMemo, useState } from 'react';
import { useApp, useToast } from '../lib/store.jsx';
import { uid } from '../lib/util.js';

const TABS = [
  { id: 'model', label: '模型设置' },
  { id: 'basic', label: '基础设置' },
  { id: 'advanced', label: '高级设置' }
];

export default function SettingsModal() {
  const { state, dispatch } = useApp();
  const toast = useToast();
  const [tab, setTab] = useState('model');
  const [draft, setDraft] = useState(() => JSON.parse(JSON.stringify(state.settings)));
  const [showKey, setShowKey] = useState(false);

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const setApi = (patch) => setDraft((d) => ({ ...d, api: { ...d.api, ...patch } }));

  const protocols = state.protocols || [];
  const activeProtocols = useMemo(() => protocols.filter((p) => p.available), [protocols]);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') dispatch({ type: 'SETTINGS_OPEN', open: false }); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch]);

  const close = () => dispatch({ type: 'SETTINGS_OPEN', open: false });

  const pickSavePath = async () => {
    const r = await window.stab.pickFolder(draft.defaultSavePath || state.paths.downloads);
    if (r.ok && r.path) set({ defaultSavePath: r.path });
  };

  const addModel = () => {
    const p = activeProtocols[0];
    setDraft((d) => ({
      ...d,
      models: [...d.models, { id: uid('m'), name: p ? p.defaultModel : 'new-model', protocol: p ? p.id : 'dashscope-multimodal' }]
    }));
  };

  const removeModel = (id) => {
    setDraft((d) => {
      if (d.models.length <= 1) { toast('至少保留一个模型', 'warn'); return d; }
      const models = d.models.filter((m) => m.id !== id);
      let defaultModelId = d.defaultModelId;
      if (defaultModelId === id) defaultModelId = models[0].id;
      return { ...d, models, defaultModelId };
    });
  };

  const updateModel = (id, patch) => {
    setDraft((d) => ({ ...d, models: d.models.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
  };

  const save = () => {
    // 规范化
    const cleaned = JSON.parse(JSON.stringify(draft));
    cleaned.requestTimeoutSec = Math.min(3600, Math.max(15, Number(cleaned.requestTimeoutSec) || 300));
    cleaned.compressMaxMB = Math.min(100, Math.max(0.5, Number(cleaned.compressMaxMB) || 10));
    cleaned.api.baseUrl = (cleaned.api.baseUrl || '').trim() || 'https://dashscope.aliyuncs.com/api/v1';
    cleaned.api.apiKey = (cleaned.api.apiKey || '').trim();
    cleaned.models = cleaned.models.map((m) => ({
      ...m,
      name: (m.name || '').trim() || 'custom-model'
    }));
    if (!cleaned.models.find((m) => m.id === cleaned.defaultModelId)) {
      cleaned.defaultModelId = cleaned.models[0].id;
    }
    dispatch({ type: 'SETTINGS_UPDATE', settings: cleaned });
    toast('设置已保存', 'info');
    window.stab.log('info', '设置已更新', {
      theme: cleaned.theme, mode: cleaned.requestMode, timeout: cleaned.requestTimeoutSec,
      compress: cleaned.compressEnabled, maxMB: cleaned.compressMaxMB, models: cleaned.models.length,
      baseUrl: cleaned.api.baseUrl
    });
    close();
  };

  return (
    <div className="modal-mask" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal settings-modal">
        <div className="modal-header">
          <div className="modal-title">设置</div>
          <button className="icon-btn" onClick={close} title="关闭">✕</button>
        </div>

        <div className="settings-body">
          <nav className="settings-tabs">
            {TABS.map((t) => (
              <button key={t.id} className={`settings-tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>

          <div className="settings-content">
            {/* ---------- 模型设置 ---------- */}
            {tab === 'model' && (
              <div className="settings-section">
                <div className="field">
                  <label>API Key</label>
                  <div className="input-group">
                    <input
                      type={showKey ? 'text' : 'password'}
                      placeholder="sk-xxxxxxxx"
                      value={draft.api.apiKey}
                      onChange={(e) => setApi({ apiKey: e.target.value })}
                    />
                    <button className="ghost-btn" onClick={() => setShowKey((v) => !v)}>{showKey ? '隐藏' : '显示'}</button>
                  </div>
                  <p className="field-hint">密钥仅保存在本机数据目录的 settings.json 中。</p>
                </div>

                <div className="field">
                  <label>API 地址（Base URL）</label>
                  <div className="input-group">
                    <input
                      type="text"
                      value={draft.api.baseUrl}
                      onChange={(e) => setApi({ baseUrl: e.target.value })}
                    />
                    <button className="ghost-btn" onClick={() => setApi({ baseUrl: 'https://dashscope.aliyuncs.com/api/v1' })}>恢复默认</button>
                  </div>
                </div>

                <div className="field">
                  <label>模型列表</label>
                  <div className="model-list">
                    {draft.models.map((m) => {
                      const proto = protocols.find((p) => p.id === m.protocol);
                      return (
                        <div className="model-row" key={m.id}>
                          <label className="radio-label" title="设为默认模型">
                            <input
                              type="radio"
                              name="default-model"
                              checked={draft.defaultModelId === m.id}
                              onChange={() => set({ defaultModelId: m.id })}
                            />
                          </label>
                          <input
                            className="model-name-input"
                            value={m.name}
                            placeholder="模型名称"
                            onChange={(e) => updateModel(m.id, { name: e.target.value })}
                          />
                          <select
                            value={m.protocol}
                            onChange={(e) => updateModel(m.id, { protocol: e.target.value })}
                            title="API 请求与解析协议"
                          >
                            {activeProtocols.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                            {protocols.filter((p) => !p.available).map((p) => (
                              <option key={p.id} value={p.id} disabled>{p.label}</option>
                            ))}
                          </select>
                          <button className="icon-btn" title="删除模型" onClick={() => removeModel(m.id)}>🗑</button>
                        </div>
                      );
                    })}
                  </div>
                  <div className="model-actions">
                    <button className="ghost-btn" onClick={addModel}>＋ 添加模型</button>
                    <span className="field-hint">
                      默认协议为 DashScope（qwen-image-3.0-pro）；其它请求/解析规则可通过新增协议适配器扩展。
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* ---------- 基础设置 ---------- */}
            {tab === 'basic' && (
              <div className="settings-section">
                <div className="field">
                  <label>外观主题</label>
                  <select value={draft.theme} onChange={(e) => set({ theme: e.target.value })}>
                    <option value="light">白天模式</option>
                    <option value="dark">黑暗模式</option>
                    <option value="system">跟随系统</option>
                  </select>
                </div>

                <div className="field">
                  <label>默认保存路径（下载结果图片）</label>
                  <div className="input-group">
                    <input type="text" readOnly value={draft.defaultSavePath || `${state.paths.downloads}（默认）`} />
                    <button className="ghost-btn" onClick={pickSavePath}>浏览…</button>
                    <button
                      className="ghost-btn"
                      onClick={() => window.stab.openPath(draft.defaultSavePath || state.paths.downloads)}
                    >打开</button>
                    <button className="ghost-btn" onClick={() => set({ defaultSavePath: '' })}>恢复默认</button>
                  </div>
                </div>

                <div className="field">
                  <label>单次 API 请求超时时间（秒）</label>
                  <input
                    type="number" min={15} max={3600}
                    value={draft.requestTimeoutSec}
                    onChange={(e) => set({ requestTimeoutSec: e.target.value })}
                  />
                  <p className="field-hint">默认 300 秒（5 分钟）。同步等待与异步轮询均受此约束；超时后输入框恢复可用。</p>
                </div>

                <div className="field">
                  <label>图片自动压缩</label>
                  <div className="compress-row">
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={!!draft.compressEnabled}
                        onChange={(e) => set({ compressEnabled: e.target.checked })}
                      />
                      启用
                    </label>
                    <span>单张图片超过</span>
                    <input
                      type="number" min={0.5} max={100} step={0.5}
                      className="num-sm"
                      value={draft.compressMaxMB}
                      onChange={(e) => set({ compressMaxMB: e.target.value })}
                      disabled={!draft.compressEnabled}
                    />
                    <span>MB 时自动压缩（多图分别检测）</span>
                  </div>
                  <p className="field-hint">压缩在发送前进行：渐进降低质量与尺寸，直到低于阈值。API 限制单图不超过 10MB。</p>
                </div>
              </div>
            )}

            {/* ---------- 高级设置 ---------- */}
            {tab === 'advanced' && (
              <div className="settings-section">
                <div className="field">
                  <label>请求模式</label>
                  <label className="radio-card">
                    <input type="radio" name="req-mode" checked={draft.requestMode === 'sync'} onChange={() => set({ requestMode: 'sync' })} />
                    <div>
                      <div className="radio-title">同步模式（默认）</div>
                      <div className="radio-desc">
                        当前对话需等待 API 返回后才能再次发送（发送按钮置灰，超时后恢复）。
                        多个对话标签各自独立等待、互不阻塞；其它标签返回结果时左侧显示黄点提醒。
                      </div>
                    </div>
                  </label>
                  <label className="radio-card">
                    <input type="radio" name="req-mode" checked={draft.requestMode === 'async'} onChange={() => set({ requestMode: 'async' })} />
                    <div>
                      <div className="radio-title">异步模式（Task API）</div>
                      <div className="radio-desc">
                        请求头携带 X-DashScope-Async: enable，提交后获得 task_id，后台按指数退避轮询
                        （3 秒起、×1.5、上限 15 秒）直至成功 / 失败 / 超时。等待期间可继续发送；
                        PENDING 状态的任务可取消。应用重启后自动恢复轮询。
                      </div>
                    </div>
                  </label>
                  <p className="field-hint">两种模式均遵循「单次请求超时时间」设置。</p>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button className="ghost-btn" onClick={close}>取消</button>
          <button className="send-btn" onClick={save}>保存</button>
        </div>
      </div>
    </div>
  );
}
