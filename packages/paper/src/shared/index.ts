import { fileURLToPath } from 'node:url';

export const PROFILE_SKILLS_DIR = fileURLToPath(new URL('./skills/profile', import.meta.url));

export { readProfile, type ProfileSnapshot } from './profile.js';
export {
  updateProfileFromNote,
  type ProfileUpdateResult,
} from './profile-updater.js';
