import {
	AmbientLight,
	DirectionalLight,
	Group,
	HemisphereLight,
	PerspectiveCamera,
	Scene,
	SRGBColorSpace,
	WebGLRenderer,
} from 'three';
import type { AvatarRig } from './types';

export interface AvatarScene {
	renderer: WebGLRenderer;
	scene: Scene;
	camera: PerspectiveCamera;
	rigGroup: Group;
	resize: () => void;
	dispose: () => void;
}

export function createAvatarScene(canvas: HTMLCanvasElement, rig: AvatarRig): AvatarScene {
	const scene = new Scene();
	const rigGroup = new Group();
	rigGroup.add(rig.root);
	scene.add(rigGroup);

	const camera = new PerspectiveCamera(34, 1, 0.1, 50);
	camera.position.set(0, 1, 3);

	const hemi = new HemisphereLight(0xfff5ee, 0x8ecae6, 0.55);
	scene.add(hemi);

	const ambient = new AmbientLight(0xffffff, 0.45);
	scene.add(ambient);

	const key = new DirectionalLight(0xffffff, 0.95);
	key.position.set(2, 4, 3);
	scene.add(key);

	const fill = new DirectionalLight(0xb8e0ff, 0.35);
	fill.position.set(-2, 2, -2);
	scene.add(fill);

	const renderer = new WebGLRenderer({
		canvas,
		alpha: true,
		antialias: true,
		powerPreference: 'low-power',
	});
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
	renderer.outputColorSpace = SRGBColorSpace;
	renderer.setClearColor(0x000000, 0);

	const resize = () => {
		const parent = canvas.parentElement;
		if (!parent) return;
		const width = parent.clientWidth;
		const height = parent.clientHeight;
		if (width === 0 || height === 0) return;
		renderer.setSize(width, height, false);
		camera.aspect = width / height;
		camera.updateProjectionMatrix();
	};

	const dispose = () => {
		renderer.dispose();
	};

	return { renderer, scene, camera, rigGroup, resize, dispose };
}
