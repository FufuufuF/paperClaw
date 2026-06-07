import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { CliRunState } from '../../../channel/types.js';

export function InputBox(props: {
  runState: CliRunState;
  onSubmit: (text: string) => void;
  onExit: () => void;
}) {
  const [value, setValue] = useState('');

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      props.onExit();
      return;
    }
    if (hasLineBreak(input)) {
      const parts = input.split(/\r\n|\r|\n/);
      const first = `${value}${parts[0] ?? ''}`.trim();
      if (first.length > 0) props.onSubmit(first);
      for (const part of parts.slice(1, -1)) {
        const text = part.trim();
        if (text.length > 0) props.onSubmit(text);
      }
      setValue(parts.at(-1) ?? '');
      return;
    }
    if (key.return) {
      const text = value.trim();
      if (text.length > 0) {
        props.onSubmit(text);
        setValue('');
      }
      return;
    }
    if (key.backspace || key.delete) {
      setValue((current) => current.slice(0, -1));
      return;
    }
    if (key.ctrl && input === 'u') {
      setValue('');
      return;
    }
    if (key.escape) {
      setValue('');
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setValue((current) => current + input);
    }
  });

  const muted = props.runState === 'working';

  return (
    <Box marginTop={1}>
      <Text color="green" bold>you&gt; </Text>
      <Text>{value}</Text>
      <Text inverse> </Text>
      {muted && (
        <Text dimColor>  当前任务未结束, 新输入会排队</Text>
      )}
    </Box>
  );
}

function hasLineBreak(input: string): boolean {
  return input.includes('\r') || input.includes('\n');
}
