import React, { useEffect, useMemo, useState } from 'react';
import { useApp, useToast } from '../lib/store.jsx';
import { uid } from '../lib/util.js';
import { sourceConfigOf, sourceKey } from '../lib/models.js';
import Icon from './Icon.jsx';

const TABS = [
  { id: 'model', label: '模型设置' },
  { id: 'basic', label: '基础设置' },
  { id: 'advanced', label: '高级设置' }
];

const clone = (v) => JSON.parse(JSON.stringify(v));

export default function SettingsModal({ initialTab = 'model' }) {
  const { state, dispatch } = useApp();
  const toast = useToast();
  const [tab, setTab] = useState(initialTab);
  const [draft, setDraft] = useState(() => clone(state.settings));
  // 系列配置草稿（可写字段：hidden / requestMode.value）
  const [draftSeries, setDraftSeries] = useState(() => clone(state.modelSeries || { series: [] }));
  const [showKeys, setShowKeys] = useState({});      // { '<seriesId>.<sourceId>': true }
  const [pickSeriesId, setPickSeriesId] = useState('');

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

  const seriesList = draftSeries.series || [];
  const groups = draft.modelGroups || [];

  const addedSeries = useMemo(
    () => seriesList.filter((s) => groups.some((g) => g.seriesId === s.id)),
    [seriesList, groups]
  );
  const addableSeries = useMemo(
    () => seriesList.filter((s) => !groups.some((g) => g.seriesId === s.id)),
    [seriesList, groups]
  );

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

  // ---------- 模型系列 ----------
  const addSeries = (seriesId) => {
    const s = seriesList.find((x) => x.id === seriesId);
    if (!s) return;
    setDraft((d) => ({
      ...d,
      modelGroups: [...(d.modelGroups || []), { seriesId, models: [] }]
    }));
    setDraftSeries((cur) => ({
      ...cur,
      series: cur.series.map((x) => (x.id === seriesId ? { ...x, hidden: false } : x))
    }));
    setPickSeriesId('');
  };

  /** 删除模型系列：内置系列不能真删，只是 hidden=true 并从列表移除 */
  const removeSeries = (seriesId) => {
    const g = groups.find((x) => x.seriesId === seriesId);
    const n = (g && g.models.length) || 0;
    if (n > 0 && !window.confirm(`移除「${seriesLabel(seriesId)}」？该系列下的 ${n} 个模型会一起从列表中移除（API Key 等配置保留，之后可重新添加该系列）。`)) return;
    setDraft((d) => ({ ...d, modelGroups: (d.modelGroups || []).filter((x) => x.seriesId !== seriesId) }));
    setDraftSeries((cur) => ({
      ...cur,
      series: cur.series.map((x) => (x.id === seriesId ? { ...x, hidden: true } : x))
    }));
  };

  const seriesLabel = (id) => {
    const s = seriesList.find((x) => x.id === id);
    return s ? s.label : id;
  };

  // ---------- 模型 ----------
  const addModel = (seriesId) => {
    const s = seriesList.find((x) => x.id === seriesId);
    const sourceId = (s && s.sources && s.sources[0] && s.sources[0].id) || '';
    setDraft((d) => ({
      ...d,
      modelGroups: (d.modelGroups || []).map((g) => (
        g.seriesId === seriesId
          ? { ...g, models: [...g.models, { id: uid('m'), name: '', sourceId }] }
          : g
      ))
    }));
  };

  const removeModel = (seriesId, modelId) => {
    setDraft((d) => ({
      ...d,
      modelGroups: (d.modelGroups || []).map((g) => (
        g.seriesId === seriesId ? { ...g, models: g.models.filter((m) => m.id !== modelId) } : g
      )),
      defaultModelId: d.defaultModelId === modelId ? '' : d.defaultModelId
    }));
  };

  const updateModel = (seriesId, modelId, patch) => {
    setDraft((d) => ({
      ...d,
      modelGroups: (d.modelGroups || []).map((g) => (
        g.seriesId === seriesId
          ? { ...g, models: g.models.map((m) => (m.id === modelId ? { ...m, ...patch } : m)) }
          : g
      ))
    }));
  };

  // ---------- 系列·来源级配置（API Key / API 地址） ----------
  const cfgOf = (seriesId, sourceId) => sourceConfigOf(draft, seriesId, sourceId);

  const setCfg = (seriesId, sourceId, patch) => {
    const key = sourceKey(seriesId, sourceId);
    setDraft((d) => ({
      ...d,
      sourceConfig: {
        ...(d.sourceConfig || {}),
        [key]: { apiKey: '', baseUrl: '', ...((d.sourceConfig || {})[key] || {}), ...patch }
      }
    }));
  };

  // ---------- 保存 ----------
  const save = () => {
    const cleaned = clone(draft);
    cleaned.requestTimeoutSec = Math.min(3600, Math.max(15, Number(cleaned.requestTimeoutSec) || 300));
    cleaned.compressMaxMB = Math.min(100, Math.max(0.5, Number(cleaned.compressMaxMB) || 10));

    // 模型：去掉空白名字；系列：去掉未知系列；密钥/地址：去掉指向不存在来源的键
    const seriesIds = new Set(seriesList.map((s) => s.id));
    const sourceKeys = new Set();
    for (const s of seriesList) for (const src of (s.sources || [])) sourceKeys.add(sourceKey(s.id, src.id));

    cleaned.modelGroups = (cleaned.modelGroups || [])
      .filter((g) => seriesIds.has(g.seriesId))
      .map((g) => ({
        seriesId: g.seriesId,
        models: (g.models || [])
          .map((m) => ({ ...m, name: String(m.name || '').trim() }))
          .filter((m) => m.name)
      }));
    const kept = {};
    for (const [k, v] of Object.entries(cleaned.sourceConfig || {})) {
      if (!sourceKeys.has(k)) continue;
      const apiKey = String((v && v.apiKey) || '').trim();
      const baseUrl = String((v && v.baseUrl) || '').trim();
      if (apiKey || baseUrl) kept[k] = { apiKey, baseUrl };
    }
    cleaned.sourceConfig = kept;

    const allModels = cleaned.modelGroups.flatMap((g) => g.models);
    if (!allModels.some((m) => m.id === cleaned.defaultModelId)) {
      cleaned.defaultModelId = allModels.length ? allModels[0].id : '';
    }

    dispatch({ type: 'SETTINGS_UPDATE', settings: cleaned, modelSeries: draftSeries });
    toast('设置已保存', 'info');
    window.stab.log('info', '设置已更新', {
      theme: cleaned.theme, timeout: cleaned.requestTimeoutSec,
      compress: cleaned.compressEnabled, maxMB: cleaned.compressMaxMB,
      series: cleaned.modelGroups.map((g) => `${g.seriesId}:${g.models.length}`).join(','),
      models: allModels.length,
      defaultModel: cleaned.defaultModelId,
      requestModes: draftSeries.series.filter((s) => s.requestMode && s.requestMode.supported).map((s) => `${s.id}=${s.requestMode.value}`).join(',')
    });
    close();
  };

  const modeSeries = seriesList.filter((s) => s.requestMode && s.requestMode.supported);

  return (
    <div className="modal-mask" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal settings-modal">
        <div className="modal-header">
          <div className="modal-title">设置</div>
          <button className="icon-btn" onClick={close} title="关闭"><Icon name="close" size={16} /></button>
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
                {!addedSeries.length && (
                  <div className="empty-hint">
                    还没有模型系列。请在下方「添加模型系列」中选择一个内置系列（系列与其可用 API 来源由系统内置，
                    配置存放在数据目录的 <code>model-series.json</code>），然后在该系列内添加你自己的模型 id。
                  </div>
                )}

                {addedSeries.map((s) => {
                  const g = groups.find((x) => x.seriesId === s.id) || { seriesId: s.id, models: [] };
                  return (
                    <div className="series-card" key={s.id}>
                      <div className="series-head">
                        <div>
                          <div className="series-title">{s.label}</div>
                          <div className="series-sub">
                            可用 API 来源：{(s.sources || []).map((x) => x.label).join(' / ')}
                            {s.requestMode && s.requestMode.supported ? `　·　支持同步/异步（当前：${s.requestMode.value === 'async' ? '异步' : '同步'}）` : '　·　仅同步模式'}
                          </div>
                        </div>
                        <button className="icon-btn" title="移除该模型系列（可随时重新添加）" onClick={() => removeSeries(s.id)}>
                          <Icon name="trash" size={16} />
                        </button>
                      </div>

                      <div className="model-list">
                        {g.models.map((m) => (
                          <div className="model-row" key={m.id}>
                            <label className="radio-label" title="设为全局默认模型">
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
                              placeholder={s.modelPlaceholder || '模型 id（如 gpt-image-2）'}
                              onChange={(e) => updateModel(s.id, m.id, { name: e.target.value })}
                            />
                            <select
                              className="source-select"
                              value={m.sourceId || (s.sources[0] && s.sources[0].id) || ''}
                              onChange={(e) => updateModel(s.id, m.id, { sourceId: e.target.value })}
                              title="该模型使用的 API 来源（与系列内置来源绑定）"
                            >
                              {(s.sources || []).map((src) => <option key={src.id} value={src.id}>{src.label}</option>)}
                            </select>
                            <button className="icon-btn" title="删除模型" onClick={() => removeModel(s.id, m.id)}>
                              <Icon name="trash" size={16} />
                            </button>
                          </div>
                        ))}
                      </div>

                      <div className="model-actions">
                        <button className="ghost-btn" onClick={() => addModel(s.id)}>
                          <Icon name="plus" size={15} /> 添加模型
                        </button>
                        <span className="field-hint">模型 id 由你填写（例如 {s.modelPlaceholder || '具体模型名'}）；左侧圆点为全局默认模型。</span>
                      </div>

                      {/* 来源级配置：API Key / API 地址（与「系列·来源」绑定） */}
                      <div className="source-cfgs">
                        {(s.sources || []).map((src) => {
                          const key = sourceKey(s.id, src.id);
                          const cfg = cfgOf(s.id, src.id);
                          const baseShown = cfg.baseUrl || src.baseUrl || '';
                          const overridden = !!cfg.baseUrl && cfg.baseUrl !== src.baseUrl;
                          return (
                            <div className="source-cfg" key={src.id}>
                              <div className="source-cfg-head">
                                <span className="source-cfg-title">{src.label}</span>
                                {src.apiKeyUrl && (
                                  <button
                                    className="link-btn"
                                    title={src.apiKeyUrl}
                                    onClick={() => window.stab.openExternal(src.apiKeyUrl)}
                                  >获取 API Key</button>
                                )}
                              </div>
                              <div className="field-inline">
                                <label>API Key</label>
                                <input
                                  type={showKeys[key] ? 'text' : 'password'}
                                  placeholder="sk-xxxxxxxx"
                                  value={cfg.apiKey}
                                  onChange={(e) => setCfg(s.id, src.id, { apiKey: e.target.value })}
                                />
                                <button
                                  className="ghost-btn"
                                  onClick={() => setShowKeys((v) => ({ ...v, [key]: !v[key] }))}
                                >{showKeys[key] ? '隐藏' : '显示'}</button>
                              </div>
                              <div className="field-inline">
                                <label>API 地址</label>
                                <input
                                  type="text"
                                  value={baseShown}
                                  onChange={(e) => setCfg(s.id, src.id, { baseUrl: e.target.value })}
                                />
                                <button
                                  className="ghost-btn"
                                  title={`恢复为内置默认地址：${src.baseUrl || '（无）'}`}
                                  disabled={!overridden}
                                  onClick={() => setCfg(s.id, src.id, { baseUrl: '' })}
                                >恢复默认</button>
                              </div>
                              {src.hint && <p className="field-hint">{src.hint}</p>}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}

                <div className="field">
                  <label>添加模型系列</label>
                  <div className="input-group">
                    <select value={pickSeriesId} onChange={(e) => setPickSeriesId(e.target.value)}>
                      <option value="">请选择内置模型系列…</option>
                      {addableSeries.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}（来源：{(s.sources || []).map((x) => x.label).join(' / ')}）
                        </option>
                      ))}
                    </select>
                    <button className="ghost-btn" disabled={!pickSeriesId} onClick={() => addSeries(pickSeriesId)}>
                      <Icon name="plus" size={15} /> 添加
                    </button>
                  </div>
                  {pickSeriesId && (
                    <p className="field-hint">
                      {(seriesList.find((x) => x.id === pickSeriesId) || {}).description}
                    </p>
                  )}
                  {!addableSeries.length && <p className="field-hint">全部内置模型系列都已添加到列表。</p>}
                </div>

                <p className="field-hint">
                  API Key 只保存在本机数据目录的 <code>settings.json</code>；模型系列与 API 来源的定义保存在
                  <code>model-series.json</code>（可手工编辑后重启生效）。
                </p>
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
                {modeSeries.length === 0 && (
                  <div className="empty-hint">当前没有任何模型系列支持同步/异步切换。</div>
                )}

                {modeSeries.map((s) => {
                  const value = (s.requestMode && s.requestMode.value) || 'sync';
                  const setMode = (v) => setDraftSeries((cur) => ({
                    ...cur,
                    series: cur.series.map((x) => (x.id === s.id ? { ...x, requestMode: { ...x.requestMode, value: v } } : x))
                  }));
                  return (
                    <div className="field" key={s.id}>
                      <label>请求模式 · {s.label}</label>
                      <label className="radio-card">
                        <input type="radio" name={`req-mode-${s.id}`} checked={value === 'sync'} onChange={() => setMode('sync')} />
                        <div>
                          <div className="radio-title">同步模式（默认）</div>
                          <div className="radio-desc">
                            当前对话需等待 API 返回后才能再次发送（发送按钮置灰，超时后恢复）。
                            多个对话标签各自独立等待、互不阻塞；其它标签返回结果时左侧显示黄点提醒。
                          </div>
                        </div>
                      </label>
                      <label className="radio-card">
                        <input type="radio" name={`req-mode-${s.id}`} checked={value === 'async'} onChange={() => setMode('async')} />
                        <div>
                          <div className="radio-title">异步模式（Task API）</div>
                          <div className="radio-desc">
                            请求头携带 X-DashScope-Async: enable，提交后获得 task_id，后台按指数退避轮询
                            （3 秒起、×1.5、上限 15 秒）直至成功 / 失败 / 超时。等待期间可继续发送；
                            PENDING 状态的任务可取消。应用重启后自动恢复轮询。
                          </div>
                        </div>
                      </label>
                      <p className="field-hint">
                        该配置只对「{s.label}」生效（保存在 <code>model-series.json</code>），两种模式均遵循「单次请求超时时间」。
                      </p>
                    </div>
                  );
                })}

                <div className="empty-hint">
                  其它模型系列（{seriesList.filter((s) => !(s.requestMode && s.requestMode.supported)).map((s) => s.label).join('、') || '无'}）
                  目前只支持同步模式：单次请求阻塞等待图片返回，不涉及任务轮询。
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
