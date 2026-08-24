import { initRecorder } from './tracker';

(function () {
  if (typeof document === 'undefined') return;
  const script = document.currentScript as HTMLScriptElement | null;
  const projectKey = script?.dataset.projectKey;
  if (!projectKey) {
    console.warn('[pocketscience] missing data-project-key on <script>');
    return;
  }
  const apiOrigin = script?.dataset.apiOrigin || (script?.src ? new URL(script.src).origin : undefined);
  const privacyMode = (script?.dataset.privacyMode as 'default' | 'mask_all_inputs' | 'strict') || 'default';
  const handle = initRecorder({ projectKey, apiOrigin, privacyMode });
  // Expose for manual identify/stop — both names point at the same handle
  // so existing embeds calling window.MegaRecorder keep working after the
  // PocketScience rename with no re-embed required.
  const w = window as unknown as { PocketScience: typeof handle; MegaRecorder: typeof handle };
  w.PocketScience = handle;
  w.MegaRecorder = handle;
})();
