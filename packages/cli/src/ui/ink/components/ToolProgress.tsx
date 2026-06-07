import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { CliRunState } from '../../../channel/types.js';

const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function ToolProgress(props: {
  runState: CliRunState;
  currentTools: string[];
}) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (props.runState !== 'working') return;
    const timer = setInterval(() => {
      setFrame((value) => (value + 1) % spinnerFrames.length);
    }, 120);
    return () => clearInterval(timer);
  }, [props.runState]);

  if (props.runState === 'working') {
    const tools = props.currentTools.length > 0 ? props.currentTools.join(', ') : '等待工具或模型响应';
    return (
      <Box marginTop={1}>
        <Text color="cyan">{spinnerFrames[frame]}</Text>
        <Text> agent 正在处理 </Text>
        <Text color="magenta" bold>{tools}</Text>
        <Text dimColor>  /stop 可请求停止</Text>
      </Box>
    );
  }

  if (props.runState === 'error') {
    return (
      <Box marginTop={1}>
        <Text color="red">上一轮发生错误, 可以继续输入或用 /status 检查状态。</Text>
      </Box>
    );
  }

  return (
    <Box marginTop={1}>
      <Text dimColor>直接输入问题, 或使用 /help /status /papers。</Text>
    </Box>
  );
}
