export const BOTTOM_THRESHOLD = 2;

export function nearBottom(container, threshold = BOTTOM_THRESHOLD) {
  return container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
}

/** Content updates never re-enable following or scroll the outer page. */
export function createScrollFollow(containerFor) {
  let following = true;
  let lastTop = 0;
  let lastMaximum = 0;
  return {
    onScroll() {
      const container = containerFor();
      if (container) {
        const maximum = Math.max(0, container.scrollHeight - container.clientHeight);
        // A small upward scroll is intentional even inside the bottom margin.
        // Content growth and delayed programmatic scroll events cannot resume
        // following; only a downward move back to the bottom can do that.
        const layoutClamp = following && maximum < lastMaximum && nearBottom(container);
        if (container.scrollTop < lastTop - 0.5 && !layoutClamp) following = false;
        else if (container.scrollTop > lastTop + 0.5 && nearBottom(container)) following = true;
        lastTop = container.scrollTop;
        lastMaximum = maximum;
      }
      return following;
    },
    pause() { following = false; },
    reset() {
      following = true;
      const container = containerFor();
      lastTop = container?.scrollTop ?? 0;
      lastMaximum = container ? Math.max(0, container.scrollHeight - container.clientHeight) : 0;
    },
    contentChanged() {
      const container = containerFor();
      if (!following || !container) return false;
      lastTop = Math.max(0, container.scrollHeight - container.clientHeight);
      lastMaximum = lastTop;
      container.scrollTo({ top: lastTop, behavior: "instant" });
      return true;
    },
    jump() { following = true; return this.contentChanged(); },
  };
}
