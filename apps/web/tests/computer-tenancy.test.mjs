import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The computer routes query through Drizzle against D1, which this suite does
// not run. This guard keeps them honest statically: every user-facing route
// that reads or writes devices or approvals must scope by tenant_id as well
// as by the requesting user, and the companion must stamp new approvals with
// its device's workspace.
const read = (path) => readFileSync(new URL(`../app/api/computer/${path}`, import.meta.url), "utf8");

const userRoutes = ["devices/route.ts", "devices/[id]/route.ts", "approvals/[id]/route.ts", "tasks/route.ts"];

for (const path of userRoutes) {
  test(`${path} resolves the caller's workspace and scopes by it`, () => {
    const source = read(path);
    assert.match(source, /computerTenant\(request, account\)/u);
    assert.match(source, /if \(tenant instanceof Response\) return tenant;/u);
    assert.match(source, /tenantId, tenant\.tenantId|tenantId: tenant\.tenantId/u);
  });
}

test("devices are created inside the caller's workspace", () => {
  assert.match(read("devices/route.ts"), /values\(\{ id, tenantId: tenant\.tenantId,/u);
});

test("tasks are listed only for devices in the caller's workspace", () => {
  const source = read("tasks/route.ts");
  assert.match(source, /eq\(computerDevices\.tenantId, tenant\.tenantId\)/u);
  assert.match(source, /inArray\(computerTasks\.deviceId, deviceIds\)/u);
});

test("the companion stamps approvals with its device's workspace", () => {
  assert.match(read("companion/approval/route.ts"), /tenantId: device\.tenantId/u);
});
