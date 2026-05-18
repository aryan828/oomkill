import type { Object3D } from 'three';
import { Bone } from 'three';

export function collectBones(root: Object3D): Bone[] {
	const bones: Bone[] = [];
	root.traverse((node) => {
		if (node instanceof Bone) bones.push(node);
	});
	return bones;
}

/** Find first bone whose name matches any of the patterns (case-insensitive). */
export function findBone(root: Object3D, patterns: string[]): Bone | null {
	const bones = collectBones(root);
	for (const pattern of patterns) {
		const re = new RegExp(pattern, 'i');
		const hit = bones.find((b) => re.test(b.name));
		if (hit) return hit;
	}
	return null;
}
