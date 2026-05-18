import { Clock, Mesh } from 'three';
import { AvatarController } from '../avatar/avatar-controller';
import { fitCameraToObject } from '../avatar/fit-camera';
import { loadAvatarModel, type AvatarColors } from '../avatar/load-avatar-model';
import { createAvatarScene } from '../avatar/create-avatar-scene';

function readThemeColors(): AvatarColors {
	const style = getComputedStyle(document.documentElement);
	return {
		accent: style.getPropertyValue('--accent').trim() || '#0d9488',
		accentHover: style.getPropertyValue('--accent-hover').trim() || '#0f766e',
		surface: style.getPropertyValue('--bg-elevated').trim() || '#ffffff',
	};
}

export async function initAboutAvatar(root: HTMLElement): Promise<() => void> {
	const canvas = root.querySelector<HTMLCanvasElement>('[data-about-avatar-canvas]');
	if (!canvas) return () => {};

	const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	const colors = readThemeColors();

	root.classList.add('about-avatar--loading');

	let rig;
	try {
		rig = await loadAvatarModel('/models/avatar.glb', colors);
	} catch (error) {
		console.error('[avatar] Failed to load model', error);
		root.classList.remove('about-avatar--loading');
		return () => {};
	}

	root.classList.remove('about-avatar--loading');

	const scene = createAvatarScene(canvas, rig);
	fitCameraToObject(scene.camera, rig.root, 1.32);

	const controller = new AvatarController(rig, { reducedMotion, waveInterval: 4.5 });
	scene.resize();
	controller.startDefaultBehavior();

	const clock = new Clock();
	let frameId = 0;
	const render = () => {
		const dt = clock.getDelta();
		rig.mixer?.update(dt);
		scene.renderer.render(scene.scene, scene.camera);
		frameId = requestAnimationFrame(render);
	};
	frameId = requestAnimationFrame(render);

	const resizeObserver = new ResizeObserver(() => {
		scene.resize();
		fitCameraToObject(scene.camera, rig.root, 1.32);
	});
	resizeObserver.observe(root);

	return () => {
		cancelAnimationFrame(frameId);
		resizeObserver.disconnect();
		controller.destroy();
		scene.dispose();
		rig.root.traverse((child) => {
			if (!(child instanceof Mesh)) return;
			child.geometry.dispose();
			const mat = child.material;
			if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
			else mat.dispose();
		});
	};
}
