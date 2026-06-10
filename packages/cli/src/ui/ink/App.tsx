import { useSyncExternalStore } from 'react';
import { Box } from 'ink';
import type { InkCliStore } from './store.js';
import { InputBox } from './components/InputBox.js';
import { MessageBlock } from './components/MessageBlock.js';
import { StatusBar } from './components/StatusBar.js';
import { SwitchPicker } from './components/SwitchPicker.js';
import { ToolProgress } from './components/ToolProgress.js';

export function InkCliApp(props: {
  store: InkCliStore;
  onSubmit: (text: string) => void;
  onExit: () => void;
  onSwitchMove: (delta: number) => void;
  onSwitchConfirm: () => void;
  onSwitchCancel: () => void;
}) {
  const state = useSyncExternalStore(
    props.store.subscribe,
    props.store.getSnapshot,
    props.store.getSnapshot,
  );
  const visibleMessages = state.messages.slice(-24);

  return (
    <Box flexDirection="column" paddingX={1}>
      <StatusBar
        status={state.runtimeStatus}
        runState={state.runState}
        queuedCount={state.queuedCount}
      />
      <Box flexDirection="column">
        {visibleMessages.map((message) => (
          <MessageBlock key={message.id} message={message} />
        ))}
      </Box>
      <ToolProgress
        runState={state.runState}
        currentTools={state.currentTools}
      />
      {state.switchPicker ? (
        <SwitchPicker
          picker={state.switchPicker}
          onMove={props.onSwitchMove}
          onConfirm={props.onSwitchConfirm}
          onCancel={props.onSwitchCancel}
        />
      ) : (
        <InputBox
          runState={state.runState}
          onSubmit={props.onSubmit}
          onExit={props.onExit}
        />
      )}
    </Box>
  );
}
