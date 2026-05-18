import gsap from 'gsap';
import type { AvatarAction, AvatarControllerOptions, AvatarRig, ActionContext } from './types';
import { getActionHandlers } from './actions';

export class AvatarController {
	private readonly handlers = getActionHandlers();
	private readonly ctx: ActionContext;
	private readonly waveInterval: number;
	private currentAction: AvatarAction | null = null;
	private activeTimeline: gsap.core.Timeline | null = null;
	private waveTimer: gsap.core.Tween | null = null;
	private destroyed = false;

	constructor(rig: AvatarRig, options: AvatarControllerOptions = {}) {
		this.ctx = {
			rig,
			gsap,
			reducedMotion: options.reducedMotion ?? false,
		};
		this.waveInterval = options.waveInterval ?? 4.5;
	}

	/** Play an action by name. Resolves when the timeline finishes (looping actions never resolve). */
	play(action: AvatarAction): Promise<void> {
		if (this.destroyed) return Promise.resolve();

		const handler = this.handlers.get(action);
		if (!handler) {
			console.warn(`[avatar] Unknown action: ${action}`);
			return Promise.resolve();
		}

		this.stopCurrent();

		const previous = this.currentAction;
		if (previous) {
			const prevHandler = this.handlers.get(previous);
			prevHandler?.exit?.(this.ctx);
		}

		this.currentAction = action;
		handler.enter?.(this.ctx);

		const timeline = handler.play(this.ctx);
		if (!timeline) return Promise.resolve();

		this.activeTimeline = timeline;

		if (timeline.repeat() === -1) return Promise.resolve();

		return new Promise((resolve) => {
			timeline.eventCallback('onComplete', () => {
				if (this.activeTimeline === timeline) this.activeTimeline = null;
				resolve();
			});
		});
	}

	/** Idle loop with an automatic wave every `waveInterval` seconds. */
	startDefaultBehavior(): void {
		this.stopBehavior();
		void this.play('idle');
		if (this.ctx.reducedMotion) return;

		const scheduleWave = () => {
			this.waveTimer = gsap.delayedCall(this.waveInterval, async () => {
				if (this.destroyed) return;
				await this.play('wave');
				if (!this.destroyed) {
					void this.play('idle');
					scheduleWave();
				}
			});
		};

		scheduleWave();
	}

	stopBehavior(): void {
		this.waveTimer?.kill();
		this.waveTimer = null;
	}

	stopCurrent(): void {
		this.activeTimeline?.kill();
		this.activeTimeline = null;
	}

	getCurrentAction(): AvatarAction | null {
		return this.currentAction;
	}

	destroy(): void {
		this.destroyed = true;
		this.stopBehavior();
		this.stopCurrent();
		const handler = this.currentAction ? this.handlers.get(this.currentAction) : null;
		handler?.exit?.(this.ctx);
		this.currentAction = null;
	}
}
