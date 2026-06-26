import gsap from 'gsap';
import { initAboutPage } from './about-page';

gsap.defaults({ duration: 0.4, ease: 'power2.out' });

const EXIT = { duration: 0.18, ease: 'power2.in' as const };
const ENTER = { duration: 0.42, ease: 'power3.out' as const };
const STAGGER = 0.055;

let routeCleanup: (() => void) | undefined;
let enterTween: gsap.core.Timeline | undefined;
let mm: gsap.MatchMedia | undefined;

function prefersReducedMotion(): boolean {
	return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function revealInstant(shell: HTMLElement) {
	gsap.set(shell, { autoAlpha: 1, y: 0, clearProps: 'transform' });
	gsap.set(shell.querySelectorAll('[data-animate], [data-animate-child]'), {
		autoAlpha: 1,
		y: 0,
		scale: 1,
		clearProps: 'transform',
	});
}

function collectEnterTargets(shell: HTMLElement): Element[] {
	const explicit = shell.querySelectorAll('[data-animate]');
	if (explicit.length) return Array.from(explicit);

	const listItems = shell.querySelectorAll('.post-list > li');
	if (listItems.length) {
		const targets: Element[] = [];
		for (const child of shell.children) {
			if (child instanceof HTMLElement && child.classList.contains('post-list')) continue;
			targets.push(child);
		}
		targets.push(...listItems);
		return targets;
	}

	return Array.from(shell.children);
}

const rowX = new WeakMap<HTMLElement, (value: number) => void>();

function bindPostRowHoverOnce() {
	if (document.documentElement.dataset.postHoverBound === 'true') return;
	document.documentElement.dataset.postHoverBound = 'true';

	document.addEventListener(
		'pointerover',
		(event) => {
			const row = (event.target as Element).closest<HTMLElement>('.post-row');
			if (!row) return;
			if (!rowX.has(row))
				rowX.set(row, gsap.quickTo(row, 'x', { duration: 0.35, ease: 'power2.out' }));
			rowX.get(row)!(4);
		},
		true,
	);

	document.addEventListener(
		'pointerout',
		(event) => {
			const row = (event.target as Element).closest<HTMLElement>('.post-row');
			if (!row || row.contains(event.relatedTarget as Node)) return;
			rowX.get(row)?.(0);
		},
		true,
	);
}

function runEnter(shell: HTMLElement) {
	enterTween?.kill();
	const targets = collectEnterTargets(shell);
	if (!targets.length) {
		gsap.set(shell, { autoAlpha: 1 });
		return;
	}

	gsap.set(shell, { autoAlpha: 1 });
	gsap.set(targets, { autoAlpha: 0, y: 12 });

	enterTween = gsap.timeline({ defaults: ENTER });
	enterTween.to(targets, {
		autoAlpha: 1,
		y: 0,
		stagger: STAGGER,
		duration: 0.38,
		clearProps: 'transform',
	});
}

function runExit(shell: HTMLElement) {
	enterTween?.kill();
	gsap.to(shell, {
		autoAlpha: 0,
		y: -8,
		...EXIT,
		overwrite: 'auto',
	});
}

function initRouteModules() {
	const about = document.querySelector<HTMLElement>('[data-about-page]');
	if (about) routeCleanup = initAboutPage(about);
}

function onPageLoad() {
	routeCleanup?.();
	routeCleanup = undefined;
	enterTween?.kill();

	const shell = document.querySelector<HTMLElement>('[data-page-enter]');
	if (!shell) return;

	if (prefersReducedMotion()) {
		revealInstant(shell);
	} else {
		gsap.set(shell, { autoAlpha: 0, y: 8 });
		runEnter(shell);
	}

	initRouteModules();
}

function onBeforeSwap() {
	if (prefersReducedMotion()) return;
	const shell = document.querySelector<HTMLElement>('[data-page-enter]');
	if (shell) runExit(shell);
}

export function initSiteMotion() {
	if (mm) return;

	mm = gsap.matchMedia();
	mm.add('(prefers-reduced-motion: reduce)', () => {
		gsap.globalTimeline.timeScale(1);
	});

	document.addEventListener('astro:before-swap', onBeforeSwap);
	document.addEventListener('astro:page-load', onPageLoad);
	bindPostRowHoverOnce();
}
