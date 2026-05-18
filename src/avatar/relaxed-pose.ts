import { Object3D, SkinnedMesh } from 'three';
import { findBone } from './find-bone';

/** Slight A-pose → relaxed stand (arms down, not T-pose). Radians, mixamorig-friendly. */
const RELAXED = {
	armLeft: { x: 0.12, y: 0.04, z: 0.18 },
	armRight: { x: 0.12, y: -0.04, z: -0.18 },
	forearmLeft: { x: 0.06, y: 0, z: 0 },
	forearmRight: { x: 0.06, y: 0, z: 0 },
} as const;

/** Reset skinned meshes to bind pose, then nudge into a calm standing pose. */
export function resetToRelaxedPose(root: Object3D): void {
	root.traverse((child) => {
		if (child instanceof SkinnedMesh) child.skeleton.pose();
	});

	const armL = findBone(root, ['mixamorigLeftArm', 'LeftArm', 'upperarm_l']);
	const armR = findBone(root, ['mixamorigRightArm', 'RightArm', 'upperarm_r']);
	const foreL = findBone(root, ['mixamorigLeftForeArm', 'LeftForeArm', 'lowerarm_l']);
	const foreR = findBone(root, ['mixamorigRightForeArm', 'RightForeArm', 'lowerarm_r']);

	if (armL) armL.rotation.set(RELAXED.armLeft.x, RELAXED.armLeft.y, RELAXED.armLeft.z);
	if (armR) armR.rotation.set(RELAXED.armRight.x, RELAXED.armRight.y, RELAXED.armRight.z);
	if (foreL) foreL.rotation.set(RELAXED.forearmLeft.x, RELAXED.forearmLeft.y, RELAXED.forearmLeft.z);
	if (foreR) foreR.rotation.set(RELAXED.forearmRight.x, RELAXED.forearmRight.y, RELAXED.forearmRight.z);
}

export function stopAllClips(rig: { mixer?: { stopAllAction: () => void }; idleAction: null }): void {
	rig.mixer?.stopAllAction();
	rig.idleAction = null;
}
