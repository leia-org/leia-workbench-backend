import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/models/Session.js', () => ({ default: {} }));
vi.mock('../src/models/ActivityRun.js', () => ({ default: {} }));
vi.mock('../src/repositories/v1/ReplicationRepository.js', () => ({
  default: {
    findById: vi.fn(),
    findLeia: vi.fn(),
    updateStagePreviousConversation: vi.fn(),
    updateLeiaPreviousStageView: vi.fn(),
    updateStageLeiasPreviousStageView: vi.fn(),
    updateAskSolution: vi.fn(),
    toggleIsActive: vi.fn(),
  },
}));
vi.mock('../src/repositories/v1/SessionRepository.js', () => ({
  default: { findById: vi.fn() },
}));
vi.mock('../src/repositories/v1/ActivityRunRepository.js', () => ({
  default: { findById: vi.fn() },
}));
vi.mock('../src/services/v1/SessionService.js', () => ({
  default: { findById: vi.fn() },
}));
vi.mock('../src/services/v1/MessageService.js', () => ({
  default: { findBySession: vi.fn() },
}));
vi.mock('../src/services/v1/SpectatorService.js', () => ({
  default: {
    generateSpectateToken: vi.fn().mockResolvedValue({ token: 'tok', expiresAt: new Date() }),
    generateSpectateUrl: vi.fn().mockReturnValue('http://spectate'),
  },
}));
vi.mock('../src/services/v1/ManagerService.js', () => ({ default: {} }));
vi.mock('../src/utils/logger.js', () => ({ default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import ReplicationRepository from '../src/repositories/v1/ReplicationRepository.js';
import SessionRepository from '../src/repositories/v1/SessionRepository.js';
import ActivityRunRepository from '../src/repositories/v1/ActivityRunRepository.js';
import SessionService from '../src/services/v1/SessionService.js';
import MessageService from '../src/services/v1/MessageService.js';
import ReplicationService from '../src/services/v1/ReplicationService.js';
import InteractionService from '../src/services/v1/InteractionService.js';
import { activityFlows } from '../src/utils/activityStages.js';
import {
  updateLeiaPreviousStageViewValidator,
  updateStagePreviousConversationValidator,
} from '../src/validators/v1/replicationValidator.js';

const buildReplication = (stageOverrides = {}) => ({
  id: 'rep-1',
  isActive: true,
  duration: null,
  language: 'en',
  toJSON() {
    return { id: this.id, isActive: this.isActive, duration: this.duration, language: this.language };
  },
  experiment: {
    stages: [
      { id: 's1', orchestration: { mode: 'single' }, ...(stageOverrides.s1 || {}) },
      { id: 's2', orchestration: { mode: 'single' }, ...(stageOverrides.s2 || {}) },
      { id: 's3', orchestration: { mode: 'single' }, ...(stageOverrides.s3 || {}) },
    ],
    leias: [
      {
        id: 'l1',
        stageId: 's1',
        configuration: { mode: 'standard', askSolution: true, evaluateSolution: false },
        runnerConfiguration: { provider: 'openai-responses', modelName: 'gpt-4.1', apiKeyId: 'k1', apiKeyRequesterId: 'u1', audioMode: null },
        leia: {
          id: 'doc-1',
          metadata: { name: 'Interviewer LEIA' },
          spec: {
            persona: { id: 'p1', spec: { firstName: 'Elena', avatar: '/avatar-elena.png' } },
            behaviour: { spec: { description: 'TOP SECRET PROMPT' } },
            problem: { spec: { description: 'Stage 1 problem', solution: 'TOP SECRET SOLUTION' } },
          },
        },
      },
      {
        id: 'l2',
        stageId: 's2',
        configuration: { mode: 'standard', askSolution: true, evaluateSolution: false },
        runnerConfiguration: { provider: 'openai-responses', modelName: 'gpt-4.1', apiKeyId: 'k1', apiKeyRequesterId: 'u1', audioMode: null },
        leia: {
          id: 'doc-2',
          metadata: { name: 'Reviewer LEIA' },
          spec: {
            persona: { id: 'p2', spec: { firstName: 'Marco' } },
            behaviour: { spec: { description: 'Stage 2 prompt' } },
            problem: { spec: { description: 'Stage 2 problem' } },
          },
        },
      },
      {
        id: 'l3',
        stageId: 's3',
        configuration: { mode: 'standard', askSolution: true, evaluateSolution: false },
        runnerConfiguration: { provider: 'openai-responses', modelName: 'gpt-4.1', apiKeyId: 'k1', apiKeyRequesterId: 'u1', audioMode: null },
        leia: {
          id: 'doc-3',
          metadata: { name: 'Synthesis LEIA' },
          spec: {
            persona: { id: 'p3', spec: { firstName: 'Sofia' } },
            behaviour: { spec: { description: 'Stage 3 prompt' } },
            problem: { spec: { description: 'Stage 3 problem' } },
          },
        },
      },
    ],
  },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('updateStagePreviousConversationValidator', () => {
  test('accepts valid enabled/disabled payloads and rejects invalid values', async () => {
    await expect(
      updateStagePreviousConversationValidator.validateAsync({
        enabled: true,
        sourceStageId: 's1',
        availability: 'both',
      })
    ).resolves.toEqual({ enabled: true, sourceStageId: 's1', availability: 'both' });

    await expect(
      updateStagePreviousConversationValidator.validateAsync({
        enabled: false,
        sourceStageId: null,
        availability: 'chat',
      })
    ).resolves.toEqual({ enabled: false, sourceStageId: null, availability: 'chat' });

    await expect(
      updateStagePreviousConversationValidator.validateAsync({
        enabled: true,
        sourceStageId: 's1',
        availability: 'editor',
      })
    ).resolves.toEqual({ enabled: true, sourceStageId: 's1', availability: 'editor' });

    await expect(
      updateStagePreviousConversationValidator.validateAsync({
        enabled: true,
        sourceStageId: 's1',
        availability: 'invalid',
      })
    ).rejects.toThrow();

    await expect(
      updateStagePreviousConversationValidator.validateAsync({
        sourceStageId: 's1',
      })
    ).rejects.toThrow();
  });

  test('updateLeiaPreviousStageViewValidator accepts independent or combined payloads and applyToStage', async () => {
    await expect(
      updateLeiaPreviousStageViewValidator.validateAsync({
        previousSubmittedSolution: {
          enabled: true,
          sourceStageId: 's1',
          availability: 'editor',
        },
      })
    ).resolves.toEqual({
      previousSubmittedSolution: {
        enabled: true,
        sourceStageId: 's1',
        availability: 'editor',
      },
    });

    await expect(
      updateLeiaPreviousStageViewValidator.validateAsync({
        previousConversation: { enabled: true, sourceStageId: 's1', availability: 'chat' },
        previousSubmittedSolution: { enabled: true, sourceStageId: 's1', availability: 'both' },
        applyToStage: true,
      })
    ).resolves.toEqual({
      previousConversation: { enabled: true, sourceStageId: 's1', availability: 'chat' },
      previousSubmittedSolution: { enabled: true, sourceStageId: 's1', availability: 'both' },
      applyToStage: true,
    });

    await expect(updateLeiaPreviousStageViewValidator.validateAsync({})).rejects.toThrow();
  });
});

describe('ReplicationService.updateStagePreviousConversation', () => {
  test('enables previous conversation on stages n>1 pointing to an earlier stage', async () => {
    const rep = buildReplication();
    ReplicationRepository.findById.mockResolvedValue(rep);
    ReplicationRepository.updateStagePreviousConversation.mockResolvedValue(rep);

    await ReplicationService.updateStagePreviousConversation('rep-1', 's3', {
      enabled: true,
      sourceStageId: 's1',
      availability: 'chat',
    });

    expect(ReplicationRepository.updateStagePreviousConversation).toHaveBeenCalledWith('rep-1', 's3', {
      enabled: true,
      sourceStageId: 's1',
      availability: 'chat',
    });
  });

  test('defaults availability to both when omitted and preserves existing sourceStageId on disable', async () => {
    const rep = buildReplication({
      s2: { previousConversation: { enabled: true, sourceStageId: 's1', availability: 'both' } },
    });
    ReplicationRepository.findById.mockResolvedValue(rep);
    ReplicationRepository.updateStagePreviousConversation.mockResolvedValue(rep);

    await ReplicationService.updateStagePreviousConversation('rep-1', 's2', {
      enabled: false,
    });

    expect(ReplicationRepository.updateStagePreviousConversation).toHaveBeenCalledWith('rep-1', 's2', {
      enabled: false,
      sourceStageId: 's1',
      availability: 'both',
    });
  });

  test('rejects configuring previous conversation on stage 1 (n=1)', async () => {
    ReplicationRepository.findById.mockResolvedValue(buildReplication());

    await expect(
      ReplicationService.updateStagePreviousConversation('rep-1', 's1', {
        enabled: true,
        sourceStageId: 's1',
        availability: 'both',
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(ReplicationRepository.updateStagePreviousConversation).not.toHaveBeenCalled();
  });

  test('rejects selecting the same stage, a later stage, or missing source when enabling', async () => {
    ReplicationRepository.findById.mockResolvedValue(buildReplication());

    await expect(
      ReplicationService.updateStagePreviousConversation('rep-1', 's2', {
        enabled: true,
        sourceStageId: 's2',
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      ReplicationService.updateStagePreviousConversation('rep-1', 's2', {
        enabled: true,
        sourceStageId: 's3',
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      ReplicationService.updateStagePreviousConversation('rep-1', 's2', {
        enabled: true,
        sourceStageId: null,
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('returns 404 when replication or stage does not exist', async () => {
    ReplicationRepository.findById.mockResolvedValueOnce(null);
    await expect(
      ReplicationService.updateStagePreviousConversation('missing', 's2', { enabled: false })
    ).rejects.toMatchObject({ statusCode: 404 });

    ReplicationRepository.findById.mockResolvedValueOnce(buildReplication());
    await expect(
      ReplicationService.updateStagePreviousConversation('rep-1', 'missing-stage', { enabled: false })
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('activityFlows previousConversation guards', () => {
  test('rejects invalid stage previousConversation configurations', () => {
    const firstStageEnabled = buildReplication({
      s1: { previousConversation: { enabled: true, sourceStageId: 's1', availability: 'both' } },
    }).experiment;
    expect(() => activityFlows(firstStageEnabled)).toThrow(/first stage/i);

    const missingSource = buildReplication({
      s2: { previousConversation: { enabled: true, sourceStageId: null, availability: 'both' } },
    }).experiment;
    expect(() => activityFlows(missingSource)).toThrow(/Select an earlier stage/i);

    const laterSource = buildReplication({
      s2: { previousConversation: { enabled: true, sourceStageId: 's3', availability: 'both' } },
    }).experiment;
    expect(() => activityFlows(laterSource)).toThrow(/earlier stage/i);

    const valid = buildReplication({
      s2: { previousConversation: { enabled: true, sourceStageId: 's1', availability: 'chat' } },
    }).experiment;
    expect(() => activityFlows(valid)).not.toThrow();
  });
});

describe('InteractionService previous stage conversation', () => {
  const finishedAt = new Date('2026-11-24T12:00:00Z');
  const runId = 'run-1';
  const stage1Session = {
    id: 'sess-1',
    run: runId,
    user: 'student-1',
    replication: 'rep-1',
    stageId: 's1',
    leia: 'l1',
    isTest: false,
    interactionMode: 'single',
    finishedAt,
  };
  const stage2Session = {
    id: 'sess-2',
    run: runId,
    user: 'student-1',
    replication: 'rep-1',
    stageId: 's2',
    leia: { equals: (other) => String(other) === 'l2', toString: () => 'l2' },
    isTest: false,
    interactionMode: 'single',
    finishedAt: null,
  };

  test('exposes public previousConversation metadata in getSessionData and finishedSessionData only when enabled', async () => {
    const enabledRep = buildReplication({
      s2: { previousConversation: { enabled: true, sourceStageId: 's1', availability: 'chat' } },
    });
    ReplicationRepository.findById.mockResolvedValue(enabledRep);
    SessionService.findById.mockResolvedValue(stage2Session);
    MessageService.findBySession.mockResolvedValue([]);

    const data = await InteractionService.getSessionData('sess-2');
    expect(data.session.previousConversation).toEqual({
      enabled: true,
      stageNumber: 1,
      availability: 'chat',
    });
    // Internal stage UUID must not leak to student payload.
    expect(data.session.previousConversation.sourceStageId).toBeUndefined();

    const finished = await InteractionService.finishedSessionData({ ...stage2Session, finishedAt });
    expect(finished.previousConversation).toEqual({
      enabled: true,
      stageNumber: 1,
      availability: 'chat',
    });

    // Disabled config omits previousConversation.
    const disabledRep = buildReplication({
      s2: { previousConversation: { enabled: false, sourceStageId: 's1', availability: 'both' } },
    });
    ReplicationRepository.findById.mockResolvedValue(disabledRep);
    const disabledData = await InteractionService.getSessionData('sess-2');
    expect(disabledData.session.previousConversation).toBeUndefined();
  });

  test('returns previous stage messages filtered by finishedAt and safe display metadata', async () => {
    const enabledRep = buildReplication({
      s2: { previousConversation: { enabled: true, sourceStageId: 's1', availability: 'both' } },
    });
    ReplicationRepository.findById.mockResolvedValue(enabledRep);
    SessionService.findById.mockResolvedValue(stage2Session);
    ActivityRunRepository.findById.mockResolvedValue({
      id: runId,
      user: 'student-1',
      replication: 'rep-1',
      isTest: false,
      stages: [
        { stageId: 's1', stageIndex: 0, session: 'sess-1' },
        { stageId: 's2', stageIndex: 1, session: 'sess-2' },
      ],
    });
    SessionRepository.findById.mockResolvedValue(stage1Session);
    MessageService.findBySession.mockResolvedValue([
      { id: 'm1', text: 'Hello Elena', isLeia: false, timestamp: new Date('2026-11-24T11:58:00Z') },
      { id: 'm2', text: 'Hi student!', isLeia: true, timestamp: finishedAt },
      { id: 'm3', text: 'Late message after finish', isLeia: true, timestamp: new Date(finishedAt.getTime() + 1000) },
    ]);

    const res = await InteractionService.getPreviousStageConversation('sess-2', { view: 'editor' });
    expect(res).toEqual({
      stage: { number: 1, total: 3 },
      availability: 'both',
      interactionMode: 'single',
      mode: 'standard',
      audioMode: null,
      leiaName: 'Elena',
      personaAvatar: '/avatar-elena.png',
      leiaId: 'doc-1',
      personaId: 'p1',
      messages: [
        { id: 'm1', text: 'Hello Elena', isLeia: false, timestamp: new Date('2026-11-24T11:58:00Z') },
        { id: 'm2', text: 'Hi student!', isLeia: true, timestamp: finishedAt },
      ],
    });
    // Ensure no secret behaviour/problem fields are leaked.
    expect(JSON.stringify(res)).not.toContain('TOP SECRET');
  });

  test('enforces availability=chat by blocking editor view requests with 403', async () => {
    const chatOnlyRep = buildReplication({
      s2: { previousConversation: { enabled: true, sourceStageId: 's1', availability: 'chat' } },
    });
    ReplicationRepository.findById.mockResolvedValue(chatOnlyRep);
    SessionService.findById.mockResolvedValue(stage2Session);

    await expect(
      InteractionService.getPreviousStageConversation('sess-2', { view: 'editor' })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(ActivityRunRepository.findById).not.toHaveBeenCalled();
  });

  test('rejects with 403 when previousConversation is disabled or on stage 1', async () => {
    ReplicationRepository.findById.mockResolvedValue(buildReplication());
    SessionService.findById.mockResolvedValue(stage2Session);

    await expect(
      InteractionService.getPreviousStageConversation('sess-2', { view: 'chat' })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  test('refuses to leak another student session with 409', async () => {
    const enabledRep = buildReplication({
      s2: { previousConversation: { enabled: true, sourceStageId: 's1', availability: 'both' } },
    });
    ReplicationRepository.findById.mockResolvedValue(enabledRep);
    SessionService.findById.mockResolvedValue(stage2Session);
    ActivityRunRepository.findById.mockResolvedValue({
      id: runId,
      user: 'student-1',
      replication: 'rep-1',
      isTest: false,
      stages: [{ stageId: 's1', stageIndex: 0, session: 'sess-other' }],
    });
    SessionRepository.findById.mockResolvedValue({
      ...stage1Session,
      id: 'sess-other',
      user: 'another-student',
    });

    await expect(
      InteractionService.getPreviousStageConversation('sess-2', { view: 'chat' })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(MessageService.findBySession).not.toHaveBeenCalled();
  });

  test('supports MultiLEIA earlier stage actors and test runs', async () => {
    const multiRep = buildReplication({
      s1: { orchestration: { mode: 'multi', maxInternalTurns: 2, openingLeiaId: 'l1', problemLeiaId: 'l1' } },
      s2: { previousConversation: { enabled: true, sourceStageId: 's1', availability: 'both' } },
    });
    multiRep.experiment.leias.push({
      id: 'l1b',
      stageId: 's1',
      configuration: { mode: 'standard', askSolution: false, evaluateSolution: false },
      runnerConfiguration: { provider: 'openai-responses', modelName: 'gpt-4.1', apiKeyId: 'k1', apiKeyRequesterId: 'u1' },
      leia: {
        id: 'doc-1b',
        metadata: { name: 'Partner LEIA' },
        spec: { persona: { id: 'p1b', spec: { firstName: 'Lucia' } }, behaviour: { spec: {} }, problem: { spec: {} } },
      },
    });
    ReplicationRepository.findById.mockResolvedValue(multiRep);

    const testStage2 = { ...stage2Session, user: undefined, isTest: true };
    const testStage1 = {
      ...stage1Session,
      user: undefined,
      isTest: true,
      interactionMode: 'multi',
      leias: ['l1', 'l1b'],
    };
    SessionService.findById.mockResolvedValue(testStage2);
    ActivityRunRepository.findById.mockResolvedValue({
      id: runId,
      user: undefined,
      replication: 'rep-1',
      isTest: true,
      stages: [{ stageId: 's1', stageIndex: 0, session: 'sess-1' }],
    });
    SessionRepository.findById.mockResolvedValue(testStage1);
    MessageService.findBySession.mockResolvedValue([
      { id: 'm1', text: 'Question', isLeia: false, senderType: 'participant', timestamp: finishedAt },
      { id: 'm2', text: 'Reply from Lucia', isLeia: true, senderType: 'agent', senderId: 'l1b', senderName: 'Lucia', timestamp: finishedAt },
    ]);

    const res = await InteractionService.getPreviousStageConversation('sess-2', { view: 'chat' });
    expect(res.interactionMode).toBe('multi');
    expect(res.actors).toEqual([
      { id: 'l1', name: 'Elena', avatar: '/avatar-elena.png', leiaId: 'doc-1', personaId: 'p1' },
      { id: 'l1b', name: 'Lucia', avatar: null, leiaId: 'doc-1b', personaId: 'p1b' },
    ]);
    expect(res.messages).toHaveLength(2);
    expect(res.messages[1].senderName).toBe('Lucia');
  });

  test('returns preloaded transcript messages when the configured earlier stage used transcription mode', async () => {
    const transcriptionRep = buildReplication({
      s2: { previousConversation: { enabled: true, sourceStageId: 's1', availability: 'both' } },
    });
    transcriptionRep.experiment.leias[0].configuration = {
      mode: 'transcription',
      data: {
        messages: [
          { text: 'Preloaded line 1', isLeia: true, timestamp: '2026-11-24T10:00:00Z' },
          { text: 'Preloaded line 2', isLeia: false, timestamp: '2026-11-24T10:01:00Z' },
        ],
      },
    };
    ReplicationRepository.findById.mockResolvedValue(transcriptionRep);
    SessionService.findById.mockResolvedValue(stage2Session);
    ActivityRunRepository.findById.mockResolvedValue({
      id: runId,
      user: 'student-1',
      replication: 'rep-1',
      isTest: false,
      stages: [{ stageId: 's1', stageIndex: 0, session: 'sess-1' }],
    });
    SessionRepository.findById.mockResolvedValue(stage1Session);

    const res = await InteractionService.getPreviousStageConversation('sess-2', { view: 'chat' });
    expect(MessageService.findBySession).not.toHaveBeenCalled();
    expect(res.mode).toBe('transcription');
    expect(res.messages).toHaveLength(2);
    expect(res.messages[0].text).toBe('Preloaded line 1');
  });
});

describe('Per-LEIA variability and previous submitted solution', () => {
  const finishedAt = new Date('2026-11-24T12:00:00Z');
  const runId = 'run-1';

  const buildAbReplication = () => {
    const rep = buildReplication();
    rep.experiment.leias[0].leia.spec.problem.spec.solutionFormat = 'markdown';
    rep.experiment.leias.push({
      id: 'l2b',
      stageId: 's2',
      configuration: { mode: 'standard', askSolution: true, evaluateSolution: false },
      runnerConfiguration: {
        provider: 'openai-responses',
        modelName: 'gpt-4.1',
        apiKeyId: 'k1',
        apiKeyRequesterId: 'u1',
        audioMode: null,
      },
      leia: {
        id: 'doc-2b',
        metadata: { name: 'Reviewer LEIA B' },
        spec: {
          persona: { id: 'p2b', spec: { firstName: 'Nora' } },
          behaviour: { spec: { description: 'Stage 2 variant B' } },
          problem: { spec: { description: 'Stage 2 problem B' } },
        },
      },
    });
    return rep;
  };

  test('updateLeiaPreviousStageView updates a single LEIA independently and supports applyToStage', async () => {
    const rep = buildAbReplication();
    ReplicationRepository.findById.mockResolvedValue(rep);
    ReplicationRepository.updateLeiaPreviousStageView.mockResolvedValue(rep);
    ReplicationRepository.updateStageLeiasPreviousStageView.mockResolvedValue(rep);

    await ReplicationService.updateLeiaPreviousStageView('rep-1', 'l2', {
      previousConversation: { enabled: true, sourceStageId: 's1', availability: 'editor' },
      previousSubmittedSolution: { enabled: true, sourceStageId: 's1', availability: 'both' },
    });

    expect(ReplicationRepository.updateLeiaPreviousStageView).toHaveBeenCalledWith('rep-1', 'l2', {
      previousConversation: { enabled: true, sourceStageId: 's1', availability: 'editor' },
      previousSubmittedSolution: { enabled: true, sourceStageId: 's1', availability: 'both' },
    });

    await ReplicationService.updateLeiaPreviousStageView('rep-1', 'l2', {
      previousSubmittedSolution: { enabled: true, sourceStageId: 's1', availability: 'chat' },
      applyToStage: true,
    });

    expect(ReplicationRepository.updateStageLeiasPreviousStageView).toHaveBeenCalledWith(
      'rep-1',
      's2',
      {
        previousSubmittedSolution: { enabled: true, sourceStageId: 's1', availability: 'chat' },
      }
    );
  });

  test('rejects enabling previousSubmittedSolution when source stage has askSolution disabled', async () => {
    const rep = buildAbReplication();
    rep.experiment.leias[0].configuration.askSolution = false;
    ReplicationRepository.findById.mockResolvedValue(rep);

    await expect(
      ReplicationService.updateLeiaPreviousStageView('rep-1', 'l2', {
        previousSubmittedSolution: { enabled: true, sourceStageId: 's1', availability: 'both' },
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(ReplicationRepository.updateLeiaPreviousStageView).not.toHaveBeenCalled();
  });

  test('locks toggleAskSolution and blocks activation when a later stage LEIA uses previousSubmittedSolution', async () => {
    const rep = buildAbReplication();
    rep.isActive = false;
    rep.experiment.leias[1].configuration.previousSubmittedSolution = {
      enabled: true,
      sourceStageId: 's1',
      availability: 'editor',
    };
    ReplicationRepository.findById.mockResolvedValue(rep);

    await expect(ReplicationService.toggleAskSolution('rep-1', 'l1')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(ReplicationRepository.updateAskSolution).not.toHaveBeenCalled();

    rep.experiment.leias[0].configuration.askSolution = false;
    await expect(ReplicationService.toggleIsActive('rep-1')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(ReplicationRepository.toggleIsActive).not.toHaveBeenCalled();
  });

  test('rejects editing secondary MultiLEIA actor for previous stage view', async () => {
    const rep = buildAbReplication();
    rep.experiment.stages[1].orchestration = {
      mode: 'multi',
      maxInternalTurns: 2,
      openingLeiaId: 'l2',
      problemLeiaId: 'l2',
    };
    ReplicationRepository.findById.mockResolvedValue(rep);

    await expect(
      ReplicationService.updateLeiaPreviousStageView('rep-1', 'l2b', {
        previousSubmittedSolution: { enabled: true, sourceStageId: 's1', availability: 'both' },
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejects using different source stages for conversation and submitted solution on the same LEIA', async () => {
    const rep = buildAbReplication();
    ReplicationRepository.findById.mockResolvedValue(rep);

    await expect(
      ReplicationService.updateLeiaPreviousStageView('rep-1', 'l3', {
        previousConversation: { enabled: true, sourceStageId: 's1', availability: 'both' },
        previousSubmittedSolution: { enabled: true, sourceStageId: 's2', availability: 'both' },
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(ReplicationRepository.updateLeiaPreviousStageView).not.toHaveBeenCalled();

    const mismatchedFlow = buildAbReplication().experiment;
    mismatchedFlow.leias[2].configuration.previousConversation = {
      enabled: true,
      sourceStageId: 's1',
      availability: 'both',
    };
    mismatchedFlow.leias[2].configuration.previousSubmittedSolution = {
      enabled: true,
      sourceStageId: 's2',
      availability: 'both',
    };
    expect(() => activityFlows(mismatchedFlow)).toThrow(/same source stage/i);
  });

  test('exposes per-LEIA previousConversation and previousSubmittedSolution without leaking sourceStageId', async () => {
    const rep = buildAbReplication();
    rep.experiment.leias[1].configuration.previousConversation = {
      enabled: true,
      sourceStageId: 's1',
      availability: 'editor',
    };
    rep.experiment.leias[1].configuration.previousSubmittedSolution = {
      enabled: true,
      sourceStageId: 's1',
      availability: 'chat',
    };
    // LEIA B in the same stage leaves both disabled.
    rep.experiment.leias[3].configuration.previousConversation = {
      enabled: false,
      sourceStageId: 's1',
      availability: 'both',
    };
    ReplicationRepository.findById.mockResolvedValue(rep);
    MessageService.findBySession.mockResolvedValue([]);

    SessionService.findById.mockResolvedValueOnce({
      id: 'sess-2a',
      run: runId,
      user: 'student-1',
      replication: 'rep-1',
      stageId: 's2',
      leia: { equals: (other) => String(other) === 'l2', toString: () => 'l2' },
      isTest: false,
      interactionMode: 'single',
      finishedAt: null,
    });
    const dataA = await InteractionService.getSessionData('sess-2a');
    expect(dataA.session.previousConversation).toEqual({
      enabled: true,
      stageNumber: 1,
      availability: 'editor',
    });
    expect(dataA.session.previousSubmittedSolution).toEqual({
      enabled: true,
      stageNumber: 1,
      availability: 'chat',
    });
    expect(dataA.leia.configuration.previousConversation).toBeUndefined();
    expect(dataA.leia.configuration.previousSubmittedSolution).toBeUndefined();

    SessionService.findById.mockResolvedValueOnce({
      id: 'sess-2b',
      run: runId,
      user: 'student-2',
      replication: 'rep-1',
      stageId: 's2',
      leia: { equals: (other) => String(other) === 'l2b', toString: () => 'l2b' },
      isTest: false,
      interactionMode: 'single',
      finishedAt: null,
    });
    const dataB = await InteractionService.getSessionData('sess-2b');
    expect(dataB.session.previousConversation).toBeUndefined();
    expect(dataB.session.previousSubmittedSolution).toBeUndefined();
  });

  test('getPreviousStageSubmittedSolution returns student result, enforces view availability, and never leaks reference solution', async () => {
    const rep = buildAbReplication();
    rep.experiment.leias[1].configuration.previousSubmittedSolution = {
      enabled: true,
      sourceStageId: 's1',
      availability: 'editor',
    };
    rep.experiment.leias[1].configuration.previousConversation = {
      enabled: true,
      sourceStageId: 's1',
      availability: 'editor',
    };
    ReplicationRepository.findById.mockResolvedValue(rep);

    const stage2Session = {
      id: 'sess-2',
      run: runId,
      user: 'student-1',
      replication: 'rep-1',
      stageId: 's2',
      leia: 'l2',
      isTest: false,
      interactionMode: 'single',
      finishedAt: null,
    };
    SessionService.findById.mockResolvedValue(stage2Session);

    // Editor-only blocks chat view for both conversation and submitted solution.
    await expect(
      InteractionService.getPreviousStageSubmittedSolution('sess-2', { view: 'chat' })
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      InteractionService.getPreviousStageConversation('sess-2', { view: 'chat' })
    ).rejects.toMatchObject({ statusCode: 403 });

    ActivityRunRepository.findById.mockResolvedValue({
      id: runId,
      user: 'student-1',
      replication: 'rep-1',
      isTest: false,
      stages: [
        { stageId: 's1', stageIndex: 0, session: 'sess-1' },
        { stageId: 's2', stageIndex: 1, session: 'sess-2' },
      ],
    });
    SessionRepository.findById.mockResolvedValue({
      id: 'sess-1',
      run: runId,
      user: 'student-1',
      replication: 'rep-1',
      stageId: 's1',
      leia: 'l1',
      isTest: false,
      interactionMode: 'single',
      finishedAt,
      result: '# Student Markdown Solution\n\nDetails here.',
    });

    const res = await InteractionService.getPreviousStageSubmittedSolution('sess-2', {
      view: 'editor',
    });
    expect(res).toEqual({
      stage: { number: 1, total: 3 },
      availability: 'editor',
      solution: '# Student Markdown Solution\n\nDetails here.',
      solutionFormat: 'markdown',
      submittedAt: finishedAt,
    });
    expect(JSON.stringify(res)).not.toContain('TOP SECRET');
  });

  test('activityFlows validates per-LEIA previousSubmittedSolution configs', () => {
    const firstStageEnabled = buildAbReplication().experiment;
    firstStageEnabled.leias[0].configuration.previousSubmittedSolution = {
      enabled: true,
      sourceStageId: 's1',
      availability: 'both',
    };
    expect(() => activityFlows(firstStageEnabled)).toThrow(/first stage/i);

    const invalidAvailability = buildAbReplication().experiment;
    invalidAvailability.leias[1].configuration.previousSubmittedSolution = {
      enabled: true,
      sourceStageId: 's1',
      availability: 'nope',
    };
    expect(() => activityFlows(invalidAvailability)).toThrow(/availability/i);

    const validEditorOnly = buildAbReplication().experiment;
    validEditorOnly.leias[1].configuration.previousSubmittedSolution = {
      enabled: true,
      sourceStageId: 's1',
      availability: 'editor',
    };
    expect(() => activityFlows(validEditorOnly)).not.toThrow();
  });
});
