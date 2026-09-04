// ═══ CALIBRATION MODE ══════════════════════════════════════════════
import { state }             from './state.js';
import { api }               from './api.js';
import { formatTime, showToast } from './utils.js';
import { showQueueLine }     from './lyrics.js';
import { startSync }         from './youtube.js';

// ── enterCalibMode / exitCalibMode ───────────────────────────────────

export function enterCalibMode() {
  state.calibMode       = true;
  state.calibTimestamps = JSON.parse(JSON.stringify(state.timestamps));

  document.getElementById('calib-overlay').classList.remove('hidden');
  document.getElementById('btn-calibrate').classList.add('active');
  document.getElementById('lyrics-panel').classList.add('calib-full');

  document.querySelectorAll('.lyric-line').forEach(el => {
    el.classList.add('calib-mode', 'visible');
    const existing = state.calibTimestamps.find(ts => ts.lineIdx === parseInt(el.dataset.line));
    if (existing) {
      el.classList.add('has-ts');
      attachTsTag(el, existing.time);
    }
    el.addEventListener('click', onCalibLineClick);
  });
}

export function exitCalibMode() {
  state.calibMode = false;
  document.getElementById('calib-overlay').classList.add('hidden');
  document.getElementById('btn-calibrate').classList.remove('active');
  document.getElementById('lyrics-panel').classList.remove('calib-full');

  document.querySelectorAll('.lyric-line').forEach(el => {
    el.classList.remove('calib-mode', 'has-ts');
    el.removeEventListener('click', onCalibLineClick);
    el.querySelectorAll('.ts-tag').forEach(t => t.remove());
  });

  if (state.currentQueueIdx >= 0) showQueueLine(state.currentQueueIdx);
}

// ── Line click handler ───────────────────────────────────────────────

function onCalibLineClick() {
  if (!state.calibMode || !state.ytPlayer) return;
  const lineIdx  = parseInt(this.dataset.line);
  const t        = state.ytPlayer.getCurrentTime?.() ?? 0;
  const existing = state.calibTimestamps.findIndex(ts => ts.lineIdx === lineIdx);
  if (existing >= 0) state.calibTimestamps[existing].time = t;
  else state.calibTimestamps.push({ lineIdx, time: t });
  this.classList.add('has-ts');
  this.querySelectorAll('.ts-tag').forEach(tag => tag.remove());
  attachTsTag(this, t);
}

function attachTsTag(el, t) {
  const tag       = document.createElement('span');
  tag.className   = 'ts-tag';
  tag.textContent = formatTime(t);
  el.appendChild(tag);
}

// ── Static listeners (registered once via initCalibration) ──────────

export function initCalibration() {
  document.getElementById('btn-calibrate').addEventListener('click', () => {
    if (state.calibMode) exitCalibMode();
    else enterCalibMode();
  });

  document.getElementById('btn-calib-save').addEventListener('click', async () => {
    state.timestamps = state.calibTimestamps;
    state.song.timestamps_json = JSON.stringify(state.timestamps);
    if (state.song.progress) state.song.progress.timestamps_json = state.song.timestamps_json;
    try {
      await api.put('/api/songs/' + encodeURIComponent(state.song.id) + '/timestamps', { timestamps: state.timestamps });
      showToast('Timestamps sauvegardés');
    } catch (_) {
      showToast("Sauvegarde échouée (vérifiez l'API)");
    }
    exitCalibMode();
    startSync();
  });

  document.getElementById('btn-calib-cancel').addEventListener('click', exitCalibMode);
}
