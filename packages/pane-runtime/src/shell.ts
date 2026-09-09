/**
 * Shell quoting, defined once in the contract.
 *
 * It used to live here, and the plugin test host had a second copy. Two
 * spellings of an escaping rule diverge silently: a plugin's test asserts the
 * old form and passes while the shipped command line differs.
 */
export { shellQuote } from "@subshell-ai/plugin-api";
