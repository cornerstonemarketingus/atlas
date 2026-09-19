import { randomBytes } from "node:crypto";

import { assertReachableEndpoint, ModelRequestError } from "./model-client.mjs";

/**
 * Speech-to-text against a configurable OpenAI-compatible transcription
 * endpoint.
 *
 * The default is loopback, so dictation works with a local whisper server and
 * the audio never leaves the machine. An operator who points this at a hosted
 * service is making that choice explicitly, and the endpoint must then be
 * HTTPS.
 */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const ACCEPTED = new Map([
  ["audio/webm", "webm"],
  ["audio/ogg", "ogg"],
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
  ["audio/mpeg", "mp3"],
  ["audio/mp4", "mp4"],
  ["audio/m4a", "m4a"],
  ["audio/flac", "flac"],
]);

export function createSpeechTranscriber({
  baseUrl = process.env.ATLAS_SPEECH_ENDPOINT || "http://127.0.0.1:8080/v1",
  model = process.env.ATLAS_SPEECH_MODEL || "whisper-1",
  apiKeyEnv = "ATLAS_SPEECH_API_KEY",
  fetchImpl = fetch,
  timeoutMs = 120_000,
} = {}) {
  const endpoint = assertReachableEndpoint(baseUrl);

  return {
    endpoint: endpoint.origin,
    model,

    async transcribe({ audio, mediaType, signal }) {
      const extension = ACCEPTED.get(String(mediaType).split(";")[0].trim().toLowerCase());
      if (!extension) throw new ModelRequestError("UNSUPPORTED_AUDIO", `Audio type '${mediaType}' is not accepted.`);
      if (!Buffer.isBuffer(audio) || audio.length === 0) throw new ModelRequestError("EMPTY_AUDIO", "No audio was supplied.");
      if (audio.length > MAX_AUDIO_BYTES) throw new ModelRequestError("AUDIO_TOO_LARGE", `Audio must be at most ${MAX_AUDIO_BYTES} bytes.`);

      // Multipart is assembled by hand rather than with FormData so the audio
      // buffer is never copied through an intermediate string encoding.
      const boundary = `atlas${randomBytes(16).toString("hex")}`;
      const body = multipart(boundary, [
        { name: "model", value: model },
        { name: "response_format", value: "json" },
        { name: "file", filename: `speech.${extension}`, contentType: mediaType, value: audio },
      ]);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      signal?.addEventListener("abort", () => controller.abort(), { once: true });
      try {
        const apiKey = process.env[apiKeyEnv];
        const response = await fetchImpl(new URL("audio/transcriptions", endpoint), {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": `multipart/form-data; boundary=${boundary}`,
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body,
        });
        if (!response.ok) {
          throw new ModelRequestError(
            response.status === 401 || response.status === 403 ? "SPEECH_NOT_AUTHORIZED" : "SPEECH_REQUEST_FAILED",
            `The transcription endpoint returned HTTP ${response.status}.`,
          );
        }
        const payload = await response.json();
        const text = typeof payload?.text === "string" ? payload.text.trim() : "";
        if (!text) throw new ModelRequestError("EMPTY_TRANSCRIPT", "The transcription endpoint returned no text.");
        return { text };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function multipart(boundary, fields) {
  const chunks = [];
  for (const field of fields) {
    const headers = field.filename
      ? `content-disposition: form-data; name="${field.name}"; filename="${field.filename}"\r\ncontent-type: ${field.contentType}\r\n`
      : `content-disposition: form-data; name="${field.name}"\r\n`;
    chunks.push(Buffer.from(`--${boundary}\r\n${headers}\r\n`, "utf8"));
    chunks.push(Buffer.isBuffer(field.value) ? field.value : Buffer.from(String(field.value), "utf8"));
    chunks.push(Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return Buffer.concat(chunks);
}
