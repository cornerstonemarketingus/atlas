# Ollama coding qualification — 2026-10-24

The installed local Atlas checkout was updated from e37b7b2 to 6fa07a0, reconciling the merged explicit local-provider, native Ollama, baseline evidence and tamper-proof acceptance changes. The original C:/Users/jmhl3/atlas checkout and its uncommitted work were preserved.

The smallest local Qwen model did not qualify: it described an arithmetic fix without editing. The installed beam:cloud model did qualify through Ollama's native API. This model is hosted by Ollama Cloud; it does not run on this PC.

The live Models-page plan now selects beam:cloud with a 16384-token context for coding and retains qwen3:0.6b with an 8192-token context as the fast local model. The authenticated running daemon GET /v1/models confirmed default=beam:cloud and defaultInstalled=true. No Groq route or automatic paid fallback was added to the isolated local coder.

Two real synthetic repository checks passed:

- Explicit beam:cloud: 30 seconds; arithmetic implementation corrected; repository test and hidden check passed; patch applies; original checkout unchanged.
- Saved default, without --model: 54 seconds; same independent checks passed; 3 model turns, 2 tool calls, 1 implementation file changed; verification=verified.

These receipts qualify a bounded arithmetic edit, not arbitrary autonomous projects. Operator logs remain outside source control under C:/Users/jmhl3/atlas/.review/ollama-*-qualification-20261024.log. The small-model failure remains recorded separately.

The route regression checks exposed two test-maintenance issues: Git may check out CRLF on Windows, and the strengthened acceptance script now reports missing patches plus original/hidden check failures instead of its old file-unchanged message. Tests now compare source across platform newlines and assert the stronger failure evidence.
