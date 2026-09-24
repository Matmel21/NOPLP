// ═══ YOUTUBE SYNC ══════════════════════════════════════════════════
import { state }       from './state.js';
import { advanceLine } from './lyrics.js';
import { esc }         from './utils.js';

// ── extractYtId ─────────────────────────────────────────────────────

export function extractYtId(url) {
  if (!url) return null;
  const m = url.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// ── Timestamp sync loop ──────────────────────────────────────────────

export function startSync() {
  stopSync();
  if (!state.timestamps.length) return; // manual advance mode
  state.syncInterval = setInterval(() => {
    if (!state.ytPlayer?.getCurrentTime) return;
    const t    = state.ytPlayer.getCurrentTime();
    const next = state.lineQueue[state.currentQueueIdx + 1];
    if (next === undefined) return;
    const ts = state.timestamps.find(ts => ts.lineIdx === next);
    if (ts && t >= ts.time) {
      clearTimeout(state._autoAdvanceTimer);
      advanceLine();
    }
  }, 100);
}

export function stopSync() {
  clearInterval(state.syncInterval);
  state.syncInterval = null;
}

// ── YouTube IFrame API initialisation ───────────────────────────────
// Called once from app.js. Sets the global callback the API script requires.

function showYtError(msg, ytUrl) {
  let overlay = document.getElementById('yt-error-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'yt-error-overlay';
    document.querySelector('.yt-container')?.appendChild(overlay);
  }
  // Only real web links: the URL comes from the catalogue, never trust it as HTML
  const href = /^https?:\/\//i.test(ytUrl) ? ytUrl : 'https://www.youtube.com';
  overlay.innerHTML = `<span>${esc(msg)}</span><a href="${esc(href)}" target="_blank" rel="noopener">Regarder sur YouTube →</a>`;
  overlay.classList.remove('hidden');
}

export function hideYtError() {
  document.getElementById('yt-error-overlay')?.classList.add('hidden');
}

export function initYouTube() {
  // Set callback BEFORE injecting the script tag so it's always defined first
  window.onYouTubeIframeAPIReady = () => {
    state.ytReady  = true;
    state.ytPlayer = new YT.Player('yt-player', {
      height: '100%', width: '100%', videoId: '',
      playerVars: { autoplay: 1, rel: 0, modestbranding: 1 },
      events: {
        onReady: () => {
          if (state.pendingYtId) {
            state.ytPlayer.loadVideoById(state.pendingYtId);
            state.pendingYtId = null;
          }
        },
        onStateChange: e => {
          if (e.data === YT.PlayerState.PLAYING) startSync();
          else stopSync();
        },
        onError: e => {
          // 100 = removed/private, 101/150 = embedding disabled
          const msg = (e.data === 100)
            ? 'Vidéo supprimée ou privée'
            : 'Lecture sur site externe désactivée';
          const ytUrl = state.song?.youtube_url || 'https://www.youtube.com';
          showYtError(msg, ytUrl);
        },
      },
    });
  };

  // Inject script after callback is set — guarantees no race condition
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
}
