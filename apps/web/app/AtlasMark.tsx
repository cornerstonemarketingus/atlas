/**
 * The Atlas mark: a figure bearing a load.
 *
 * Atlas carries weight without dropping it, which is the product's whole
 * claim — a change ships only once it has been verified, and the bar stays
 * up. Read flat, it is also the letter A.
 *
 * Three decisions that are load-bearing in their own right:
 *
 * - The A is ONE mitred path, not two strokes. Two square-capped strokes
 *   meeting at the apex leave a notch that reads as a rendering artifact.
 * - The bar is drawn LAST, over the apex, so the mitre tucks behind it and
 *   the two make contact. Drawn with a gap, the bar floats and the whole
 *   idea of bearing a load goes with it.
 * - Everything is 3.1 units thick against a 24 unit box, because the mark
 *   has to survive a 16px favicon, where anything finer turns to mush.
 *
 * Colour comes from `currentColor`, so the same file is acid-on-ink in the
 * header and inverts anywhere else without a second copy.
 */
export function AtlasMark({ size = 20 }: { readonly size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M3.9 20.9 L12 7.6 L20.1 20.9"
        stroke="currentColor"
        strokeWidth="3.1"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
      <path d="M7.5 16.2 H16.5" stroke="currentColor" strokeWidth="3.1" strokeLinecap="square" />
      <rect x="2.4" y="2" width="19.2" height="3.5" fill="currentColor" />
    </svg>
  );
}
