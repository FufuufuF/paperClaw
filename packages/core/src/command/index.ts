export { CommandRouter } from './router.js';
export type { CommandHandler, CommandResult } from './router.js';
export {
  registerBuiltinCommands,
  makeClearCommand,
  makeHelpCommand,
  makeHistoryCommand,
  makeCostCommand,
  makeSessionCommand,
} from './builtin.js';
