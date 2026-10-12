import type { HarborState } from '../hooks/useHarbor';
import type { Agent } from '../../shared/api';
import { AgentOutcome } from './AgentOutcome';
import { ChangedFiles, IntegrationCard } from './IntegrationPanel';
import { QueueControls, ResumeControl } from './QueueControls';
import { RollbackAction, RollbackCard } from './RollbackDialog';
import s from './Features.module.css';

/**
 * Everything a helper card shows beyond its title and status: what it reported and what Harbor verified, queue and
 * resume controls, the integrator/rollback cards and the branch actions. One component so every card stays consistent.
 */
export function HelperDetails({ state, agent }: { state: HarborState; agent: Agent }) {
  const { api, agents } = state;
  const branch = !!agent.worktree || !!agent.integration?.branch;
  return <div className={s.fxWrap} style={{ flex: '0 0 100%' }} data-helper-details={agent.id}>
    {agent.integration ? <IntegrationCard api={api} agent={agent} agents={agents}/>
      : agent.rollback ? <RollbackCard api={api} agent={agent} agents={agents}/>
      : <AgentOutcome agent={agent}/>}
    <QueueControls api={api} agent={agent} agents={agents}/>
    <ResumeControl api={api} agent={agent} openAgent={id => void state.openAgent(id)}/>
    {branch && !agent.rollback ? <div className={s.fxRow}>
      {!agent.integration ? <ChangedFiles api={api} agent={agent}/> : null}
      <RollbackAction api={api} agent={agent} agents={agents}/>
    </div> : null}
  </div>;
}
