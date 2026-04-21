/**
 * Content negotiation helpers for epistery-scan.
 *
 * Detects bots/agents and JSON preference so the same URL can serve
 * HTML to browsers and JSON to AI agents and CLI tools.
 */

const BOT_PATTERN = /GPTBot|ClaudeBot|Anthropic|GoogleBot|BingBot|PerplexityBot|curl|wget|python-requests|node-fetch|axios/i;

/**
 * True when the request comes from a known bot or CLI tool.
 */
export function isBot(req) {
  const ua = req.get('user-agent') || '';
  return BOT_PATTERN.test(ua);
}

/**
 * True when the client explicitly asks for JSON, or is a bot.
 */
export function wantsJson(req) {
  const accept = req.get('accept') || '';
  if (accept.includes('application/json')) return true;
  return isBot(req);
}
