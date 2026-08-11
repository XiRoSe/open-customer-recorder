import { initRecorder } from './tracker';

(function () {
  if (typeof document === 'undefined') return;
  const script = document.currentScript as HTMLScriptElement | null;
  const projectKey = script?.dataset.projectKey;
  if (!projectKey) {
    console.warn('[mega-recorder] missing data-project-key on <script>');
    return;
  }
  const apiOrigin = script?.dataset.apiOrigin || (script?.src ? new URL(script.src).origin : undefined);
  const privacyMode = (script?.dataset.privacyMode as 'default' | 'mask_all_inputs' | 'strict') || 'default';
  const handle = initRecorder({ projectKey, apiOrigin, privacyMode });
  // Expose for manual identify/stop
  (window as unknown as { MegaRecorder: typeof handle }).MegaRecorder = handle;
})();
