/**
 * The query handlers, in the order they answer. Each reads the intent
 * (Intent.mjs) and claims the targets it reports on:
 *
 *   { kind, describe, available?(scan), targets(intent, scan), run(target, scan, out, limit), example(scan) }
 *
 * A new kind of search is a new handler here — the pipeline (handlers/Search.mjs)
 * and the guide (Guide.mjs) pick it up from this list and nowhere else.
 */
import ServiceQuery from './ServiceQuery.mjs';
import AddressQuery from './AddressQuery.mjs';
import DomainQuery from './DomainQuery.mjs';
import TextQuery from './TextQuery.mjs';

export const QUERY_HANDLERS = [ServiceQuery, AddressQuery, DomainQuery, TextQuery];
