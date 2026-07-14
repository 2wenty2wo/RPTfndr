import type { GpsFix, Reception, SearchSession, SessionEvent } from '../types';
import type { FinderRepository } from './repo';

export interface ResumeRebuildHooks {
  /** Clear any prior in-memory pipeline, cell, and GPS state before replay. */
  reset?(): void;
  onFix?(fix: GpsFix): void;
  onReception?(reception: Reception): void;
  onEvent?(event: SessionEvent): void;
}

export interface RebuiltSession {
  session: SearchSession;
  receptions: number;
  fixes: number;
  events: number;
}

export function findResumableSessions(repository: FinderRepository): Promise<SearchSession[]> {
  return repository.listResumableSessions();
}

/** Replays persisted state in deterministic timestamp order without retaining it all in RAM. */
export async function rebuildSession(
  repository: FinderRepository,
  session: SearchSession,
  hooks: ResumeRebuildHooks = {},
): Promise<RebuiltSession> {
  hooks.reset?.();
  let fixCount = 0;
  let receptionCount = 0;
  let eventCount = 0;

  await repository.iterateFixes(session.id, (fix) => {
    fixCount += 1;
    hooks.onFix?.(fix);
  });
  await repository.iterateReceptions(session.id, (reception) => {
    receptionCount += 1;
    hooks.onReception?.(reception);
  });
  const events = await repository.listEvents(session.id);
  for (const event of events) {
    eventCount += 1;
    hooks.onEvent?.(event);
  }

  return {
    session,
    receptions: receptionCount,
    fixes: fixCount,
    events: eventCount,
  };
}

/**
 * Reconciles counters from append stores first, then rebuilds derived state and
 * marks the chosen session active. Stale counters can therefore never hide data.
 */
export async function resumeSession(
  repository: FinderRepository,
  sessionId: string,
  hooks: ResumeRebuildHooks = {},
  at = Date.now(),
): Promise<RebuiltSession> {
  const reconciled = await repository.reconcileSessionCounters(sessionId);
  if (reconciled.state === 'ended') {
    throw new Error(`Session ${sessionId} has already ended`);
  }
  const active: SearchSession = { ...reconciled, state: 'active', endedAt: undefined };
  await repository.putSession(active);
  const rebuilt = await rebuildSession(repository, active, hooks);
  await repository.addEvent({
    sessionId,
    t: at,
    type: 'lifecycle',
    data: { action: 'resumed' },
  });
  return rebuilt;
}

export async function endResumableSession(
  repository: FinderRepository,
  sessionId: string,
  at = Date.now(),
): Promise<SearchSession> {
  const reconciled = await repository.reconcileSessionCounters(sessionId);
  if (reconciled.state === 'ended') return reconciled;
  const ended: SearchSession = { ...reconciled, state: 'ended', endedAt: at };
  await repository.putSession(ended);
  await repository.addEvent({
    sessionId,
    t: at,
    type: 'lifecycle',
    data: { action: 'ended-from-resume-prompt' },
  });
  return ended;
}

export const getResumeCandidates = findResumableSessions;
