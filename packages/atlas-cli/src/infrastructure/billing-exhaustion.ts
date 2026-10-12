/**
 * OpenAI and Anthropic both answer billing/quota exhaustion with wording
 * that is distinguishable from a transient rate limit or a capacity error,
 * but it rides on the same HTTP status their rate limits use (429 for
 * OpenAI/Groq-shaped APIs, sometimes 400 for Anthropic's credit-balance
 * check). Retrying that error on any schedule cannot succeed until the
 * account is funded or a budget raised, so it has to be told apart from an
 * error that really will clear on its own: retrying it wastes the retry
 * budget on an account that will not change in a second, a minute, or a day.
 *
 * This mirrors apps/web/app/api/chat/agent-loop.mjs's isBillingExhausted so
 * hosted chat and the coder classify the same failure the same way. The
 * pattern is deliberately narrow so it does not match Groq's "Rate limit
 * reached on tokens per day (TPD)" daily-quota wording, which is a real rate
 * limit (today's allowance resets tomorrow), not billing exhaustion.
 */
const BILLING_EXHAUSTED_PATTERN =
  /\binsufficient_quota\b|\bbilling_hard_limit_reached\b|exceeded your current quota|check your plan and billing|credit balance is too low|purchase credits/iu;

export function isBillingExhausted(body: string): boolean {
  return BILLING_EXHAUSTED_PATTERN.test(body);
}
