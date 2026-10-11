export const BOTTOM_THRESHOLD = 80;

export function nearBottom(container, threshold = BOTTOM_THRESHOLD) {
  return container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
}

/** Content updates never re-enable following or scroll the outer page. */
export function createScrollFollow(containerFor) {
  let following = true;
  return {
    onScroll() {
      const container = containerFor();
      if (container) following = nearBottom(container);
      return following;
    },
    reset() { following = true; },
    contentChanged() {
      const container = containerFor();
      if (!following || !container) return false;
      container.scrollTo({ top: Math.max(0, container.scrollHeight - container.clientHeight), behavior: "auto" });
      return true;
    },
    jump() { following = true; return this.contentChanged(); },
  };
}
