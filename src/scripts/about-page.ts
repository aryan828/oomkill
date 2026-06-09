import gsap from 'gsap';

/** About-only: chip entrance animation. Page enter is handled by site-motion. */
export function initAboutPage(root: HTMLElement): () => void {
	const cleanups: Array<() => void> = [];

	const mm = gsap.matchMedia();

	mm.add(
		{
			reduce: '(prefers-reduced-motion: reduce)',
			motion: '(prefers-reduced-motion: no-preference)',
		},
		(context) => {
			const { reduce } = context.conditions as { reduce: boolean };

			gsap.context(() => {
				const figureWrap = root.querySelector('.about-hero-figure');
				const topics = root.querySelector('.about-topics');

				if (reduce) {
					if (figureWrap) gsap.set(figureWrap, { autoAlpha: 1, scale: 1, y: 0 });
					if (topics) gsap.set(topics.querySelectorAll('.about-chip'), { autoAlpha: 1, y: 0 });
					return;
				}

				if (figureWrap) {
					gsap.from(figureWrap, {
						autoAlpha: 0,
						scale: 0.92,
						y: 10,
						duration: 0.5,
						ease: 'back.out(1.35)',
						delay: 0.12,
					});
				}

				if (topics) {
					gsap.from(topics.querySelectorAll('.about-chip'), {
						autoAlpha: 0,
						y: 8,
						duration: 0.32,
						stagger: 0.04,
						ease: 'power2.out',
						delay: 0.28,
					});
				}
			}, root);
		},
	);

	cleanups.push(() => mm.revert());

	return () => cleanups.forEach((fn) => fn());
}
