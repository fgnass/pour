// "Install app": uses the browser's install prompt where there is one
// (Chrome, Edge, Android), otherwise tells how to add the app by hand.

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const standalone = () =>
  matchMedia('(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

const ios = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function manualInstallText() {
  return ios()
    ? 'Tap the Share button, then “Add to Home Screen”.'
    : 'Open the browser menu and choose “Install app” or “Add to Home screen”.';
}

/**
 * Shows the given buttons while the app is not installed.
 * `onManual` is called when the browser has no install prompt.
 */
export function initInstall(buttons: HTMLElement[], onManual: (text: string) => void) {
  let deferred: InstallPromptEvent | null = null;
  const show = (on: boolean) => buttons.forEach(b => (b.hidden = !on));
  show(!standalone());

  addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    show(true);
  });
  addEventListener('appinstalled', () => {
    deferred = null;
    show(false);
  });

  return async function install() {
    if (!deferred) return onManual(manualInstallText());
    const ev = deferred;
    deferred = null;
    await ev.prompt();
    const { outcome } = await ev.userChoice;
    if (outcome === 'accepted') show(false);
  };
}
