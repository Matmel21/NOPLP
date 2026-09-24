// ═══ LYRICS — rendering & line advancement ════════════════════════
import { state }          from './state.js';
import { esc }            from './utils.js';
import { buildLineHtml }  from './blanks.js';
import { extractYtId }    from './youtube.js';

// ── renderLyrics ────────────────────────────────────────────────────
// Rebuilds the entire lyrics panel DOM. All lines start hidden;
// showQueueLine() reveals the sliding window.

export function renderLyrics() {
  const panel = document.getElementById('lyrics-panel');
  const lines = state.lines || [];

  const visibleLines = state.gameMode === 'mc'
    ? lines.slice(0, (state.blanks[0]?.lineIdx ?? lines.length - 1) + 1)
    : lines;

  panel.innerHTML = visibleLines.map((line, i) => {
    const lineBlanks          = state.blanks.filter(b => b.lineIdx === i);
    const multiLineContinuation = state.blanks.find(b => b.multiLine && b.lineIdx2 === i);

    if (!lineBlanks.length && !multiLineContinuation) {
      return `<div class="lyric-line" data-line="${i}">${esc(line)}</div>`;
    }
    if (multiLineContinuation && !lineBlanks.length) {
      // Always show only the text that comes AFTER the phrase ends on this line.
      // The full phrase is already visible in the revealed span on the primary line,
      // so we never re-display the blank portion here — even after revelation.
      const remainder = esc(line.slice(multiLineContinuation.charsOnLine2).trimStart());
      return `<div class="lyric-line" data-line="${i}">${remainder}</div>`;
    }
    return `<div class="lyric-line blank-line" data-line="${i}">${buildLineHtml(line, lineBlanks)}</div>`;
  }).join('');
}

// ── showQueueLine ───────────────────────────────────────────────────
// Reveals a sliding window of 2 past lines + the current line.
// Pauses the YouTube player when the current line contains an unanswered blank.

export function showQueueLine(idx) {
  const panel = document.getElementById('lyrics-panel');
  panel.querySelectorAll('.lyric-line').forEach(el =>
    el.classList.remove('active', 'past', 'visible')
  );
  if (idx < 0) return;

  const queueLine = state.lineQueue[idx];

  const activeEl = panel.querySelector(`.lyric-line[data-line="${queueLine}"]`);
  if (activeEl) activeEl.classList.add('active', 'visible');

  for (let i = Math.max(0, idx - 2); i < idx; i++) {
    const el = panel.querySelector(`.lyric-line[data-line="${state.lineQueue[i]}"]`);
    if (el) el.classList.add('past', 'visible');
  }

  // Revision mode: just highlight the line and update position counter
  if (state.gameMode === 'revision') {
    const pos = document.getElementById('revision-position');
    if (pos) pos.textContent = `${idx + 1} / ${state.lineQueue.length}`;
    return;
  }

  const activeBlanks = state.blanks.filter(b => b.lineIdx === queueLine && !b.revealed);
  if (activeBlanks.length) {
    state.activeLine = queueLine;
    if (state.gameMode === 'mc') {
      // MC: don't pause, don't ask for input — switch to karaoke if available
      clearTypingArea();
      if (state.mcVideoMode === 'karaoke' && state.ytPlayer && state.song?.karaoke_url) {
        const videoId = extractYtId(state.song.karaoke_url);
        if (videoId) {
          try {
            const t = state.ytPlayer.getCurrentTime?.() ?? 0;
            state.ytPlayer.loadVideoById({ videoId, startSeconds: t });
          } catch (_) {}
        }
      }
    } else {
      showTypingFor(activeBlanks[0]);
      if (state.ytPlayer) {
        try { state.ytPlayer.pauseVideo(); } catch (_) {}
      }
    }
  } else {
    state.activeLine = -1;
    clearTypingArea();
    if (!state.timestamps.length) showSpaceHint();
  }
}

// ── advanceLine ─────────────────────────────────────────────────────
// Moves to the next line in the queue.
// seekVideo=true: seek + play the YouTube player to the line's timestamp first,
// so that showQueueLine's pauseVideo (for blanks) properly overrides the play.

export function retreatLine() {
  const prev = state.currentQueueIdx - 1;
  if (prev < 0) return;
  state.currentQueueIdx = prev;
  if (state.timestamps.length && state.ytPlayer) {
    const ts = state.timestamps.find(t => t.lineIdx === state.lineQueue[prev]);
    if (ts) {
      try { state.ytPlayer.seekTo(ts.time, true); state.ytPlayer.playVideo(); } catch (_) {}
    }
  }
  showQueueLine(prev);
}

export function advanceLine(seekVideo = false) {
  const next = state.currentQueueIdx + 1;
  if (next >= state.lineQueue.length) {
    // Lazy import to avoid circular dependency at module-evaluation time
    import('./game.js').then(({ finishGame }) => finishGame());
    return;
  }
  state.currentQueueIdx = next;

  if (seekVideo && state.timestamps.length && state.ytPlayer) {
    const ts = state.timestamps.find(t => t.lineIdx === state.lineQueue[next]);
    if (ts) {
      try {
        state.ytPlayer.seekTo(ts.time, true);
        state.ytPlayer.playVideo();
      } catch (_) {}
    }
  }

  showQueueLine(next);
}

// ── Score helpers ────────────────────────────────────────────────────

export function updateScore() {
  const correct = state.blanks.filter(b => b.revealed && b.correct).length;
  state.score   = Math.round((correct / (state.totalBlanks || 1)) * 100);
  document.getElementById('score-display').textContent = state.score;
  updateBlanksLeft();
}

export function updateBlanksLeft() {
  const remaining = state.blanks.filter(b => !b.revealed).length;
  document.getElementById('blanks-left').textContent =
    remaining > 0 ? `${remaining} trou${remaining > 1 ? 's' : ''} restant${remaining > 1 ? 's' : ''}` : '';
}

// ── Typing area display ──────────────────────────────────────────────
// Kept here (rather than typing.js) to avoid a circular import chain.

export function showTypingFor(blank) {
  const prompt = state.gameMode === 'finale'
    ? 'Complétez la phrase :'
    : `Complétez : « ${blank.phrase.replace(/./g, '·')} »`;
  document.getElementById('typing-prompt').textContent   = prompt;
  document.getElementById('typing-input').value          = '';
  document.getElementById('typing-feedback').textContent = '';
  document.getElementById('typing-area').classList.remove('hidden');
  document.getElementById('btn-next-line').classList.add('hidden');
  document.getElementById('btn-abandon').classList.remove('hidden');
  document.getElementById('typing-input').focus();
}

export function clearTypingArea() {
  document.getElementById('btn-next-line').classList.remove('hidden');
  document.getElementById('btn-abandon').classList.add('hidden');
  document.getElementById('typing-input').value          = '';
  document.getElementById('typing-feedback').textContent = '';
  document.getElementById('typing-prompt').textContent   = 'Tapez la phrase manquante :';
}

export function showSpaceHint() {
  document.getElementById('typing-prompt').innerHTML =
    '<span class="space-hint-inline">Espace</span> pour continuer';
  document.getElementById('typing-input').value          = '';
  document.getElementById('typing-feedback').textContent = '';
}
