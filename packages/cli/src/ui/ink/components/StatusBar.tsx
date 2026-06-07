import { Box, Text } from 'ink';
import type { CliRunState } from '../../../channel/types.js';
import type { CommandRuntimeStatus } from '@paperclaw/core';

export function StatusBar(props: {
  status?: CommandRuntimeStatus;
  runState: CliRunState;
  queuedCount: number;
}) {
  const provider = props.status?.provider ?? 'unknown';
  const model = props.status?.model ?? 'unknown';
  const profile = props.status?.profile?.personalization ?? 'unknown';
  const stateLabel = props.runState === 'working'
    ? '处理中'
    : props.runState === 'error'
      ? '有错误'
      : '等待输入';
  const stateColor = props.runState === 'working'
    ? 'cyan'
    : props.runState === 'error'
      ? 'red'
      : 'green';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color="cyan">paperClaw CLI</Text>
        <Text dimColor>  /help 查看命令  /status 查看状态  /quit 退出</Text>
      </Box>
      <Box columnGap={2}>
        <Text>
          模型: <Text color="yellow">{provider}/{model}</Text>
        </Text>
        <Text>
          profile: <Text color="magenta">{profile}</Text>
        </Text>
        <Text>
          状态: <Text color={stateColor}>{stateLabel}</Text>
        </Text>
        {props.queuedCount > 0 && (
          <Text color="yellow">队列: {props.queuedCount}</Text>
        )}
      </Box>
    </Box>
  );
}
