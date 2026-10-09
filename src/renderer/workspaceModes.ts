import type { Agent, Conversation } from '../shared/api';
import { sessionStatus, type SessionState } from './session';
import type { HarborState } from './hooks/useHarbor';

export function conversationCrew(conversation: Conversation | undefined, agents: Agent[]) {
  if (!conversation) return [];
  const owner = agents.find(a => a.id === conversation.agentId);
  return owner?.role === 'main' ? agents.filter(a => a.role !== 'main' && a.conversationId === conversation.id) : [];
}

// A project's shared lead can be busy in another conversation. Never copy its global state into this one.
export function leadState(state: Pick<HarborState, 'conversation' | 'agents' | 'sending'>): SessionState {
  const c = state.conversation;
  if (!c) return 'idle';
  const owner = state.agents.find(a => a.id === c.agentId);
  if (owner && owner.role !== 'main') return owner.state;
  return c.activity?.state || (state.sending.has(c.id) ? 'queued' : 'idle');
}

export type BoardLane = 'ready' | 'working' | 'attention' | 'finished';
export const boardLanes = [
  { id: 'ready', title: 'Ready & queued', empty: 'Start a conversation to add work.' },
  { id: 'working', title: 'Working', empty: 'Running conversations appear here.' },
  { id: 'attention', title: 'Needs attention', empty: 'No conversations need input right now.' }
] as const;

export function boardLane(conversation: Conversation, agents: Agent[], sending: Set<string>): BoardLane {
  const status = sessionStatus(conversation, agents, sending);
  if (status === 'working') return 'working';
  if (status === 'waiting' || status === 'failed') return 'attention';
  if (status === 'done') return 'finished';
  return 'ready';
}

export function projectTasks(state: Pick<HarborState, 'conversations' | 'agents' | 'projectId'>) {
  const leads = new Set(state.agents.filter(a => a.role === 'main').map(a => a.id));
  return state.conversations.filter(c => c.projectId === state.projectId && !c.archived && leads.has(c.agentId));
}
