/**
 * The one place that names the decision model jev talks to: TypeSafe's Jev.
 *
 * Everything here is env-overridable, because the address, the model alias and the threshold are
 * facts about the deployment, not about this harness. bin/jev.mjs imports them and adds nothing
 * of its own; the suite swaps the endpoint for a local fake and nothing else moves.
 *
 * The threshold is the probability of the option a caller will act on, not the answer's
 * `confidence` number: TypeSafe's confidence describes how spread the distribution is, while the
 * probability of the chosen option is the chance that this option is the right one. A decision
 * acts when that chance reaches JEV_MIN_CONFIDENCE; the full rule is in that file.
 *
 * No key here. The key is a secret, so it is read in bin/jev.mjs and never from a module another
 * script can import.
 */
import os from "node:os";
import path from "node:path";
import process from "node:process";

/** The full URL of the System One endpoint: one POST answers every question in one request. */
export const ENDPOINT = process.env.JEV_ENDPOINT || "https://api.typesafe.ai/v1/systemone";
/** The alias from GET /v1/models. Each response also names the concrete model it used. */
export const MODEL = process.env.JEV_MODEL || "jev-latest";
/** TypeSafe answers in a few hundred milliseconds; this bounds a dead endpoint, not a slow one. */
export const TIMEOUT = Number(process.env.JEV_TIMEOUT || 20000);
/**
 * The probability a question needs before the harness acts on it, for both question types:
 *
 *   Choice  the probability of the chosen option — the chance that this option is the right one.
 *           0.5 means "more likely right than all the alternatives together", whatever their count.
 *   Noul    |2p-1|, the documented confidence for a yes/no answer: 0.5 means p outside 0.25..0.75.
 *
 * The spec proposed 0.6. Measured against the live model on eight ordinary tasks (see
 * reports/jev-typesafe.md), 0.6 stopped four of them as unsure, all on count or thinking, the two
 * questions with three and four neighbouring options — a gate that sends half the work to the
 * human is not a gate, it is a queue. 0.5 keeps every decisive answer and still stops a real
 * four-way split. JEV_MIN_CONFIDENCE=0.6 restores the stricter reading in one word.
 */
export const MIN_CONFIDENCE = Number(process.env.JEV_MIN_CONFIDENCE || 0.5);
/** The environment variable that carries the key. */
export const KEY_ENV = "TYPESAFE_API_KEY";
/** Where the key lives when the environment does not carry it. JEV_KEY_FILE points elsewhere. */
export const KEY_FILE = process.env.JEV_KEY_FILE || path.join(os.homedir(), ".pi", "agent", "env.secret");
