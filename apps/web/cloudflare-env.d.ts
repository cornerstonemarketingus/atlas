// Keep Worker binding types scoped: global Worker types conflict with the
// browser DOM types used by the React application.
type D1Database = import("@cloudflare/workers-types").D1Database;
type Fetcher = { fetch(request: Request): Promise<Response> };
declare module "cloudflare:workers" {
  export const env: {
    DB?: import("@cloudflare/workers-types").D1Database;
  };
}
