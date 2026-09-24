// ═══ SPARKLES — scattered twinkling dots behind every view ═══════════
// Two layers wider than the viewport pan sideways when the page changes:
// the near layer (glows, flares) moves more than the far one (dots),
// giving a parallax drift in the direction of travel.

const PAGES     = 4;          // number of nav pages the pan spans
const FAR_STEP  = 5;          // vw per page
const NEAR_STEP = 12;         // vw per page

const rand = (min, max) => min + Math.random() * (max - min);

function spark(cls, size, minOp, maxOp) {
  const el = document.createElement('span');
  el.className = 'spark ' + cls;
  el.style.cssText = `
    left:${rand(0, 100)}%; top:${rand(0, 100)}%;
    width:${size}px; height:${size}px;
    --min:${minOp}; --max:${maxOp};
    --dur:${rand(2.5, 6).toFixed(2)}s; --delay:-${rand(0, 6).toFixed(2)}s;`;
  return el;
}

let _far = null, _near = null;

export function initSparkles() {
  if (document.querySelector('.sparkles')) return;
  const root = document.createElement('div');
  root.className = 'sparkles';
  root.setAttribute('aria-hidden', 'true');
  _far  = document.createElement('div');
  _near = document.createElement('div');
  _far.className  = 'spark-layer far';
  _near.className = 'spark-layer near';
  for (let i = 0; i < 105; i++) _far.appendChild(spark('dot',  rand(1, 2.5), .08, rand(.4, .85)));
  for (let i = 0; i < 18; i++)  _near.appendChild(spark('glow', rand(3, 5),   .15, .9));
  for (let i = 0; i < 6; i++)   _near.appendChild(spark('flare', rand(4, 6),  .2,  1));
  root.append(_far, _near);
  document.body.prepend(root);
  panSparkles(0, false);
}

// Centred so the full page range stays within the layers' extra width.
export function panSparkles(pageIndex, animate = true) {
  if (!_far) return;
  const offset = (PAGES - 1) / 2 - pageIndex;
  for (const [layer, step] of [[_far, FAR_STEP], [_near, NEAR_STEP]]) {
    layer.style.transition = animate ? '' : 'none';
    layer.style.transform  = `translateX(${offset * step}vw)`;
  }
}
