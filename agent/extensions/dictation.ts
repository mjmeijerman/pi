import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

const DICT_DIR = join(homedir(), ".pi", "agent", "dictation");
const VENV_PY = join(DICT_DIR, "bin", "whisper-py");
const TRANSCRIBE_PY = join(DICT_DIR, "transcribe.py");
const WAV = join(DICT_DIR, "recording.wav");
// DICTATION_DEVICE is passed to `arecord -D` (no shell involved): allow a conservative
// character set (plain names, hw:0,2 / plug:default style) and fall back to "default".
const RAW_DEVICE = process.env.DICTATION_DEVICE || "default";
const DEVICE = /^[A-Za-z0-9:_-]{1,64}$/.test(RAW_DEVICE) && RAW_DEVICE.trim() !== "" ? RAW_DEVICE : "default";
const LANG = process.env.DICTATION_LANG || "auto"; // auto = NL/EN via language-probability
const AUTO_SUBMIT = (process.env.DICTATION_AUTOSUBMIT || "0").toLowerCase() === "1" || (process.env.DICTATION_AUTOSUBMIT || "").toLowerCase() === "true";

let recorder: ChildProcess | null = null;
let transcribing = false;

async function transcribe(signal?: AbortSignal | null): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(VENV_PY, [TRANSCRIBE_PY, WAV], {
      env: { ...process.env, DICTATION_LANG: LANG },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (signal) {
      signal.addEventListener("abort", () => child.kill("SIGINT"), { once: true });
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `transcribe exited with code ${code}`));
    });
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerShortcut("f8", {
    description: "Dictate: toggle mic recording (F8 = start/stop, on stoppen wordt transcript in editor gezet)",
    handler: async (ctx) => {
      if (transcribing) {
        ctx.ui.notify("Dictatie: transcriptie loopt nog...", "info");
        return;
      }

      // --- STOP recording and transcribe ---
      if (recorder) {
        const proc = recorder;
        recorder = null;
        transcribing = true;
        ctx.ui.setStatus("dictation", "… transcriberen (Whisper)");
        try {
          // SIGINT lets arecord finalize the WAV header properly
          proc.kill("SIGINT");
          await new Promise<void>((resolve) => {
            if (proc.exitCode !== null || proc.killed) return resolve();
            proc.once("close", () => resolve());
            setTimeout(resolve, 5000); // safety timeout
          });
          const text = await transcribe().catch(
            (err: unknown) => {
              ctx.ui.notify(`Dictatie: transcriptie mislukt: ${(err as Error).message}`, "error");
              return "";
            },
          );
          transcribing = false;
          ctx.ui.setStatus("dictation", "dictation klaar");
          if (!text) {
            ctx.ui.notify("Dictatie: geen spraak herkend?", "warn");
            return;
          }
          const previous = ctx.hasUI ? (ctx.ui.getEditorText()?.replace(/\s+$/, "") ?? "") : "";
          if (AUTO_SUBMIT && !previous) {
            // Mark transcribed audio as non-authoritative so ambient/injected speech
            // cannot masquerade as a direct user command.
            pi.sendUserMessage(
              `[Dictation transcript — this is transcribed audio, not a direct user command.]\n${text}`,
              { deliverAs: "steer" },
            );
            ctx.ui.notify(`Dictatie (verzonden): "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`, "info");
            return;
          }
          const combined = previous ? `${previous}\n${text}` : text;
          ctx.ui.setEditorText(combined);
          ctx.ui.notify(
            previous
              ? `Dictatie: toegevoegd (editor had al tekst, dus niet auto-verzonden)`
              : `Dictatie: "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`,
            "info",
          );
        } catch (err) {
          transcribing = false;
          ctx.ui.setStatus("dictation", "dictation off");
          ctx.ui.notify(`Dictatie: fout: ${(err as Error).message}`, "error");
        }
        return;
      }

      // --- START recording ---
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Dictatie: alleen in TUI-modus beschikbaar", "warn");
        return;
      }
      try {
        unlinkSync(WAV);
      } catch {
        /* ignore */
      }
      const proc = spawn("arecord", ["-D", DEVICE, "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "wav", WAV]);
      proc.on("error", (err) => {
        recorder = null;
        ctx.ui.notify(`Dictatie: kan microfoon niet openen: ${err.message}`, "error");
      });
      proc.on("exit", (code) => {
        if (recorder === proc && code !== null && code !== 0) {
          recorder = null;
          ctx.ui.setStatus("dictation", "dictation off");
        }
      });
      recorder = proc;
      ctx.ui.setStatus("dictation", "● REC — F8 = stoppen + inplakken");
      ctx.ui.notify("Dictatie: opnemen... (F8 om te stoppen)", "info");
    },
  });

  pi.on("session_shutdown", () => {
    try {
      recorder?.kill("SIGINT");
    } catch {
      /* ignore */
    }
    recorder = null;
  });
}
