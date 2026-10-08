// Keep Worker bindings scoped to their runtime module. Loading the Worker
// globals into this mixed browser/server project overrides DOM fetch types.
declare module "cloudflare:workers" {
  const env: { DB?: import("@cloudflare/workers-types/index").D1Database };
  export { env };
}
