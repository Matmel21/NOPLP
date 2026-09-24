// ═══ IMPORT — tag a pasted revision list in one go ══════════════════
import { api }                 from './api.js';
import { esc, showToast }      from './utils.js';
import { loadLibrary }         from './library.js';

const STATUSES = [
  { mastery: 'maitrisee',     label: 'Apprise'  },
  { mastery: 'prevue',        label: 'En cours' },
  { mastery: 'revision',      label: 'À revoir' },
  { mastery: 'non_maitrisee', label: 'Aucun'    },
];

let _modal = null;
let _text = '';          // kept so "Retour" restores what was pasted
let _status = 'maitrisee';

function close() {
  _modal?.remove();
  _modal = null;
}

export function openImportDialog() {
  close();
  _modal = document.createElement('div');
  _modal.id = 'import-modal';
  _modal.className = 'app-dialog import-modal';
  _modal.addEventListener('mousedown', e => { if (e.target === _modal) close(); });
  document.body.appendChild(_modal);
  renderInput();
}

function renderInput() {
  _modal.innerHTML = `
    <div class="app-dialog-box import-box" role="dialog" aria-modal="true" aria-labelledby="import-title">
      <div class="app-dialog-title" id="import-title">Importer une liste</div>
      <p class="app-dialog-msg">Une chanson par ligne : « Titre », « Artiste - Titre » ou « Titre (Artiste) ».</p>
      <textarea class="app-dialog-input import-text" rows="11" spellcheck="false"
        placeholder="Joe Dassin - À toi&#10;Les lacs du Connemara&#10;Amoureuse (Véronique Sanson)"></textarea>
      <div class="app-dialog-actions">
        <button type="button" class="app-dialog-btn cancel">Annuler</button>
        <button type="button" class="app-dialog-btn confirm">Analyser</button>
      </div>
    </div>`;
  const area = _modal.querySelector('.import-text');
  area.value = _text;
  area.focus();
  _modal.querySelector('.cancel').addEventListener('click', close);
  _modal.querySelector('.confirm').addEventListener('click', () => analyse(area.value));
}

async function analyse(text) {
  _text = text;
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) { _modal.querySelector('.import-text').focus(); return; }
  const btn = _modal.querySelector('.confirm');
  btn.disabled = true;
  btn.textContent = 'Analyse…';
  try {
    const results = await api.post('/api/songs/match', { lines });
    if (!Array.isArray(results)) throw new Error(results?.error);
    renderReview(results);
  } catch {
    showToast("Erreur pendant l'analyse");
    btn.disabled = false;
    btn.textContent = 'Analyser';
  }
}

// found: exact title (artist confirmed or single version) · check: fuzzy or
// several versions of the same title · missing: nothing matched
function classify({ candidates }) {
  if (!candidates.length) return 'missing';
  const [best, next] = candidates;
  if (best.score >= 4 || (best.score >= 3 && !(next && next.score === best.score))) return 'found';
  return 'check';
}

function optionLabel(c) {
  return `${c.title} — ${c.artist}${c.year ? ` (${c.year})` : ''}`;
}

function renderReview(results) {
  const rows = results.map(r => ({ ...r, state: classify(r) }));
  const count = st => rows.filter(r => r.state === st).length;

  _modal.innerHTML = `
    <div class="app-dialog-box import-box" role="dialog" aria-modal="true" aria-labelledby="import-title">
      <div class="app-dialog-title" id="import-title">Vérifier les correspondances</div>
      <div class="import-summary">
        <span class="found">${count('found')} trouvée${count('found') > 1 ? 's' : ''}</span>
        <span class="check">${count('check')} à vérifier</span>
        <span class="missing">${count('missing')} introuvable${count('missing') > 1 ? 's' : ''}</span>
      </div>
      <div class="import-list">
        ${rows.map((r, i) => `
          <div class="import-row ${r.state}">
            <span class="import-dot" aria-hidden="true"></span>
            <span class="import-line" title="${esc(r.line)}">${esc(r.line)}</span>
            ${r.candidates.length
              ? `<select class="import-select" data-row="${i}">
                   ${r.candidates.map(c => `<option value="${esc(c.id)}">${esc(optionLabel(c))}</option>`).join('')}
                   <option value="">— Ignorer —</option>
                 </select>`
              : '<span class="import-none">Introuvable</span>'}
          </div>`).join('')}
      </div>
      <div class="import-status">
        <span class="import-status-lbl">Statut à appliquer</span>
        <div class="mode-status">
          ${STATUSES.map(s => `
            <button type="button" class="mode-status-btn ${s.mastery === 'non_maitrisee' ? 'none' : s.mastery}${s.mastery === _status ? ' current' : ''}"
                    data-mastery="${s.mastery}">${s.label}</button>`).join('')}
        </div>
      </div>
      <div class="app-dialog-actions">
        <button type="button" class="app-dialog-btn cancel">Retour</button>
        <button type="button" class="app-dialog-btn confirm"></button>
      </div>
    </div>`;

  const selects = [..._modal.querySelectorAll('.import-select')];
  const apply = _modal.querySelector('.confirm');
  const chosenIds = () => [...new Set(selects.map(sel => sel.value).filter(Boolean))];
  const refresh = () => {
    const n = chosenIds().length;
    apply.textContent = `Appliquer à ${n} chanson${n > 1 ? 's' : ''}`;
    apply.disabled = n === 0;
  };
  selects.forEach(sel => sel.addEventListener('change', () => {
    sel.closest('.import-row').classList.toggle('skipped', !sel.value);
    refresh();
  }));
  _modal.querySelectorAll('.import-status .mode-status-btn').forEach(b => b.addEventListener('click', () => {
    _status = b.dataset.mastery;
    _modal.querySelectorAll('.import-status .mode-status-btn').forEach(x => x.classList.toggle('current', x === b));
  }));
  _modal.querySelector('.cancel').addEventListener('click', renderInput);
  apply.addEventListener('click', async () => {
    const ids = chosenIds();
    apply.disabled = true;
    try {
      const { updated, error } = await api.put('/api/mastery/bulk', { ids, mastery: _status });
      if (error) throw new Error(error);
      const label = STATUSES.find(s => s.mastery === _status).label;
      showToast(`${updated} chanson${updated > 1 ? 's' : ''} → ${label}`);
      _text = '';
      close();
      loadLibrary();
    } catch {
      showToast("Erreur pendant l'enregistrement");
      apply.disabled = false;
    }
  });
  refresh();
}
