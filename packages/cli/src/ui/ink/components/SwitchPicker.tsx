import { Box, Text, useInput } from 'ink';
import type { CliSwitchPickerState } from '../../../channel/types.js';

export function SwitchPicker(props: {
  picker: CliSwitchPickerState;
  onMove: (delta: number) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useInput((input, key) => {
    if (key.upArrow) {
      props.onMove(-1);
      return;
    }
    if (key.downArrow) {
      props.onMove(1);
      return;
    }
    if (key.return) {
      props.onConfirm();
      return;
    }
    if (key.escape || (key.ctrl && input === 'c')) {
      props.onCancel();
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="cyan">选择 session</Text>
      {props.picker.items.map((item, idx) => {
        const selected = idx === props.picker.selectedIndex;
        return (
          <Box key={item.id} flexDirection="column">
            <Text color={selected ? 'cyan' : undefined} bold={selected}>
              {selected ? '>' : ' '} {item.active ? '*' : ' '} {item.label}  {item.turnCount} turns  last: {item.lastActiveAt}
            </Text>
            <Text dimColor>    {item.preview}</Text>
          </Box>
        );
      })}
      <Text dimColor>↑/↓ 选择    Enter 切换    Esc 取消</Text>
    </Box>
  );
}
