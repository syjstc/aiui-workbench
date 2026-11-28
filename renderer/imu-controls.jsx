import React, { useState } from 'react';
import { FileUp, Play, RotateCcw, Square } from 'lucide-react';
import { imuParameters } from '../core/automation-contract.mjs';
import { NEUTRAL_POSE, poseQuaternion, rotateHeadVector } from '../shared/pose.mjs';
import { t } from './i18n.jsx';
import { StatusLabel } from './status-label.jsx';

const channels = [
  { key: 'orientation', label: '姿态四元数', short: '姿态', axes: ['X', 'Y', 'Z', 'W'], initial: poseQuaternion(NEUTRAL_POSE) },
  { key: 'accel', label: '加速度计', short: '加速度', unit: 'm/s²', axes: ['X', 'Y', 'Z'], initial: [0, 9.81, 0] },
  { key: 'gyro', label: '陀螺仪', short: '陀螺仪', unit: 'rad/s', axes: ['X', 'Y', 'Z'], initial: [0, 0, 0] },
  { key: 'magnetometer', label: '磁力计', short: '磁力计', unit: 'µT', axes: ['X', 'Y', 'Z'], initial: [0, -40, -25] },
];
const automaticValues = Object.fromEntries(channels.map(({ key }) => [key, null]));
const jsonExample = '{"frames":[{"atMs":0,"accel":[0,9.81,0]},{"atMs":200,"accel":[1.5,9.81,0]}]}';
const replayLabels = { playing: '正在回放', finished: '回放完成', stopped: '已停止回放' };

function nodExample() {
  const duration = 1200;
  const amplitude = 18 * Math.PI / 180;
  const frames = Array.from({ length: 61 }, (_, index) => {
    const atMs = index * 20;
    const phase = atMs / duration * Math.PI * 2;
    const pitch = -9 * (1 - Math.cos(phase));
    const orientation = poseQuaternion({ ...NEUTRAL_POSE, pitch });
    const inverse = [-orientation[0], -orientation[1], -orientation[2], orientation[3]];
    return {
      atMs, orientation, accel: rotateHeadVector([0, 0, 9.81], inverse),
      gyro: [-amplitude / 2 * Math.sin(phase) * 2 * Math.PI / (duration / 1000), 0, 0],
      magnetometer: rotateHeadVector([0, 25, -40], inverse),
    };
  });
  return { name: t('示例 · 点头'), parameters: { frames } };
}

export function ImuControls({ imu, ready, act }) {
  const [selected, select] = useState('accel');
  const [drafts, setDrafts] = useState({});
  const [trace, setTrace] = useState(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const { key, label, unit, axes, initial } = channels.find(channel => channel.key === selected);
  const current = imu?.values?.[key];
  const override = imu?.overrides?.[key];
  const replay = imu?.replay;
  const playing = replay?.status === 'playing';
  const disabled = pending || !ready;
  const inputsDisabled = disabled || playing;
  const draft = drafts[key];
  const values = draft || override || current || initial;
  const overrideCount = Object.keys(imu?.overrides || {}).length;
  const replayFrames = trace?.parameters.frames;

  function setDraft(next) {
    setDrafts(previous => ({ ...previous, [key]: next }));
  }

  async function send(action, parameters, onSuccess) {
    setError('');
    setPending(true);
    try {
      if (await act(action, parameters)) onSuccess?.();
      else setError(t('模拟器未完成操作，请稍后重试。'));
    } finally { setPending(false); }
  }

  async function loadFile(event) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    setPending(true);
    setError('');
    try {
      if (file.size > 4 * 1024 * 1024) {
        setError(t('IMU 文件不能超过 4 MB。'));
        return;
      }
      const parsed = imuParameters.imu_replay.safeParse(JSON.parse(await file.text()));
      if (!parsed.success) throw new Error('Invalid trace');
      setTrace({ name: file.name, parameters: parsed.data });
    } catch {
      setError(t('无法载入此文件。请检查 JSON、传感器数值和递增的 atMs 时间。'));
    } finally { setPending(false); }
  }

  function apply(event) {
    event.preventDefault();
    const parsed = imuParameters.imu_set.safeParse({ [key]: values.map(Number) });
    if (!parsed.success) {
      setError(t(key === 'orientation' ? '姿态需要单位四元数（X、Y、Z、W，长度为 1）。' : '请输入有效的数值。'));
      return;
    }
    send('imu_set', parsed.data, () => setDraft(null));
  }

  return <div className="imu-controls">
    <div className="imu-channel-pills" role="group" aria-label={t('传感器')}>
      {channels.map(({ key: id, short }) => <button type="button" key={id} aria-pressed={id === key} onClick={() => { select(id); setError(''); }}>
        {t(short)}<small>{t('{0} 个订阅', { 0: imu?.subscriptions?.[id] || 0 })}</small>
      </button>)}
    </div>
    <div className="imu-reading-heading">
      <strong>{t(label)} {unit && <small>{unit}</small>}</strong>
      <StatusLabel tone={playing ? 'working' : override ? 'action' : 'idle'}>{t(playing ? '正在回放' : override ? '固定值' : '自动输入')}</StatusLabel>
    </div>
    <dl className="imu-live-readings" aria-label={t('实时读数')}>{axes.map((axis, index) => <div key={axis}><dt>{axis}</dt><dd>{current?.[index]?.toFixed(3) ?? '—'}</dd></div>)}</dl>
    <p className="subtle">{t('已向应用发送 {0} 次读数', { 0: imu?.readings?.[key] || 0 })}</p>
    <form className="imu-editor" onSubmit={apply}>
      <div className="imu-editor-heading"><strong>{t('手动输入')}</strong><button type="button" className="text-button" disabled={inputsDisabled || !current} onClick={() => setDraft(current.map(String))}>{t('取当前读数')}</button></div>
      <div className="imu-axes">{axes.map((axis, index) => <label key={axis}>{axis}
        <input type="number" step="any" required aria-label={`${t(label)} ${axis}`}
          disabled={inputsDisabled} value={draft ? draft[index] : Number(values[index]).toFixed(4)}
          onChange={event => {
            const next = values.map(String);
            next[index] = event.target.value;
            setDraft(next);
          }}/>
      </label>)}</div>
      <div className="imu-actions">
        <button type="submit" className="button" disabled={inputsDisabled || !draft}>{t('应用数值')}</button>
        <button type="button" className="button" disabled={inputsDisabled || (!override && !draft)} onClick={() => {
          if (override) send('imu_set', { [key]: null }, () => setDraft(null));
          else setDraft(null);
        }}>{t('恢复自动')}</button>
        {overrideCount > 0 && <button type="button" className="text-button" disabled={inputsDisabled} onClick={() => send('imu_set', automaticValues, () => setDrafts({}))}>
          <RotateCcw size={13}/>{t('全部恢复自动')}
        </button>}
      </div>
    </form>
    <div className="imu-trace">
      <strong>{t('动作回放')}</strong>
      <div className="imu-actions">
        <label className="button imu-file"><FileUp size={15}/>{t('选择 JSON')}
          <input type="file" accept=".json,application/json" aria-label={t('选择 IMU JSON')} disabled={inputsDisabled} onChange={loadFile}/>
        </label>
        <button type="button" className="button" disabled={inputsDisabled} onClick={() => { setTrace(nodExample()); setError(''); }}>{t('加载点头示例')}</button>
      </div>
      {trace && <p className="imu-trace-name" title={trace.name}><strong>{trace.name}</strong><small>{t('{0} 帧 · {1} 秒', { 0: replayFrames.length, 1: (replayFrames.at(-1).atMs / 1000).toFixed(2) })}</small></p>}
      {playing ? <button type="button" className="button full" disabled={disabled} onClick={() => send('imu_stop')}><Square size={15}/>{t('停止回放')}</button>
        : <button type="button" className="button primary full" disabled={disabled || !trace} onClick={() => send('imu_replay', trace.parameters)}><Play size={15}/>{t('开始回放')}</button>}
      {replay && <div className="imu-replay-status" role="status"><span>{t(replayLabels[replay.status])} · {replay.sent}/{replay.total}</span>
        {playing && <progress aria-label={t('回放进度')} value={replay.sent} max={replay.total}/>}
      </div>}
    </div>
    {error && <p role="alert" className="camera-error">{error}</p>}
    <details className="imu-format"><summary>{t('JSON 格式')}</summary>
      <p className="subtle">{t('atMs 是从回放开始算起的毫秒数。每帧可包含 orientation、accel、gyro、magnetometer，省略的通道在该帧停报。')}</p>
      <code>{jsonExample}</code>
    </details>
  </div>;
}
