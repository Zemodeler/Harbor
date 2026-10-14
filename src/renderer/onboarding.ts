import type { CliStatus, Settings } from '../shared/api';

export const onboardingKey = 'harbor.onboarding.v1';
export type CliReadiness = 'ready' | 'signedOut' | 'unknown' | 'disabled' | 'missing';

/** Same reading as Settings → Connections: only `signedOut` asks for a sign-in; `unknown` is not called signed out. */
export function cliReadiness(cli: CliStatus, settings?: Settings): CliReadiness {
  if (!cli.installed) return 'missing';
  if (settings?.cliOverrides[cli.id]?.enabled === false) return 'disabled';
  if (cli.signedIn && cli.authState !== 'unknown') return 'ready';
  if (cli.authState === 'unknown') return 'unknown';
  return 'signedOut';
}
export function readinessSummary(clis: CliStatus[], settings?: Settings): { ready: number; text: string } {
  const ready = clis.filter(c => cliReadiness(c, settings) === 'ready').length;
  const installed = clis.filter(c => c.installed).length;
  const text = !clis.length || !installed ? 'Harbor found no supported CLI on this computer. Install Claude Code or Codex with its own installer, then check again.'
    : ready ? `Ready: ${ready} of ${installed} installed ${installed === 1 ? 'CLI' : 'CLIs'}. Harbor routes work to whichever fits.`
    : 'A CLI is installed but not ready. Sign in through its own window; Harbor never sees your password.';
  return { ready, text };
}
/** The wizard opens by itself only on a real first run: loaded, no start-up failure, no projects, not finished before. */
export function shouldOfferOnboarding(s: { loading: boolean; startupError: string; projects: number; done: boolean }): boolean {
  return !s.loading && !s.startupError && s.projects === 0 && !s.done;
}
export function onboardingDone(): boolean { try { return localStorage.getItem(onboardingKey) === 'done'; } catch { return false; } }
export function markOnboardingDone() { try { localStorage.setItem(onboardingKey, 'done'); } catch { /* shown again next start */ } }
