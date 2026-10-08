import React, { useEffect, useMemo, useState } from 'react';
import { useApp, useToast } from '../lib/store.jsx';
import { uid } from '../lib/util.js';
import { sourceConfigOf, sourceKey } from '../lib/models.js';
import { titleDefaults } from '../lib/title.js';
import Icon from './Icon.jsx';

const TABS = [
  { id: 'model', label: '模型设置' },
  { id: 'rename', label: '重命名模型' },
  { id: 'basic', label: '基础设置' },
  { id: 'advanced', label: '高级设置' },
  { id: 'data', label: '数据管理' }
];

/** 导入失败的错误码 → 界面文案（主进程两道校验各有自己的码，见 electron/src/dataTransfer.js） */
const IMPORT_ERROR_LABEL = {
  BAD_NAME: '包名不符合格式',
  BAD_STRUCTURE: '包内目录不符合协议',
  BAD_VERSION: '导出包版本过新',
  BAD_ZIP: '压缩包损坏或无法解压',
  COPY_FAILED: '图片写入失败',
  SAVE_FAILED: '数据写入失败',
  BAD_DEST: '数据目录不可用'
};

const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * 关闭窗口行为的界面口径（**权威实现**在主进程 electron/src/closeBehavior.js，
 * 这里只用来显示「跟随默认」的默认值文案与「当前生效」提示，两处规则必须一致）：
 *   · 数据目录形态 kind = 'dev'（npm run dev，未打包）→ 直接退出程序
 *   · 其余（'user' 安装版 / 'portable' 便携版，都是打包后运行）→ 最小化到托盘
 */
const defaultCloseAction = (paths) => ((paths && paths.kind === 'dev') ? 'quit' : 'tray');

/** 「当前生效」文案：用户选过就报用户的选择，没选过就报默认值（并说明它来自默认） */
const closeActionText = (closeAction, fallback) => {
  const v = closeAction === 'tray' || closeAction === 'quit' ? closeAction : '';
  const label = (x) => (x === 'tray' ? '最小化到托盘' : '直接退出程序');
  return v ? `${label(v)}（已设置）` : `${label(fallback)}（跟随默认）`;
};

export default function SettingsModal({ initialTab = 'model' }) {
  const { state, dispatch, flushSave } = useApp();
  const toast = useToast();
  const [tab, setTab] = useState(initialTab);
  const [draft, setDraft] = useState(() => clone(state.settings));
  // 系列配置草稿（可写字段：hidden —— 从「模型设置」列表移除；请求模式只有同步一种，没有开关）
  const [draftSeries, setDraftSeries] = useState(() => clone(state.modelSeries || { series: [] }));
  // 重命名模型配置草稿（可写字段：temperature / topP / 提示模板等，存数据目录的 rename-model.json）
  const [draftRename, setDraftRename] = useState(() => (
    state.renameConfig ? clone(state.renameConfig) : clone(titleDefaults(state))
  ));
  const [showKeys, setShowKeys] = useState({});      // { '<seriesId>.<sourceId>': true }
  const [showRenameKey, setShowRenameKey] = useState(false);
  const [pickSeriesId, setPickSeriesId] = useState('');
  // ---- 数据管理（配置 + 聊天记录 导出 / 导入）----
  const [transferBusy, setTransferBusy] = useState('');       // '' | 'export' | 'import'
  const [importResult, setImportResult] = useState(null);     // {source, parts, notes, media}

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

  const seriesList = draftSeries.series || [];
  const groups = draft.modelGroups || [];
  const defaultClose = defaultCloseAction(state.paths);   // 基础设置：「关闭窗口时」的默认值

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

  // ---------- 重命名模型（会话标签自动命名） ----------
  const renameDef = titleDefaults(state);
  const renameCfg = { apiKey: '', baseUrl: '', modelId: '', ...(draft.renameModel || {}) };
  const renameBaseShown = renameCfg.baseUrl || renameDef.baseUrl;                 // 留空 = 显示写死的默认地址
  const renameBaseOverridden = !!renameCfg.baseUrl && renameCfg.baseUrl !== renameDef.baseUrl;

  const setRename = (patch) => setDraft((d) => ({
    ...d,
    renameModel: { apiKey: '', baseUrl: '', modelId: '', ...(d.renameModel || {}), ...patch }
  }));

  /** 滑动条：温度 / Top-P（写回数据目录的 rename-model.json） */
  const setRenameCfg = (patch) => setDraftRename((c) => ({ ...c, ...patch }));
  const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
  const renameTemp = num(draftRename.temperature, renameDef.temperature);
  const renameTopP = num(draftRename.topP, renameDef.topP);

  // ---------- 数据管理：导出 / 导入（配置 + 聊天记录） ----------
  /**
   * 导出：先 flushSave（渲染进程是数据编辑主体，主进程内存里必须是最新的），
   * 再由主进程弹「另存为」→ 打包成 `ss-YYYYMMDD-HHmm.zip`。
   */
  const doExport = async () => {
    if (transferBusy) return;
    setTransferBusy('export');
    try {
      await flushSave();
      const r = await window.stab.exportData();
      if (r.canceled) return;
      if (!r.ok) { toast(`导出失败：${r.message || '未知错误'}`, 'error', { timeout: 8000 }); return; }
      const bits = [`${r.conversations} 个对话`, `${r.messages} 条消息`, `${r.images} 张图片`];
      if (r.missing) bits.push(`${r.missing} 张图片文件已不存在（未包含）`);
      if (r.renamedFrom) bits.push(`文件名已按协议改为 ${String(r.path).split(/[\\/]/).pop()}`);
      toast(`已导出：${bits.join(' · ')}`, 'info', { path: r.path, timeout: 9000 });
      window.stab.log('info', '导出配置与聊天记录', { path: r.path, conversations: r.conversations, images: r.images });
    } catch (e) {
      toast('导出失败：' + e.message, 'error');
    } finally {
      setTransferBusy('');
    }
  };

  /**
   * 导入：主进程做两道校验（包名 → 包内目录协议）+ 智能合并 + 图片叠加；
   * 成功后用返回的四份数据整体替换本地状态，并把弹窗里的草稿同步成导入后的值
   * （避免之后点「保存」把导入的设置又盖回去）。
   */
  const doImport = async () => {
    if (transferBusy) return;
    setTransferBusy('import');
    try {
      await flushSave();
      const r = await window.stab.importData();
      if (r.canceled) return;
      if (!r.ok) {
        const label = IMPORT_ERROR_LABEL[r.code] || '导入失败';
        toast(`${label}：${r.message || '未知错误'}`, 'error', { timeout: 10000 });
        window.stab.log('warn', '导入被拒绝', { code: r.code, message: r.message });
        return;
      }
      dispatch({ type: 'DATA_IMPORT', state: r.state });
      setDraft(clone(r.state.settings));
      setDraftSeries(clone(r.state.modelSeries));
      setDraftRename(clone(r.state.renameConfig));
      const s = r.summary || {};
      const med = r.media || { copied: 0, skipped: 0 };
      const bits = [
        `对话 +${s.conversations || 0}${s.skippedConversations ? `（跳过重复 ${s.skippedConversations}）` : ''}`,
        `消息 +${s.messages || 0}`,
        `模型 +${s.addedModels || 0}${s.ignoredModels ? `（忽略 ${s.ignoredModels}）` : ''}`,
        s.addedSeries ? `系列 +${s.addedSeries}` : '',
        `图片 +${med.copied}${med.skipped ? `（已存在 ${med.skipped}）` : ''}`
      ].filter(Boolean);
      setImportResult({ source: r.source, parts: bits, notes: r.notes || [] });
      toast(`导入完成（${r.source}）：${bits.join(' · ')}`, 'info', { timeout: 9000 });
      window.stab.log('info', '导入配置与聊天记录完成', { source: r.source, summary: s, media: med, notes: r.notes });
    } catch (e) {
      toast('导入失败：' + e.message, 'error', { timeout: 9000 });
    } finally {
      setTransferBusy('');
    }
  };

  // ---------- 保存 ----------
  const save = () => {
    const cleaned = clone(draft);
    cleaned.requestTimeoutSec = Math.min(3600, Math.max(15, Number(cleaned.requestTimeoutSec) || 300));
    cleaned.compressMaxMB = Math.min(100, Math.max(0.5, Number(cleaned.compressMaxMB) || 10));
    // 保存文件名取自提示词前 N 个字：0 = 关闭（始终用原文件名）
    cleaned.saveNamePromptChars = Math.min(50, Math.max(0, Math.round(Number(cleaned.saveNamePromptChars) || 0)));
    // 关闭窗口行为：只认 'tray' / 'quit'，其余（含从未设置）一律回 '' = 跟随默认（主进程同口径，见 closeBehavior.js）
    cleaned.closeAction = (cleaned.closeAction === 'tray' || cleaned.closeAction === 'quit') ? cleaned.closeAction : '';
    // 重命名模型：三个字段都是字符串，留空 = 用代码里的默认地址 / 默认模型
    const rm = cleaned.renameModel || {};
    cleaned.renameModel = {
      apiKey: String(rm.apiKey || '').trim(),
      baseUrl: String(rm.baseUrl || '').trim(),
      modelId: String(rm.modelId || '').trim()
    };

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

    dispatch({ type: 'SETTINGS_UPDATE', settings: cleaned, modelSeries: draftSeries, renameConfig: draftRename });
    toast('设置已保存', 'info');
    window.stab.log('info', '设置已更新', {
      theme: cleaned.theme, timeout: cleaned.requestTimeoutSec,
      compress: cleaned.compressEnabled, maxMB: cleaned.compressMaxMB,
      closeAction: cleaned.closeAction || `默认(${defaultClose})`,
      series: cleaned.modelGroups.map((g) => `${g.seriesId}:${g.models.length}`).join(','),
      models: allModels.length,
      defaultModel: cleaned.defaultModelId,
      renameModel: `${cleaned.renameModel.modelId || '（默认）'}@${cleaned.renameModel.baseUrl || '（默认地址）'}`,
      renameModelConfigured: !!cleaned.renameModel.apiKey,
      renameLlm: `temperature=${renameTemp},topP=${renameTopP}`
    });
    close();
  };

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

            {/* ---------- 重命名模型（会话标签自动命名） ---------- */}
            {tab === 'rename' && (
              <div className="settings-section">
                <div className="settings-tip">
                  提示：使用 <code>deepseek-flash</code> 模型非思考模式（请求体 <code>reasoning.effort = none</code>，
                  接口走 DeepSeek <code>Responses</code>：<code>POST {renameDef.baseUrl}/responses</code>）。
                  新会话先按序号命名（空对话保持序号），出现首条文字后由该模型压成一句短标题作为标签名；
                  未配置 API Key 或调用失败时，直接截取首条文字。
                </div>

                <div className="field">
                  <label>API Key</label>
                  <div className="input-group">
                    <input
                      type={showRenameKey ? 'text' : 'password'}
                      placeholder="sk-xxxxxxxx"
                      value={renameCfg.apiKey}
                      onChange={(e) => setRename({ apiKey: e.target.value })}
                    />
                    <button className="ghost-btn" onClick={() => setShowRenameKey((v) => !v)}>
                      {showRenameKey ? '隐藏' : '显示'}
                    </button>
                  </div>
                  <p className="field-hint">DeepSeek 开放平台的 API Key（不填则不做模型命名，只用首条文字）。</p>
                </div>

                <div className="field">
                  <label>API 地址</label>
                  <div className="input-group">
                    <input
                      type="text"
                      value={renameBaseShown}
                      onChange={(e) => setRename({ baseUrl: e.target.value })}
                    />
                    <button
                      className="ghost-btn"
                      title={`恢复为内置默认地址：${renameDef.baseUrl}`}
                      disabled={!renameBaseOverridden}
                      onClick={() => setRename({ baseUrl: '' })}
                    >恢复默认</button>
                  </div>
                  <p className="field-hint">
                    默认 <code>{renameDef.baseUrl}</code>（随程序内置，留空即使用默认；也可在数据目录的
                    <code>rename-model.json</code> 里改）。
                    填完整端点（如 <code>{renameDef.baseUrl}/responses</code>）也能被原样识别。
                  </p>
                </div>

                <div className="field">
                  <label>模型 id</label>
                  <input
                    type="text"
                    placeholder="模型id"
                    value={renameCfg.modelId}
                    onChange={(e) => setRename({ modelId: e.target.value })}
                  />
                  <p className="field-hint">
                    留空 = 内置默认 <code>{renameDef.modelId}</code>。注意这里是 <b>Responses</b> 接口，
                    与 chat/completions 不是同一套格式，模型 id 需支持 <code>/responses</code>。
                  </p>
                </div>

                <div className="field">
                  <label>模型温度（temperature）</label>
                  <div className="slider-row">
                    <input
                      type="range" min={0} max={2} step={0.1}
                      value={renameTemp}
                      onChange={(e) => setRenameCfg({ temperature: Number(e.target.value) })}
                    />
                    <span className="slider-value">{renameTemp.toFixed(1)}</span>
                  </div>
                  <p className="field-hint">默认 0.5。数值越低标题越稳定收敛，越高越发散。</p>
                </div>

                <div className="field">
                  <label>Top-P</label>
                  <div className="slider-row">
                    <input
                      type="range" min={0} max={1} step={0.05}
                      value={renameTopP}
                      onChange={(e) => setRenameCfg({ topP: Number(e.target.value) })}
                    />
                    <span className="slider-value">{renameTopP.toFixed(2)}</span>
                  </div>
                  <p className="field-hint">
                    默认 0.5。注意：DeepSeek 官方说明非思考模式下 <code>top_p</code> 恒为 1.0，
                    该项只在思考模式生效，保持默认即可。
                  </p>
                </div>

                <div className="field">
                  <label>标题生成提示模板</label>
                  <textarea
                    className="template-area"
                    rows={10}
                    spellCheck={false}
                    value={draftRename.promptTemplate || ''}
                    onChange={(e) => setRenameCfg({ promptTemplate: e.target.value })}
                  />
                  <p className="field-hint">
                    模板里的 <code>&#123;$$&#125;</code> 会被替换成实际输入片段 <code>"text":"用户首条文字"</code>。
                    模型按模板生成 5~6 个汉字的标题（只输出 <code>&#123;"title":"…"&#125;</code>）；
                    改坏了可以点下面「恢复默认模板」。
                  </p>
                  <div className="input-group">
                    <button
                      className="ghost-btn"
                      disabled={!draftRename.promptTemplate || draftRename.promptTemplate === renameDef.promptTemplate}
                      onClick={() => setRenameCfg({ promptTemplate: renameDef.promptTemplate })}
                    >恢复默认模板</button>
                    {state.paths && state.paths.renameModelFile && (
                      <button
                        className="ghost-btn"
                        title={state.paths.renameModelFile}
                        onClick={() => window.stab.showInFolder(state.paths.renameModelFile)}
                      >打开配置文件位置</button>
                    )}
                  </div>
                </div>

                <p className="field-hint">
                  API Key 只保存在本机数据目录 <code>settings.json</code> 的 <code>renameModel</code> 字段；
                  温度 / Top-P / 提示模板保存在数据目录的 <code>rename-model.json</code>（可手工编辑，重启生效）。
                  该请求只发送「首条文字的前一段」，不发送图片。
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
                  <label>关闭窗口时</label>
                  <select value={draft.closeAction || ''} onChange={(e) => set({ closeAction: e.target.value })}>
                    <option value="">跟随默认（{defaultClose === 'tray' ? '最小化到托盘' : '直接退出程序'}）</option>
                    <option value="tray">最小化到托盘（后台继续运行）</option>
                    <option value="quit">直接退出程序</option>
                  </select>
                  <p className="field-hint">
                    「最小化到托盘」= 点 × 只是隐藏窗口：进程继续在后台运行，正在等待的生成请求不会中断；
                    单击托盘图标（或右键菜单「显示主界面」）即可唤回窗口，要彻底退出用托盘菜单里的「退出程序」。
                  </p>
                  <p className="field-hint">
                    默认（从未设置过）按运行方式决定：<b>开发模式（npm run dev）直接退出程序</b>，
                    <b>打包后的安装版 / 便携版最小化到托盘</b>；这里选了之后一律按你的选择走。
                    当前生效：{closeActionText(draft.closeAction, defaultClose)}。
                  </p>
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
                  <p className="field-hint">
                    默认 300 秒（5 分钟）。每个请求各自计时：等待超过该时长就中止并显示失败。
                    等待期间不影响继续发送 —— 同一个对话可以同时等多个请求，各自独立（见下方说明）。
                  </p>
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
                  <label>保存文件名取自提示词前 N 个字</label>
                  <input
                    type="number" min={0} max={50}
                    className="num-sm"
                    value={draft.saveNamePromptChars ?? 5}
                    onChange={(e) => set({ saveNamePromptChars: e.target.value })}
                  />
                  <p className="field-hint">
                    默认 5。「保存到下载」与「另存为」用提示词开头 N 个字做文件名（例：一只猫坐在-1.png）。
                    图片里没有提示词（自己拖入的图、旧缓存图）时沿用原文件名；0 = 关闭，始终沿用原文件名。
                    目标目录里重名时自动加 -1、-2 直到不重复。
                  </p>
                </div>

                <div className="empty-hint">
                  请求模式固定为「同步」：提交后阻塞等待图片返回，没有同步/异步开关。
                  等待返回期间仍可继续发送（输入框不再锁定）—— 同一个对话可以同时等 2 个以上互相独立的请求，
                  也可用用户气泡上的「新对话发送 / 当前对话发送」把同一条内容再发一遍，或单独中止某一次等待。
                </div>
              </div>
            )}

            {/* ---------- 数据管理（配置 + 聊天记录 导出 / 导入） ---------- */}
            {tab === 'data' && (
              <div className="settings-section">
                <div className="settings-tip">
                  导出把「设置 + 模型系列 + 重命名模型 + 全部聊天记录」以及聊天记录里用到的图片打成
                  <b>一个 zip</b>；导入时把它叠加到当前数据上（不会清空现有数据）。
                  导出包里含各「系列·来源」的 API Key，请妥善保管。
                </div>

                <div className="field">
                  <label>导出</label>
                  <div className="input-group">
                    <button className="ghost-btn" disabled={!!transferBusy} onClick={doExport}>
                      <Icon name="download" size={15} />
                      {transferBusy === 'export' ? '导出中…' : '导出配置与聊天记录…'}
                    </button>
                  </div>
                  <p className="field-hint">
                    导出包名固定为 <code>ss-YYYYMMDD-HHmm.zip</code>（如 <code>ss-20260213-1530.zip</code>，
                    精确到分钟）——这个名字是导入时的第一道校验，请勿改名。
                    图片只包含「聊天记录里实际引用到」的结果图（<code>cache/</code>）与输入图（<code>uploads/</code>），
                    已被清理的图片会跳过并在提示里说明。导出体积取决于这些图片的大小。
                  </p>
                </div>

                <div className="field">
                  <label>导入</label>
                  <div className="input-group">
                    <button className="ghost-btn" disabled={!!transferBusy} onClick={doImport}>
                      <Icon name="folderDownloadLine" size={15} />
                      {transferBusy === 'import' ? '导入中…' : '选择导出包导入…'}
                    </button>
                  </div>
                  <p className="field-hint">
                    先校验<b>包名</b>（必须是 <code>ss-日期-时间.zip</code>），再解压到程序缓存目录并校验
                    <b>包内目录协议</b>（<code>ss-export/</code> 下有 manifest 与四份 json，图片平铺在
                    <code>cache/</code>、<code>uploads/</code>）—— 任一条不满足会分别报错并原样保留当前数据。
                  </p>
                  <p className="field-hint">
                    合并规则：图片按文件名查重后直接叠加（目录 / 文件不存在则创建）；
                    <b>设置</b>按导入的值更新（主题、超时、压缩、保存命名、默认模型等，
                    默认保存路径仅在本机存在时采用），模型按「同 id / 同系列同来源同名」查重后追加，
                    当前没有的系列会自动新增；本机已填的 API Key / 地址不被覆盖（只补空缺）。
                    <b>聊天记录</b>按 id 查重后追加在列表最上面（标签名一起带过来）。
                  </p>
                </div>

                {importResult && (
                  <div className="import-result">
                    <div className="import-result-head">
                      <Icon name="folderDownloadLine" size={15} />
                      已导入 <code>{importResult.source}</code>
                    </div>
                    <ul className="import-result-list">
                      {importResult.parts.map((p) => <li key={p}>{p}</li>)}
                    </ul>
                    {importResult.notes.length > 0 && (
                      <ul className="import-result-notes">
                        {importResult.notes.map((n, i) => <li key={i}>{n}</li>)}
                      </ul>
                    )}
                  </div>
                )}

                {state.paths && (
                  <p className="field-hint">
                    当前数据目录：<code>{state.paths.root}</code>
                    （{state.paths.kind === 'portable' ? '便携版' : (state.paths.kind === 'user' ? '安装版（用户数据目录）' : '开发模式')}）
                    <button className="link-btn" onClick={() => window.stab.openPath(state.paths.root)}>打开</button>
                  </p>
                )}
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
