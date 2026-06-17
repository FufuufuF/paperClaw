import { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { CliRunState } from '../../../channel/types.js';

const BUSY_SUBMIT_SUPPRESSION_MS = 1000;

export function InputBox(props: {
  runState: CliRunState;
  onSubmit: (text: string) => boolean | void;
  onExit: () => void;
}) {
  const [value, setValue] = useState('');
  const previousRunState = useRef<CliRunState>(props.runState);
  const suppressSubmitUntil = useRef(0);

  if (previousRunState.current !== props.runState) {
    if (previousRunState.current === 'working' && props.runState !== 'working') {
      suppressSubmitUntil.current = Date.now() + BUSY_SUBMIT_SUPPRESSION_MS;
    } else if (props.runState === 'working') {
      suppressSubmitUntil.current = 0;
    }
    previousRunState.current = props.runState;
  }

  useInput((input, key) => {
    const submitEnabled = canSubmitInput(props.runState);
    if (key.ctrl && input === 'c') {
      props.onExit();
      return;
    }
    if (hasLineBreak(input)) {
      if (!submitEnabled) {
        const retained = retainInputWithoutSubmitBreak(input);
        if (retained.length > 0) setValue((current) => current + retained);
        return;
      }
      if (shouldSuppressBufferedSubmit(Date.now(), suppressSubmitUntil.current)) {
        suppressSubmitUntil.current = 0;
        const retained = retainInputWithoutSubmitBreak(input);
        if (retained.length > 0) setValue((current) => current + retained);
        return;
      }
      const parts = input.split(/\r\n|\r|\n/);
      const first = `${value}${parts[0] ?? ''}`.trim();
      if (first.length > 0 && props.onSubmit(first) === false) {
        setValue(`${value}${retainInputWithoutSubmitBreak(input)}`);
        return;
      }
      for (const part of parts.slice(1, -1)) {
        const text = part.trim();
        if (text.length > 0 && props.onSubmit(text) === false) {
          setValue(`${value}${retainInputWithoutSubmitBreak(input)}`);
          return;
        }
      }
      setValue(parts.at(-1) ?? '');
      return;
    }
    if (key.return) {
      if (!submitEnabled) return;
      if (shouldSuppressBufferedSubmit(Date.now(), suppressSubmitUntil.current)) {
        suppressSubmitUntil.current = 0;
        return;
      }
      const text = value.trim();
      if (text.length > 0) {
        if (props.onSubmit(text) !== false) setValue('');
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
        <Text dimColor>  当前任务未结束, 暂不可发送</Text>
      )}
    </Box>
  );
}

export function canSubmitInput(runState: CliRunState): boolean {
  return runState !== 'working';
}

export function shouldSuppressBufferedSubmit(now: number, suppressUntil: number): boolean {
  return suppressUntil > 0 && now <= suppressUntil;
}

export function retainInputWithoutSubmitBreak(input: string): string {
  return input.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/g, '');
}

function hasLineBreak(input: string): boolean {
  return input.includes('\r') || input.includes('\n');
}
