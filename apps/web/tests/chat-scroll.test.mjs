import assert from "node:assert/strict";
import test from "node:test";
import { createScrollFollow, nearBottom } from "../app/chat/scroll-follow.mjs";

function fixture() {
  const calls = [];
  const container = { scrollHeight: 1000, clientHeight: 300, scrollTop: 0,
    scrollTo(options) { calls.push(options); this.scrollTop = options.top; } };
  return { container, calls, follow: createScrollFollow(() => container) };
}

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
  container.scrollTop = container.scrollHeight - container.clientHeight - 40;
  assert.equal(follow.onScroll(), true);
  follow.contentChanged();
  assert.equal(container.scrollTop, 1200);
});

test("sending, changing threads, starting new and Jump to latest restore following", () => {
  for (const action of ["send", "thread", "new", "jump"]) {
    const { container, follow } = fixture();
    follow.onScroll();
    container.scrollHeight = 2000;
    if (action === "jump") follow.jump();
    else { follow.reset(); follow.contentChanged(); }
    assert.equal(container.scrollTop, 1700, action);
    assert.equal(follow.onScroll(), true);
  }
});

test("bottom threshold tolerates fractional layout and short content", () => {
  assert.equal(nearBottom({ scrollHeight: 1000, scrollTop: 620.5, clientHeight: 300 }), true);
  assert.equal(nearBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 300 }), false);
  assert.equal(nearBottom({ scrollHeight: 200, scrollTop: 0, clientHeight: 300 }), true);
});
