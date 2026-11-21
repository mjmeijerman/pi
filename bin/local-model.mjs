/**
 * The one place that names the local model bin/local-run talks to: qwen on ollama.
 *
 * It used to share this file with bin/jev.mjs. It cannot any more: jev is a remote decision model
 * now, and local-run is still a local chat model that needs no network. Two transports, two
 * homes, and the names stay separate so an override for one can never move the other.
 *
 * LOCAL_* rather than JEV_*: JEV_ENDPOINT now means the TypeSafe endpoint, and a script that set
 * it to an ollama address would be pointing the decision model at a chat model.
 */
import process from "node:process";

export const MODEL = process.env.LOCAL_MODEL || "qwen3.8:27b";
export const ENDPOINT = process.env.LOCAL_ENDPOINT || "http://localhost:11434/api/chat";
export const TIMEOUT = Number(process.env.LOCAL_TIMEOUT || 180000);
// How long ollama keeps the model loaded after a call. Ollama's default is 5 minutes, so a local
// task more than 5 minutes after the last one pays the model load again. 30m covers a session.
export const KEEP_ALIVE = process.env.LOCAL_KEEP_ALIVE || "30m";
