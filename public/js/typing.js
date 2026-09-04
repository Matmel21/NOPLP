// ═══ TYPING — input handling & action buttons ══════════════════════
import { state }                                          from './state.js';
import { normalize, showToast }                           from './utils.js';
import { renderLyrics, showQueueLine, advanceLine, retreatLine,
         showTypingFor, clearTypingArea, updateScore }    from './lyrics.js';

// ── setupTypingArea ─────────────────────────────────────────────────
// Called at the start of each game (and each finale round).
// Clones the input & next-line button to strip stale event listeners.

export function setupTypingArea() {
  // Re-attach typing-input listener
  const input = document.getElementById('typing-input');
  const freshInput = input.cloneNode(true);
  input.parentNode.replaceChild(freshInput, input);
  freshInput.addEventListener('keydown', onTypingKeydown);

  // Re-attach next-line button listener
  const btn      = document.getElementById('btn-next-line');
  const freshBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(freshBtn, btn);
  freshBtn.addEventListener('click', () => {
    clearTimeout(state._autoAdvanceTimer);
    if (state.activeLine >= 0) {
      state.blanks
        .filter(b => b.lineIdx === state.activeLine && !b.revealed)
        .forEach(b => { b.revealed = true; b.correct = false; });
      renderLyrics();
      if (state.currentQueueIdx >= 0) showQueueLine(state.currentQueueIdx);
      updateScore();
    }
    // advanceLine(true) seeks + plays; showQueueLine will re-pause if next line has a blank
    advanceLine(true);
  });

  document.getElementById('typing-area').classList.remove('hidden');
  clearTypingArea();
}

// ── onTypingKeydown ─────────────────────────────────────────────────

function onTypingKeydown(e) {
  if (e.key !== 'Enter') return;
  const answer = document.getElementById('typing-input').value.trim();
  if (!answer) return;

  const activeBlanks = state.blanks.filter(b => b.lineIdx === state.activeLine && !b.revealed);
  if (!activeBlanks.length) { advanceLine(); return; }

  const blank   = activeBlanks[0];
  const correct = normalize(answer) === normalize(blank.phrase);
  blank.revealed = true;
  blank.correct  = correct;

  updateScore();
  renderLyrics();
  if (state.currentQueueIdx >= 0) showQueueLine(state.currentQueueIdx);

  const fb = document.getElementById('typing-feedback');
  if (correct) {
    fb.textContent = 'Correct !';
    fb.className   = 'typing-feedback correct';
    showToast('Bonne réponse !');
  } else {
    fb.textContent = `Réponse : ${blank.phrase}`;
    fb.className   = 'typing-feedback incorrect';
  }

  const remaining = state.blanks.filter(b => b.lineIdx === state.activeLine && !b.revealed);
  if (remaining.length) {
    showTypingFor(remaining[0]);
    return;
  }

  // Finale: correct answer → advance to next round
  if (state.gameMode === 'finale' && correct) {
    import('./game.js').then(({ nextFinaleRound }) => setTimeout(nextFinaleRound, 1000));
    return;
  }

  // Resume video (was paused for the blank)
  if (state.ytPlayer) {
    try { state.ytPlayer.playVideo(); } catch (_) {}
  }
  if (state.timestamps.length) {
    state.activeLine = -1;
    clearTypingArea();
  } else {
    setTimeout(advanceLine, 700);
  }
}

// ── Static listeners (registered once at startup via initTyping) ────

export function initTyping() {
  // Space / Arrow keys — navigation
  document.addEventListener('keydown', e => {
    if (document.getElementById('game-modal').classList.contains('hidden')) return;
    if (state.calibMode) return;
    if (document.activeElement === document.getElementById('typing-input')) return;

    if (e.code === 'Space' || e.code === 'ArrowRight') {
      e.preventDefault();
      if (state.activeLine < 0) { clearTimeout(state._autoAdvanceTimer); advanceLine(true); }
    } else if (e.code === 'ArrowLeft' && state.gameMode === 'revision') {
      e.preventDefault();
      retreatLine();
    }
  });

  // Revision nav buttons
  document.getElementById('btn-prev-line').addEventListener('click', retreatLine);
  document.getElementById('btn-next-revision').addEventListener('click', () => advanceLine(true));

  // Reveal all blanks
  document.getElementById('btn-reveal-all').addEventListener('click', () => {
    state.blanks.forEach(b => { b.revealed = true; b.correct = b.correct || false; });
    updateScore();
    renderLyrics();
    if (state.currentQueueIdx >= 0) showQueueLine(state.currentQueueIdx);
    clearTypingArea();
  });

  // Abandon current blank — reveal as incorrect, advance
  document.getElementById('btn-abandon').addEventListener('click', () => {
    if (state.activeLine < 0) return;
    const activeBlanks = state.blanks.filter(b => b.lineIdx === state.activeLine && !b.revealed);
    activeBlanks.forEach(b => { b.revealed = true; b.correct = false; });
    updateScore();
    renderLyrics();
    if (state.currentQueueIdx >= 0) showQueueLine(state.currentQueueIdx);
    const fb = document.getElementById('typing-feedback');
    if (activeBlanks[0]) {
      fb.textContent = `Réponse : ${activeBlanks[0].phrase}`;
      fb.className   = 'typing-feedback incorrect';
    }
    if (state.ytPlayer) { try { state.ytPlayer.playVideo(); } catch (_) {} }
    if (state.timestamps.length) {
      state.activeLine = -1;
      clearTypingArea();
    } else {
      setTimeout(advanceLine, 900);
    }
  });

  // INITIALES bonus (finale only, one-time per session)
  document.getElementById('btn-initiales').addEventListener('click', () => {
    if (state.finaleInitialesUsed || state.gameMode !== 'finale') return;
    state.finaleInitialesUsed  = true;
    state.finaleInitialesShown = true;
    document.getElementById('btn-initiales').classList.add('hidden');
    renderLyrics();
    if (state.currentQueueIdx >= 0) showQueueLine(state.currentQueueIdx);
  });
}
