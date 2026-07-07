import { initUi } from './ui.js';

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initUi);
} else {
  initUi();
}
