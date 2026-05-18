import { Box3, PerspectiveCamera, Vector3 } from 'three';
import type { Object3D } from 'three';

/** Frame a character so the full body stays in view (no clipping out of the canvas). */
export function fitCameraToObject(
	camera: PerspectiveCamera,
	object: Object3D,
	padding = 1.28,
): void {
	const box = new Box3().setFromObject(object);
	const size = box.getSize(new Vector3());
	const center = box.getCenter(new Vector3());

	const fov = (camera.fov * Math.PI) / 180;
	const aspect = camera.aspect || 1;
	const heightDist = (size.y / 2) / Math.tan(fov / 2);
	const widthDist = (size.x / 2) / Math.tan(fov / 2) / aspect;
	const depth = size.z;
	const distance = Math.max(heightDist, widthDist) * padding + depth * 0.15;

	camera.position.set(center.x, center.y + size.y * 0.02, center.z + distance);
	camera.lookAt(center.x, center.y + size.y * 0.06, center.z);
	camera.near = 0.1;
	camera.far = distance * 4;
	camera.updateProjectionMatrix();
}
