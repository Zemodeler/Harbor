import type { Agent, Conversation } from '../shared/api';

export type SessionState = 'working' | 'queued' | 'waiting' | 'failed' | 'stopped' | 'done' | 'idle';
export const statusLabels: Record<SessionState, string> = { working: 'Working', queued: 'Queued', waiting: 'Needs input', failed: 'Needs attention', stopped: 'Stopped', done: 'Finished', idle: 'Ready' };
export function sessionStatus(c: Conversation | undefined, agents: Agent[], sending: Set<string>): SessionState {
  if (!c) return 'idle';
  const owner = agents.find(a => a.id === c.agentId);
  const crew = owner?.role === 'main' ? agents.filter(a => a.conversationId === c.id && a.role !== 'main') : agents.filter(a => a.id === c.agentId);
  if (c.activity?.state === 'working' || crew.some(a => a.state === 'working')) return 'working';
  if (sending.has(c.id) || c.activity?.state === 'queued' || crew.some(a => a.state === 'queued')) return 'queued';
  if (c.activity?.state === 'waiting' || crew.some(a => a.state === 'waiting')) return 'waiting';
  if (c.activity?.state === 'failed') return 'failed';
  if (c.activity?.state === 'stopped') return 'stopped';
  if (c.activity?.state === 'done') return 'done';
  if (crew.some(a => a.state === 'failed')) return 'failed';
  if (crew.length && crew.every(a => a.state === 'done')) return 'done';
  return 'idle';
}
export function elapsed(time: number) {
  const seconds = Math.max(0, Math.floor(time / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
