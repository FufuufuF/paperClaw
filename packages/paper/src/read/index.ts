import { fileURLToPath } from 'node:url';

export const PAPER_READ_SKILLS_DIR = fileURLToPath(new URL('./skills', import.meta.url));

export {
  createReadPaperTool,
  createReadPaperSectionTool,
  createRecordPaperSectionNoteTool,
  createReaderTools,
  readPaper,
  readPaperSection,
  recordPaperSectionNote,
  type ReadPaperInput,
  type ReadPaperResult,
  type ReadPaperSectionInput,
  type ReadPaperSectionResult,
  type RecordPaperSectionNoteInput,
  type RecordPaperSectionNoteResult,
  type ReaderToolOpts,
} from './read-paper-tool.js';
export {
  createPaperFileTools,
  type NoteListing,
} from './file-tools.js';
export {
  extractPdfText,
  type ExtractedPdfText,
} from './pdf.js';
export {
  updateProfileFromNote,
  type ProfileUpdateResult,
} from '../shared/profile-updater.js';
