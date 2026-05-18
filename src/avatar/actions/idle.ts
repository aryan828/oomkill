import type { AvatarActionHandler } from '../types';
import { resetToRelaxedPose, stopAllClips } from '../relaxed-pose';

/** Calm standing pose with a very subtle sway. No baked GLTF clips. */
export const idleAction: AvatarActionHandler = {
	name: 'idle',
	enter({ rig }) {
		stopAllClips(rig);
		resetToRelaxedPose(rig.root);
	},
	play({ rig, gsap, reducedMotion }) {
		resetToRelaxedPose(rig.root);

		if (reducedMotion) return;

		const tl = gsap.timeline({ repeat: -1, yoyo: true, defaults: { ease: 'sine.inOut' } });
		tl.to(rig.parts.body.rotation, { y: 0.018, duration: 2.4 }, 0);
		tl.to(rig.root.position, { y: '+=0.006', duration: 2.4 }, 0);
		tl.to(rig.parts.head.rotation, { x: 0.02, duration: 2.4 }, 0);
		return tl;
	},
	exit({ rig, gsap }) {
		stopAllClips(rig);
		gsap.set([rig.root.position, rig.parts.body.rotation, rig.parts.head.rotation], {
			clearProps: 'all',
		});
		resetToRelaxedPose(rig.root);
	},
};
