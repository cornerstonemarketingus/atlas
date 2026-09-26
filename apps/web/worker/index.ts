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

type HTMLRewriterElement = {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
};

type HTMLRewriterInstance = {
  on(
    selector: string,
    handlers: { element(element: HTMLRewriterElement): void },
  ): { transform(response: Response): Response };
};

function responseWithoutContentLength(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
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

    const HTMLRewriterCtor = (globalThis as {
      HTMLRewriter?: new () => HTMLRewriterInstance;
    }).HTMLRewriter;
    if (HTMLRewriterCtor) {
      const streamed = new HTMLRewriterCtor().on("script", {
        element(element) {
          if (!element.getAttribute("nonce")) element.setAttribute("nonce", scriptNonce);
        },
      }).transform(responseWithoutContentLength(response));
      return withSecurityHeaders(streamed, { scriptNonce });
    }

    const html = await response.text();
    const scriptNonceHtml = html.replace(/<script(?=[\s>])(?![^>]*\bnonce=)/giu, `<script nonce="${scriptNonce}"`);
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return withSecurityHeaders(new Response(scriptNonceHtml, { status: response.status, statusText: response.statusText, headers }), { scriptNonce });
  },
};

export default worker;
