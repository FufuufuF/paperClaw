import type { CommandRuntimeStatus } from '@paperclaw/core';
import type {
  CliMessage,
  CliRunState,
  CliSwitchPickerItem,
  CliViewState,
} from '../../channel/types.js';
import { moveSwitchSelection } from './switch-picker.js';

export class InkCliStore {
  private state: CliViewState = {
    messages: [],
    runState: 'idle',
    currentTools: [],
    queuedCount: 0,
  };

  private readonly listeners = new Set<() => void>();

  getSnapshot = (): CliViewState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  appendMessage(message: CliMessage): void {
    this.setState({
      messages: [...this.state.messages, message].slice(-80),
    });
  }

  replaceMessages(messages: CliMessage[]): void {
    this.setState({ messages: messages.slice(-80) });
  }

  setRuntimeStatus(runtimeStatus: CommandRuntimeStatus): void {
    this.setState({ runtimeStatus });
  }

  setRunState(runState: CliRunState, lastError?: string): void {
    this.setState({ runState, lastError });
  }

  setCurrentTools(currentTools: string[]): void {
    this.setState({ currentTools });
  }

  setQueuedCount(queuedCount: number): void {
    this.setState({ queuedCount });
  }

  openSwitchPicker(items: CliSwitchPickerItem[]): void {
    this.setState({ switchPicker: { items, selectedIndex: 0 } });
  }

  moveSwitchPicker(delta: number): void {
    const picker = this.state.switchPicker;
    if (!picker) return;
    this.setState({
      switchPicker: {
        ...picker,
        selectedIndex: moveSwitchSelection(picker.selectedIndex, delta, picker.items.length),
      },
    });
  }

  closeSwitchPicker(): void {
    this.setState({ switchPicker: undefined });
  }

  private setState(patch: Partial<CliViewState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
