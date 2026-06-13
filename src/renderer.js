import './renderer/styles/index.css';
import { App } from './renderer/app.js';

document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
});
