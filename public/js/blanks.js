// ═══ BLANKS — parsing & HTML rendering ════════════════════════════
import { state, FN_ROUNDS } from './state.js';
import { normalize, esc }   from './utils.js';

// ── Phrase matching ─────────────────────────────────────────────────
// Tolerates punctuation differences between fn_json phrases and lyrics
// (e.g. "gant de crin geyser" matches "gant de crin, geyser").

export function phraseMatchInText(phrase, text) {
  // Fast path: exact case-insensitive match
  const idx = text.toLowerCase().indexOf(phrase.toLowerCase());
  if (idx !== -1) return { start: idx, len: phrase.length };

  // Fuzzy: strip accents then allow any non-word chars between words
  const strip   = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const words   = strip(phrase).split(/\s+/).filter(w => w.length > 0);
  if (!words.length) return null;
  const pattern = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\W]+');
  const m       = new RegExp(pattern).exec(strip(text));
  if (!m) return null;
  return { start: m.index, len: m[0].length, fuzzy: true };
}

// ── parseBlanks ─────────────────────────────────────────────────────
// Reads state.song + state.gameMode/difficulty/finaleStep.
// Writes state.lines and state.blanks.

export function parseBlanks() {
  const { blanks_json, fn_json, mc_json, lyrics } = state.song;
  const { gameMode: mode, difficulty: diff, finaleStep } = state;

  // Revision mode: no blanks, just parse lines
  if (mode === 'revision') {
    state.lines  = (lyrics || '').split('\n').map(l => l.trim()).filter(l => l.length > 0);
    state.blanks = [];
    return;
  }

  let blanksMap = {};

  if (mode === 'mc' && mc_json) {
    try {
      const mc      = JSON.parse(mc_json);
      const phrases = Array.isArray(mc) ? mc : (mc.phrases || []);
      if (phrases.length > 0) {
        const chosen = phrases[Math.floor(Math.random() * phrases.length)];
        // Parse [coupure] marker — everything before it is the last visible text
        const COUPURE_RE = /\s*\[coupure\]\s*/i;
        const parts      = chosen.split(COUPURE_RE);
        const textBefore = (parts[0] || '').trim();

        const rawLines = (lyrics || '').split('\n').map(l => l.trim()).filter(l => l.length > 0);
        let cutLineIdx = rawLines.length - 1; // fallback: cut at very end
        let cutPos     = rawLines[cutLineIdx]?.length ?? 0;
        let found      = false;

        if (textBefore) {
          for (let i = 0; i < rawLines.length && !found; i++) {
            // Single-line match
            const single = phraseMatchInText(textBefore, rawLines[i]);
            if (single) {
              cutLineIdx = i;
              cutPos     = single.start + single.len;
              found      = true;
              break;
            }
            // Two-line combined match
            if (i < rawLines.length - 1) {
              const combined = rawLines[i] + ' ' + rawLines[i + 1];
              const multi    = phraseMatchInText(textBefore, combined);
              if (multi) {
                const endInCombined = multi.start + multi.len;
                if (endInCombined <= rawLines[i].length) {
                  // Ends on line i
                  cutLineIdx = i;
                  cutPos     = endInCombined;
                } else {
                  // Ends on line i+1
                  cutLineIdx = i + 1;
                  cutPos     = Math.min(endInCombined - rawLines[i].length - 1, rawLines[i + 1].length);
                }
                found = true;
              }
            }
          }
        }

        // Store the cut point as a special MC blank
        state.blanks = [{
          phrase: chosen,
          isMcCut: true,
          lineIdx: cutLineIdx,
          cutPos,
        }];
        state.lines = rawLines;
      }
    } catch (_) {}
    return; // MC mode: blanks already set above, skip normal parsing below

  } else if (mode === 'finale' && fn_json) {
    try {
      const fn        = JSON.parse(fn_json);
      const amountKey = String(FN_ROUNDS[finaleStep]); // keys in DB are "1000", "2000"…
      const phrases   = fn[amountKey] || fn[Number(amountKey)] || [];
      if (phrases.length > 0) {
        const chosen = phrases[Math.floor(Math.random() * phrases.length)];
        blanksMap[normalize(chosen)] = chosen;
      }
    } catch (_) {}

  } else if (blanks_json) {
    try {
      const bj      = JSON.parse(blanks_json);
      const phrases = bj[String(diff)] || bj[diff] || [];
      if (phrases.length > 0) {
        const chosen = phrases.includes(state.forcedPhrase)
          ? state.forcedPhrase
          : phrases[Math.floor(Math.random() * phrases.length)];
        blanksMap[normalize(chosen)] = chosen;
      }
    } catch (_) {}
  }

  const lines = (lyrics || '').split('\n').map(l => l.trim()).filter(l => l.length > 0);
  state.lines  = lines;
  state.blanks = [];

  // All modes: only blank the first occurrence of the chosen phrase
  const singleBlankMode = true;

  lines.forEach((line, lineIdx) => {
    Object.values(blanksMap).forEach(phrase => {
      if (singleBlankMode && state.blanks.some(b => normalize(b.phrase) === normalize(phrase))) return;

      // Single-line match
      const single = phraseMatchInText(phrase, line);
      if (single) {
        state.blanks.push({ phrase, lineIdx, matchStart: single.start, matchLen: single.len, revealed: false, correct: false });
        return;
      }

      // Two-line match (phrase spans a line break)
      if (lineIdx >= lines.length - 1) return;
      const line2    = lines[lineIdx + 1];
      const combined = line + ' ' + line2;
      const multi    = phraseMatchInText(phrase, combined);
      if (!multi || multi.start >= line.length) return;

      let charsOnLine2 = Math.max(0, (multi.start + multi.len) - (line.length + 1));
      // If fuzzy match length is off-by-a-few, consume all of line2
      if (charsOnLine2 >= line2.length - 5) charsOnLine2 = line2.length;

      state.blanks.push({
        phrase, lineIdx,
        matchStart:  multi.start,
        matchLen:    Math.min(multi.len, line.length - multi.start),
        multiLine:   true,
        lineIdx2:    lineIdx + 1,
        charsOnLine2,
        revealed: false, correct: false,
      });
    });
  });
}

// ── buildLineQueue ──────────────────────────────────────────────────
// Determines which lines to display (MC mode stops at the first blank).

export function buildLineQueue() {
  const lines = state.lines || [];

  // Continuation lines whose entire content belongs to the blank on the previous
  // line should be skipped in the queue — there is nothing for the user to read
  // or interact with there (the full phrase is shown in the revealed span on line 1).
  const skipLines = new Set(
    state.blanks
      .filter(b => b.multiLine)
      .map(b => b.lineIdx2)
  );

  if (state.gameMode === 'mc') {
    const cut = state.blanks[0];
    const stop = cut ? cut.lineIdx : lines.length - 1;
    state.lineQueue = lines.slice(0, stop + 1).map((_, i) => i).filter(i => !skipLines.has(i));
  } else {
    state.lineQueue = lines.map((_, i) => i).filter(i => !skipLines.has(i));
  }
  state.currentQueueIdx = -1;
}

// ── buildLineHtml ───────────────────────────────────────────────────
// Renders a single lyric line with blank placeholders injected.

export function buildLineHtml(line, blanks) {
  const sorted = [...blanks].sort((a, b) => (a.cutPos ?? a.matchStart ?? 0) - (b.cutPos ?? b.matchStart ?? 0));
  let result = '';
  let cursor = 0;

  sorted.forEach(b => {
    // MC cut: intercept before any idx lookup — cutPos is the split point on this line
    if (b.isMcCut) {
      result += esc(line.slice(cursor, b.cutPos));
      result += `<span class="lyric-blank mc-blank">▶ À vous de chanter…</span>`;
      cursor = line.length;
      return;
    }

    const idx = b.matchStart ?? line.toLowerCase().indexOf(b.phrase.toLowerCase(), cursor);
    const len = b.matchLen  ?? b.phrase.length;
    if (idx == null || idx === -1 || idx < cursor) return;

    result += esc(line.slice(cursor, idx));

    if (b.revealed) {
      const cls = b.correct ? 'revealed correct' : 'revealed incorrect';
      result += `<span class="lyric-blank ${cls}">${esc(b.phrase)}</span>`;

    } else {
      // Word-by-word equal-width boxes (TV-show style) — every mode except MC.
      // (MC blanks use the isMcCut branch above and never reach here.)
      const words        = b.phrase.split(/\s+/).filter(w => w.length > 0);
      // Initials are a finale-only bonus; in other modes they stay hidden.
      const showInitials = state.gameMode === 'finale' && state.finaleInitialesShown;
      // Apostrophe prefix: "l'amour" → letter="l", apostrophe match
      const apostropheRe = /^([a-zA-ZàâäéèêëîïôùûüçÀÂÄÉÈÊËÎÏÔÙÛÜÇ])'(.+)/;
      const inner = words.map(w => {
        const apo = w.match(apostropheRe);
        if (!showInitials) {
          return `<span class="blank-word"></span>`;
        }
        // Single-letter word (à, a, y…) — reveal it when initials are shown
        if (w.length === 1) {
          return `<span class="blank-word blank-single">${esc(w)}</span>`;
        }
        if (apo) {
          return `<span class="blank-word"><span class="blank-initial">${esc(apo[1].toUpperCase())}'</span></span>`;
        }
        return `<span class="blank-word"><span class="blank-initial">${esc(w[0].toUpperCase())}</span></span>`;
      }).join('');
      result += `<span class="lyric-blank-group" data-phrase="${esc(b.phrase)}">${inner}</span>`;
    }

    // multiLine: phrase bleeds onto the next line → consume to end of this line
    cursor = b.multiLine ? line.length : idx + len;
  });

  result += esc(line.slice(cursor));
  return result;
}
