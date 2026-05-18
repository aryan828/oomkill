import type { AvatarActionHandler } from '../types';
import { resetToRelaxedPose, stopAllClips } from '../relaxed-pose';

/**
 * Forward wave toward the camera (+Z).
 * Upper arm lifts in front; forearm does a gentle side-to-side wave.
 */
export const waveAction: AvatarActionHandler = {
	name: 'wave',
	enter({ rig, gsap }) {
		stopAllClips(rig);
		resetToRelaxedPose(rig.root);

		const arm = rig.parts.armRight.rotation;
		const fore = rig.parts.forearmRight?.rotation;
		gsap.set(arm, { x: RELAXED_ARM.x, y: RELAXED_ARM.y, z: RELAXED_ARM.z });
		if (fore) gsap.set(fore, { x: 0.06, y: 0, z: 0 });
	},
	play({ rig, gsap, reducedMotion }) {
		const arm = rig.parts.armRight.rotation;
		const fore = rig.parts.forearmRight?.rotation;

		if (reducedMotion) {
			gsap.set(arm, WAVE_RAISED);
			if (fore) gsap.set(fore, { x: -0.45, z: 0, y: 0 });
			return;
		}

		const tl = gsap.timeline({ defaults: { ease: 'power2.inOut' } });

		// Lift arm up and out toward the viewer.
		tl.to(arm, { ...WAVE_RAISED, duration: 0.55, ease: 'power2.out' }, 0);
		tl.to(fore, { x: -0.5, y: 0, z: 0, duration: 0.35, ease: 'power2.out' }, 0.12);
		tl.to(rig.parts.head.rotation, { y: -0.06, x: 0.03, duration: 0.3 }, 0.15);

		// Wiggle at the elbow only (smooth hello).
		tl.to(
			fore,
			{ z: 0.22, duration: 0.28, ease: 'sine.inOut', yoyo: true, repeat: 3 },
			0.55,
		);

		// Settle back to relaxed stand.
		tl.to(arm, { ...RELAXED_ARM, duration: 0.55, ease: 'power2.inOut' }, '+=0.08');
		tl.to(fore, { x: 0.06, y: 0, z: 0, duration: 0.5, ease: 'power2.inOut' }, '<0.1');
		tl.to(rig.parts.head.rotation, { y: 0, x: 0, duration: 0.35 }, '<0.2');

		return tl;
	},
	exit({ rig, gsap }) {
		gsap.set([rig.parts.armRight.rotation, rig.parts.forearmRight?.rotation, rig.parts.head.rotation], {
			clearProps: 'all',
		});
		resetToRelaxedPose(rig.root);
	},
};

/** Relaxed right upper arm (matches relaxed-pose.ts). */
const RELAXED_ARM = { x: 0.12, y: -0.04, z: -0.18 };

/** Raised toward camera: positive X pitches the mixamorig arm forward on this rig. */
const WAVE_RAISED = { x: 1.15, y: -0.12, z: -0.55 };
