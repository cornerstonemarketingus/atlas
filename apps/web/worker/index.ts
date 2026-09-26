/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { createScriptNonce, withSecurityHeaders } from "./security-headers.mjs";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const scriptNonce = createScriptNonce();

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return withSecurityHeaders(await handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths));
    }

    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-atlas-script-nonce", scriptNonce);
    const renderRequest = new Request(request, { headers: requestHeaders });
    const response = await handler.fetch(renderRequest, env, ctx);
    const contentType = response.headers.get("content-type") ?? "";

    if (!contentType.includes("text/html")) return withSecurityHeaders(response);

    const html = await response.text();
    const scriptNonceHtml = html.replace(/<script(?=[\s>])(?![^>]*\bnonce=)/giu, `<script nonce="${scriptNonce}"`);
    return withSecurityHeaders(new Response(scriptNonceHtml, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }), { scriptNonce });
  },
};

export default worker;
