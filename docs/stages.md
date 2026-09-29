# Activity stages

Activities created in Designer now have an ordered `stages` array. The legacy
`leias` array remains a resource pool for LEIA templates and runner settings;
its order does not schedule a stage-based activity.

## Definition contract

```ts
interface StageDefinition<Config> {
  id: string;       // stable within the activity; independent of a LEIA ID
  type: string;     // registered implementation
  version: 1;
  title: string;
  config: Config;
}
interface StageImplementation<Config> {
  outputs: Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>;
  validate(stage: StageDefinition<Config>, activity: Activity): void;
  references?(stage: StageDefinition<Config>, activity: Activity): string[];
  artifacts(source: { stage: StageDefinition<Config>; session: StageExecution;
                      messages: Message[] }): Record<string, unknown>;
}
```

Register implementations using `registerStage` in `src/utils/stages.js` in
Designer and Workbench. These repositories deploy independently; keep their
contract modules identical. The registry validates configuration, supported
versions, unique IDs and predecessor output compatibility before saving,
publishing, activating or starting a stage flow. Drafts may be empty; published
or activated activities must contain at least one stage.

| Type | Configuration | Outputs |
| --- | --- | --- |
| `LEIAStage` | `leiaId`: activity resource ID | `previousConversation`, `previousSolution` |
| `MultiLEIAStage` | `leiaIds`, optional `orchestration` | `previousConversation`, `previousSolution` |
| `StaticContentStage` | `content`: Markdown | `content` |

MultiLEIA orchestration belongs to its stage: first speaker, shared problem,
shared task and maximum internal turns. All selected actors must use compatible
processes and text mode. Static content renders through ReactMarkdown without
raw HTML execution and completes on participant acknowledgement.

## Runtime and artifacts

Each stage creates a Session execution with `stageId`, `activityRunId`, a private
definition snapshot and private input snapshots. Static stages need no LEIA or
runner. One `activityRunId` groups all stages of an attempt; repeating the activity
creates a new ID even for the same email. Conversation lists group by this ID and
exclude static executions. Legacy chains group by their root `previousSession`.

`StageExecutionService` sequences stages. `registerStageExecutor(type, adapter)`
separates type-specific runtime preparation and initialization from sequencing:

```ts
interface StageExecutor {
  prepare(context: { stage; replication; previousStage }): Promise<{
    leiaId?: string;
    interactionMode: 'single' | 'multi' | 'static';
    stageEntries?: unknown[];
    stageState?: unknown;
    leiaSnapshot?: unknown;
    leias?: string[];
  }> | object;
  initialize(session, replication): Promise<unknown>;
}
```

To add a type, register its definition and runtime adapter, then add its editor
configuration and participant rendering/interaction endpoints. A quiz, for
example, can store its runtime state in `stageState` and declare a numeric `score`
artifact without teaching the sequencer how quiz scoring works.

Advancement requires the preceding stage to be finished. Its implementation
produces and type-checks outputs server-side; only declared outputs become
`previousStage`. The unique `previousSession` index makes retries reuse the same
successor. Initial input snapshots are retained if runner initialization fails,
so a retry uses the same authored template and predecessor artifacts.

Examples of authored placeholders:

```text
{{previousStage.previousConversation}}
{{previousStage.previousSolution}}
{{previousStage.content}}
```

These refer strictly to the immediate predecessor. A static stage between two
LEIAs does not forward an older conversation. Missing outputs reject the activity
instead of silently substituting empty values. Conversation outputs contain
role/content messages and the participant's submitted solution (empty string if
none was submitted). Disabled conversation controls do not require artifacts.

Static LEIA composition preserves runtime placeholders. The single and multi
runners resolve them once when instantiating authored behaviour. Artifact text
is never recursively evaluated as a template. Workbench retains unresolved
templates plus private artifact inputs, not already substituted prompts.

## APIs and compatibility

- `PATCH /api/v1/experiments/:id/stages` replaces the ordered definitions after
  normal edit authorization and validation. Published activities are immutable.
- `POST /api/v1/interactions/:sessionId/next-stage` returns the new or existing
  successor `{ sessionId }`. `/reflective` remains an alias for old clients.
- Session data returns `stage` with safe display fields for static content;
  conversation stages retain the existing chat payload. `nextStageAvailable`
  indicates whether a completed execution can advance. `reflectiveAvailable`
  remains a compatibility alias.
- `/interactions/test` accepts `stageFlow: true` without a LEIA ID and starts at
  the first stage of a stage-based activity.
- Existing activities and replication snapshots without `stages` retain their
  previous assignment/reflective behaviour. Saving their proposed flow in the
  new editor explicitly converts them into a sequence. Existing published
  snapshots and production data are not rewritten.
- `reflectiveContext.*` remains a runtime alias for saved templates. New authoring
  uses `previousStage.*`.

## Verification

Designer: `npx vitest run`. Workbench: `npx vitest run`. Runner:
`npx vitest run tests/reflective.test.js tests/multiLeiaService.test.js tests/multiLeiaOrchestrator.test.js`.
Both frontend repositories: `npm run build`.

Tests cover mixed sequences, immediate-predecessor validation, custom outputs,
static-only publication/completion, template isolation, MultiLEIA configuration,
retry recovery, access checks and preservation of legacy reflective behaviour.
