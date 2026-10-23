// Movable, resizable panels. Locked until "Edit layout" is pressed, so nothing moves by accident while trading.
// The layout is saved per browser; under 760px wide the panels stack in one column and the saved desktop
// layout is left alone. Without GridStack (the file failed to load) the panels simply stack.
(function () {
'use strict';
const KEY = 'btc-run-layout-v1';
const board = document.getElementById('board');
const editBtn = document.getElementById('layoutBtn'), resetBtn = document.getElementById('layoutReset');
if (!board || !window.GridStack) return;

// A grip on each panel, shown only while editing: dragging starts there so inputs and buttons keep working.
for (const item of board.querySelectorAll('.grid-stack-item')) {
  const content = item.querySelector('.grid-stack-item-content');
  const panel = content.firstElementChild;
  const grip = document.createElement('div');
  grip.className = 'grip';
  const h2 = panel && panel.querySelector('h2');
  grip.textContent = (panel && panel.getAttribute('aria-label')) || (h2 && h2.textContent.trim()) || item.getAttribute('gs-id');
  content.prepend(grip);
}
board.classList.add('grid-stack', 'gs-on');
const grid = window.GridStack.init({
  column: 12, cellHeight: 44, margin: 6, float: false, animate: true, staticGrid: true, alwaysShowResizeHandle: true,
  columnOpts: { breakpoints: [{ w: 760, c: 1 }], layout: 'list' },
  draggable: { handle: '.grip' },
  resizable: { handles: 'e,se,s,sw,w' },
}, board);
const DEFAULT = grid.save(false);

const stored = () => { try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); return Array.isArray(v) ? v : null; } catch (e) { return null; } };
const saved = stored();
if (saved && grid.getColumn() === 12) grid.load(saved, false);

let editing = false;
function setEditing(on) {
  editing = on;
  grid.setStatic(!on);
  document.body.classList.toggle('editing', on);
  editBtn.textContent = on ? 'Done' : 'Edit layout';
  editBtn.setAttribute('aria-pressed', String(on));
  resetBtn.hidden = !on;
}
grid.on('change', () => {
  if (grid.getColumn() !== 12) return;
  try { localStorage.setItem(KEY, JSON.stringify(grid.save(false))); } catch (e) {}
});
editBtn.hidden = false;
editBtn.addEventListener('click', () => setEditing(!editing));
resetBtn.addEventListener('click', () => {
  try { localStorage.removeItem(KEY); } catch (e) {}
  grid.load(DEFAULT, false);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && editing) setEditing(false); });
})();
