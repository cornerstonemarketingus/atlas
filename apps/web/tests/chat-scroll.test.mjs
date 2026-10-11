import assert from "node:assert/strict";
import test from "node:test";
import { createScrollFollow, nearBottom } from "../app/chat/scroll-follow.mjs";

function fixture() {
  const calls = [];
  const container = { scrollHeight: 1000, clientHeight: 300, scrollTop: 0,
    scrollTo(options) { calls.push(options); this.scrollTop = options.top; } };
  return { container, calls, follow: createScrollFollow(() => container) };
}

test("constructing the controller does not read an unmounted DOM ref", () => {
  let mounted = false;
  const follow = createScrollFollow(() => {
    assert.equal(mounted, true);
    return null;
  });
  mounted = true;
  assert.equal(follow.contentChanged(), false);
});

test("initial positioning and streamed growth follow the actual container", () => {
  const { container, calls, follow } = fixture();
  follow.contentChanged();
  assert.equal(container.scrollTop, 700);
  assert.equal(follow.onScroll(), true);
  container.scrollHeight = 1300;
  follow.contentChanged();
  assert.equal(container.scrollTop, 1000);
  assert.equal(calls.length, 2);
});

test("scrolling upward locks history throughout streaming and completion", () => {
  const { container, calls, follow } = fixture();
  follow.contentChanged();
  container.scrollTop = 200;
  assert.equal(follow.onScroll(), false);
  for (let token = 0; token < 50; token++) { container.scrollHeight += 10; follow.contentChanged(); }
  follow.contentChanged();
  assert.equal(container.scrollTop, 200);
  assert.equal(calls.length, 1);
  container.scrollTop = container.scrollHeight - container.clientHeight - 0.5;
  assert.equal(follow.onScroll(), true);
  follow.contentChanged();
  assert.equal(container.scrollTop, 1200);
});

test("sending, changing threads, starting new and Jump to latest restore following", () => {
  for (const action of ["send", "thread", "new", "jump"]) {
    const { container, follow } = fixture();
    follow.pause();
    container.scrollHeight = 2000;
    if (action === "jump") follow.jump();
    else { follow.reset(); follow.contentChanged(); }
    assert.equal(container.scrollTop, 1700, action);
    assert.equal(follow.onScroll(), true);
  }
});

test("bottom threshold tolerates fractional layout and short content", () => {
  assert.equal(nearBottom({ scrollHeight: 1000, scrollTop: 699.5, clientHeight: 300 }), true);
  assert.equal(nearBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 300 }), false);
  assert.equal(nearBottom({ scrollHeight: 200, scrollTop: 0, clientHeight: 300 }), true);
});

test("small upward scrolls pause even inside the bottom margin", () => {
  const { container, follow } = fixture();
  follow.contentChanged();
  container.scrollTop -= 20;
  assert.equal(follow.onScroll(), false);
  container.scrollHeight += 200;
  assert.equal(follow.contentChanged(), false);
  assert.equal(container.scrollTop, 680);
});

test("a delayed unchanged scroll event cannot resume an explicitly paused reader", () => {
  const { container, follow } = fixture();
  follow.contentChanged();
  follow.pause();
  assert.equal(follow.onScroll(), false);
  assert.equal(follow.contentChanged(), false);
  container.scrollTop -= 100;
  follow.onScroll();
  container.scrollTop = 700;
  assert.equal(follow.onScroll(), true);
});

test("a viewport growing after Jump cannot misclassify its bottom clamp as scrolling upward", () => {
  const { container, follow } = fixture();
  follow.jump();
  container.clientHeight += 40;
  container.scrollTop = container.scrollHeight - container.clientHeight;
  assert.equal(follow.onScroll(), true);
  container.scrollHeight += 200;
  assert.equal(follow.contentChanged(), true);
  assert.equal(container.scrollTop, 860);
});

test("browser scroll anchoring above the bottom cannot resume a paused reader", () => {
  const { container, follow } = fixture();
  follow.contentChanged();
  container.scrollTop -= 20;
  assert.equal(follow.onScroll(), false);
  // A tool inserted above the visible text shifts the browser's anchor.
  container.scrollHeight += 30;
  container.scrollTop += 30;
  assert.equal(follow.onScroll(), false);
  assert.equal(follow.contentChanged(), false);
});

test("a shorter thread cannot mistake its first scrollbar movement for an old layout clamp", () => {
  const { container, follow } = fixture();
  follow.contentChanged();
  container.scrollHeight = 500;
  container.scrollTop = 200;
  follow.reset();
  container.scrollTop -= 1;
  assert.equal(follow.onScroll(), false);
  container.scrollHeight += 100;
  assert.equal(follow.contentChanged(), false);
});
