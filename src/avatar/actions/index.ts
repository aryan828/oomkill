import type { AvatarAction, AvatarActionHandler } from '../types';
import { idleAction } from './idle';
import { waveAction } from './wave';

/** Register new actions here to expose them on the controller. */
export const avatarActions: AvatarActionHandler[] = [idleAction, waveAction];

export function getActionHandlers(): Map<AvatarAction, AvatarActionHandler> {
	return new Map(avatarActions.map((handler) => [handler.name, handler]));
}
