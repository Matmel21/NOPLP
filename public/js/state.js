// ═══ SHARED STATE ══════════════════════════════════════════════════
// Single mutable object shared across all modules via ES-module live bindings.
// Mutate properties directly — never reassign the object itself.

export const FN_ROUNDS = [1000, 2000, 5000, 10000, 20000];

export const state = {
  // Navigation
  view: 'home',

  // Library filters
  page: 0, limit: 50, search: '', mastery: '', type: '', sort: '', playlist: null,

  // Current song & game config
  song:        null,
  gameMode:    'normal',   // 'normal' | 'mc' | 'finale' | 'revision'
  difficulty:  0,
  finaleStep:  0,          // index into FN_ROUNDS (0-4)

  // Blanks & lyrics
  blanks:          [],     // [{ phrase, lineIdx, matchStart, matchLen, multiLine?, ... }]
  lines:           [],     // lyrics split into trimmed, non-empty lines
  lineQueue:       [],     // ordered line indices to display
  currentQueueIdx: -1,
  activeLine:      -1,     // lineIdx that currently has an unanswered blank (-1 = none)
  score:           0,
  totalBlanks:     0,

  // YouTube
  ytPlayer:    null,
  ytReady:     false,
  pendingYtId: null,
  syncInterval: null,
  timestamps:  [],         // [{ lineIdx, time }] from calibration

  // Calibration
  calibMode:        false,
  calibTimestamps:  [],    // working copy while calibrating

  // Finale bonus
  finaleInitialesUsed:  false, // consumed for the entire finale session
  finaleInitialesShown: false, // showing initials for the current blank

  // Video source for the player, toggled by the Karaoke button (any manche)
  mcVideoMode: 'classic',      // 'classic' (official clip) | 'karaoke'

  // Revision queue
  revisionQueue:    [],
  revisionQueueIdx: -1,
  quickPlay:        false,   // false, or the mode ('normal' | 'mc') a series plays without the mode modal

  // Set by startGame's options
  forcedPhrase: null,        // lyrics to hide instead of a random pick (daily challenge)
  isChallenge:  false,       // this run is the daily challenge

  // Internal timers
  _autoAdvanceTimer: null,
};
