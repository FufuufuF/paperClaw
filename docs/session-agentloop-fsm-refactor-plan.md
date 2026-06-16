# AgentLoop 显式状态机改造记录

## 背景

当前 paperClaw 的 `packages/core/src/agent/loop.ts` 已经把一轮消息处理拆成了几个阶段：

```text
RESTORE -> COMPACT -> COMMAND -> BUILD -> RUN -> SAVE -> RESPOND -> DONE
```

但是实现方式仍然是 `processLocked()` 内部的一段串行代码：每个阶段通过顺序执行和手动修改 `ctx.state` 来表达。

这和 nanobot 的 `nanobot/agent/loop.py` 还有一个重要差距。nanobot 使用的是显式事件驱动状态机：

```python
_TRANSITIONS = {
    (TurnState.RESTORE, "ok"): TurnState.COMPACT,
    (TurnState.COMPACT, "ok"): TurnState.COMMAND,
    (TurnState.COMMAND, "dispatch"): TurnState.BUILD,
    (TurnState.COMMAND, "shortcut"): TurnState.DONE,
    (TurnState.BUILD, "ok"): TurnState.RUN,
    (TurnState.RUN, "ok"): TurnState.SAVE,
    (TurnState.SAVE, "ok"): TurnState.RESPOND,
    (TurnState.RESPOND, "ok"): TurnState.DONE,
}
```

并且通过循环驱动：

```python
while ctx.state is not TurnState.DONE:
    handler = getattr(self, f"_state_{ctx.state.name.lower()}")
    event = await handler(ctx)
    ctx.trace.append(...)
    ctx.state = self._TRANSITIONS[(ctx.state, event)]
```

## 当前问题

当前实现可以工作，但它还不是严格意义上的表驱动状态机。

主要问题有：

1. 状态转移规则散落在串行代码里，不够集中。
2. 每个阶段的入口、出口事件不够显式。
3. trace 记录依赖手动调用 `traceState()`，阶段耗时和异常记录不够统一。
4. 命令短路、错误处理、checkpoint 恢复等分支会让 `processLocked()` 越来越长。
5. 后续如果要对齐 nanobot 的可恢复执行、状态级调试和 hook 扩展，当前结构会比较难维护。

## 改造目标

把 AgentLoop 改造成显式事件驱动状态机，同时保持当前外部行为不变。

目标结构：

```ts
const TRANSITIONS = new Map([
  ['RESTORE:ok', 'COMPACT'],
  ['COMPACT:ok', 'COMMAND'],
  ['COMMAND:dispatch', 'BUILD'],
  ['COMMAND:shortcut', 'DONE'],
  ['BUILD:ok', 'RUN'],
  ['RUN:ok', 'SAVE'],
  ['SAVE:ok', 'RESPOND'],
  ['RESPOND:ok', 'DONE'],
]);
```

每个状态拆成独立 handler：

```ts
private async stateRestore(ctx: TurnContext): Promise<StateEvent>
private async stateCompact(ctx: TurnContext): Promise<StateEvent>
private async stateCommand(ctx: TurnContext): Promise<StateEvent>
private async stateBuild(ctx: TurnContext): Promise<StateEvent>
private async stateRun(ctx: TurnContext): Promise<StateEvent>
private async stateSave(ctx: TurnContext): Promise<StateEvent>
private async stateRespond(ctx: TurnContext): Promise<StateEvent>
```

统一 driver：

```ts
while (ctx.state !== 'DONE') {
  const startedAt = performance.now();
  const event = await this.runStateHandler(ctx);
  this.recordStateTrace(ctx, startedAt, event);
  ctx.state = this.nextState(ctx.state, event);
}
```

## 建议改造步骤

### Step 1: 增加类型

新增：

```ts
type StateEvent = 'ok' | 'dispatch' | 'shortcut';

interface StateTraceEntry {
  state: TurnState;
  startedAt: number;
  durationMs: number;
  event: StateEvent | '';
  error?: string;
}
```

并在 `TurnContext` 中增加：

```ts
trace: StateTraceEntry[];
commandResult?: CommandResult;
outbound?: OutboundMessage;
messages?: ChatMessage[];
```

### Step 2: 抽出状态 handler

把当前 `processLocked()` 中每一段逻辑迁移到独立方法。

迁移时注意保持语义：

1. `RESTORE` 仍然要早持久化 user turn。
2. `COMMAND` 命中 slash command 时返回 `shortcut`。
3. `COMMAND` 未命中时返回 `dispatch`。
4. `RUN` 仍然负责 active task、checkpointCallback、sendProgress。
5. `SAVE` 才追加 runner newTurns 并写入 session。
6. `RESPOND` 只负责 channel.send 最终回复。

### Step 3: 引入 transition table

用集中转移表替代串行代码里的隐式流程。

如果某个 `(state, event)` 没有定义，直接抛错。这可以尽早暴露非法状态流转。

### Step 4: 统一 trace 和耗时统计

在 driver 层统一记录：

1. 当前 state。
2. handler 开始时间。
3. 执行耗时。
4. 返回 event。
5. 异常信息。

这样后续调试一轮消息时，可以看到每个状态花了多少时间。

### Step 5: 保留现有测试，再补状态机测试

已有测试应尽量保持通过。

建议新增测试：

1. 普通消息路径：`RESTORE -> COMPACT -> COMMAND(dispatch) -> BUILD -> RUN -> SAVE -> RESPOND -> DONE`。
2. slash command 路径：`RESTORE -> COMPACT -> COMMAND(shortcut) -> DONE`。
3. 缺失 transition 时抛错。
4. state handler 抛错时记录 error trace，并发送 error outbound。

## 汇报稿中的表述建议

在改造前，汇报中不要说“已经实现了和 nanobot 一样的表驱动状态机”。

更准确的说法是：

> 当前 AgentLoop 已经按 RESTORE、COMPACT、COMMAND、BUILD、RUN、SAVE、RESPOND 这些阶段组织了一轮消息处理流程，但实现上还是串行阶段代码。后续可以进一步对齐 nanobot，把这些阶段抽成独立 handler，并通过 transition table 显式驱动状态转移。

## 优先级

建议优先级：中高。

原因是当前版本可以运行，但 AgentLoop 是基座核心。随着 command、checkpoint、progress、cron、Feishu、sub-agent 等分支继续增加，显式状态机能显著降低维护复杂度。
