import {
	AnimationMixer,
	Box3,
	Color,
	Group,
	Mesh,
	MeshStandardMaterial,
	Object3D,
	SRGBColorSpace,
	Texture,
	Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { findBone } from './find-bone';
import { resetToRelaxedPose } from './relaxed-pose';
import type { AvatarRig } from './types';

export interface AvatarColors {
	accent: string;
	accentHover: string;
	surface: string;
}

const TARGET_HEIGHT = 1.62;

function setTextureColorSpace(texture: Texture): void {
	texture.colorSpace = SRGBColorSpace;
}

/** Keep GLB maps and colors; only upgrade materials for nicer lighting. */
function enhanceMaterials(root: Object3D, accent: Color): void {
	root.traverse((child) => {
		if (!(child instanceof Mesh)) return;
		child.castShadow = true;

		const sources = Array.isArray(child.material) ? child.material : [child.material];
		const next = sources.map((source) => {
			const color =
				source && 'color' in source && source.color instanceof Color
					? source.color.clone()
					: new Color(0xffffff);

			const map = source && 'map' in source ? source.map : null;
			if (map instanceof Texture) setTextureColorSpace(map);

			const name = child.name.toLowerCase();
			if (!map && (name.includes('shirt') || name.includes('torso') || name.includes('body'))) {
				color.copy(accent);
			}

			const mat = new MeshStandardMaterial({
				color,
				map: map ?? undefined,
				metalness: map ? 0.05 : 0.08,
				roughness: map ? 0.72 : 0.62,
			});

			if (source) source.dispose();
			return mat;
		});

		child.material = next.length === 1 ? next[0] : next;
	});
}

function normalizeModel(model: Group): void {
	const box = new Box3().setFromObject(model);
	const size = box.getSize(new Vector3());
	const scale = TARGET_HEIGHT / size.y;
	model.scale.setScalar(scale);

	box.setFromObject(model);
	const center = box.getCenter(new Vector3());
	model.position.x -= center.x;
	model.position.z -= center.z;
	model.position.y -= box.min.y;

	model.rotation.y = Math.PI;
}

/**
 * Load a rigged GLB. Default is a male humanoid with Idle / Walk clips.
 * Replace `public/models/avatar.glb` with your own (e.g. Quaternius Regular Male).
 */
export async function loadAvatarModel(
	url = '/models/avatar.glb',
	colors?: AvatarColors,
): Promise<AvatarRig> {
	const gltf = await new GLTFLoader().loadAsync(url);
	const model = gltf.scene as Group;

	const accent = new Color(colors?.accent ?? '#0d9488');
	enhanceMaterials(model, accent);
	normalizeModel(model);

	const root = new Group();
	root.name = 'avatar';
	root.add(model);

	const armRight =
		findBone(model, ['mixamorigRightArm', 'RightArm', 'upperarm_r', 'Arm_R']) ?? model;
	const armLeft =
		findBone(model, ['mixamorigLeftArm', 'LeftArm', 'upperarm_l', 'Arm_L']) ?? model;
	const forearmRight = findBone(model, [
		'mixamorigRightForeArm',
		'RightForeArm',
		'lowerarm_r',
		'ForeArm_R',
	]);

	const parts = {
		body: findBone(model, ['mixamorigHips', 'Hips', 'spine', 'Spine']) ?? model,
		head: findBone(model, ['mixamorigHead', 'Head']) ?? model,
		armLeft,
		armRight,
		legLeft: findBone(model, ['mixamorigLeftLeg', 'LeftLeg']) ?? model,
		legRight: findBone(model, ['mixamorigRightLeg', 'RightLeg']) ?? model,
		forearmRight: forearmRight ?? armRight,
	};

	const mixer = gltf.animations.length > 0 ? new AnimationMixer(model) : undefined;

	resetToRelaxedPose(root);

	return {
		root,
		parts,
		mixer,
		clips: gltf.animations,
		idleAction: null,
	};
}
