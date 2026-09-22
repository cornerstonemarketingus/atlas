import assert from "node:assert/strict";
import test from "node:test";

import { protectedRepositories, selfModificationDecision } from "../app/api/tasks/self-protection.mjs";

test("only the deployment owner can dispatch coder work against Atlas itself", () => {
  const task = { repository: "cornerstonemarketingus/atlas", mode: "coder" };
  assert.equal(selfModificationDecision({ userId: "operator" }, task).allowed, true);
  const customer = selfModificationDecision({ userId: "github:customer" }, task);
  assert.equal(customer.allowed, false);
  assert.equal(customer.status, 403);
  assert.match(customer.reason, /deployment owner/u);
});

test("subscriptions never imply owner authority and non-self work is unaffected", () => {
  const proCustomer = { userId: "github:pro-customer", dbUserId: 42, tier: "team" };
  assert.equal(selfModificationDecision(proCustomer, { repository: "cornerstonemarketingus/atlas", mode: "coder" }).allowed, false);
  assert.equal(selfModificationDecision(proCustomer, { repository: "customer/product", mode: "coder" }).allowed, true);
  assert.equal(selfModificationDecision(proCustomer, { repository: "cornerstonemarketingus/atlas", mode: "inspect" }).allowed, true);
});

test("the protected repository set is explicit and configurable", () => {
  assert.deepEqual([...protectedRepositories()], ["cornerstonemarketingus/atlas"]);
  assert.deepEqual([...protectedRepositories("Owner/One, owner/two")], ["owner/one", "owner/two"]);
});
