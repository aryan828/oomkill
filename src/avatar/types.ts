import type { AnimationAction, AnimationClip, AnimationMixer, Group, Object3D } from 'three';
import type { gsap } from 'gsap';

/** Add new actions here and register a handler in `actions/index.ts`. */
export type AvatarAction = 'idle' | 'wave';

export interface AvatarRig {
	root: Group;
	parts: {
		body: Object3D;
		head: Object3D;
		armLeft: Object3D;
		armRight: Object3D;
		legLeft: Object3D;
		legRight: Object3D;
		/** Optional; used for a more natural wave when present. */
		forearmRight?: Object3D;
	};
	mixer?: AnimationMixer;
	clips?: AnimationClip[];
	idleAction: AnimationAction | null;
}

export interface ActionContext {
	rig: AvatarRig;
	gsap: typeof gsap;
	reducedMotion: boolean;
}

export interface AvatarActionHandler {
	name: AvatarAction;
	enter?: (ctx: ActionContext) => void;
	play: (ctx: ActionContext) => gsap.core.Timeline | void;
	exit?: (ctx: ActionContext) => void;
}

export interface AvatarControllerOptions {
	waveInterval?: number;
	reducedMotion?: boolean;
}
