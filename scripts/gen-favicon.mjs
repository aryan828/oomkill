import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';

const svg = await readFile('public/favicon.svg');

// 32x32 PNG written as favicon.ico (matches the prior PNG-in-.ico approach).
await writeFile(
	'public/favicon.ico',
	await sharp(svg, { density: 384 }).resize(32, 32).png().toBuffer(),
);

// 180x180 Apple touch icon.
await writeFile(
	'public/apple-touch-icon.png',
	await sharp(svg, { density: 384 }).resize(180, 180).png().toBuffer(),
);

console.log('favicon.ico + apple-touch-icon.png generated');
