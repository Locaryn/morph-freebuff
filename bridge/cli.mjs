// Outils communs aux adaptateurs : trouver un CLI, le lancer, lire son flux
// JSON ligne par ligne, ouvrir un terminal pour la connexion.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WINDOWS = process.platform === "win32";

/**
 * Le chemin d'un exécutable : d'abord ceux qu'on propose (installation dans
 * le dossier de la passerelle, emplacements habituels), puis le PATH.
 */
export function trouver(nom, candidats = []) {
  for (const c of candidats) {
    if (c && fs.existsSync(c)) return c;
  }
  const exts = WINDOWS ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dossier of (process.env.PATH || "").split(path.delimiter)) {
    if (!dossier) continue;
    for (const ext of exts) {
      const p = path.join(dossier, nom + ext.toLowerCase());
      if (fs.existsSync(p)) return p;
      const P = path.join(dossier, nom + ext);
      if (fs.existsSync(P)) return P;
    }
  }
  return null;
}

/** Lancer un exécutable ; un `.cmd`/`.bat` passe par `cmd`, un `.js` par node. */
export function lancer(exe, args, options = {}) {
  if (exe.endsWith(".js") || exe.endsWith(".mjs")) {
    return spawn(process.execPath, [exe, ...args], { windowsHide: true, ...options });
  }
  if (WINDOWS && /\.(cmd|bat)$/i.test(exe)) {
    return spawn("cmd.exe", ["/d", "/s", "/c", exe, ...args], {
      windowsHide: true,
      ...options,
    });
  }
  return spawn(exe, args, { windowsHide: true, ...options });
}

/** Un dossier de travail vide : le CLI n'y trouve aucun projet à lire. */
export function dossierNeutre(id) {
  const d = path.join(os.tmpdir(), `locaryn-${id}-bridge`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * Lancer le CLI, lui donner `entree` sur stdin, et passer chaque ligne JSON de
 * sa sortie à `surLigne`. Rend la sortie d'erreur à la fin.
 */
export function executerJsonl({ exe, args, entree, cwd, env, signal, surLigne }) {
  return new Promise((resolve, reject) => {
    const enfant = lancer(exe, args, { cwd, env: { ...process.env, ...env } });
    let tampon = "";
    let erreurs = "";
    const surAbandon = () => {
      try {
        enfant.kill();
      } catch {}
      reject(new Error("arrêté"));
    };
    signal?.addEventListener("abort", surAbandon, { once: true });
    enfant.stdout.setEncoding("utf8");
    enfant.stdout.on("data", (d) => {
      tampon += d;
      let i = tampon.indexOf("\n");
      while (i >= 0) {
        const ligne = tampon.slice(0, i).trim();
        tampon = tampon.slice(i + 1);
        if (ligne) {
          try {
            surLigne(JSON.parse(ligne));
          } catch {
            // Une ligne qui n'est pas du JSON : un message du CLI, ignoré.
          }
        }
        i = tampon.indexOf("\n");
      }
    });
    enfant.stderr.setEncoding("utf8");
    enfant.stderr.on("data", (d) => {
      erreurs += d;
      if (erreurs.length > 20000) erreurs = erreurs.slice(-20000);
    });
    enfant.on("error", (e) => reject(e));
    enfant.on("close", (code) => {
      signal?.removeEventListener("abort", surAbandon);
      const reste = tampon.trim();
      if (reste) {
        try {
          surLigne(JSON.parse(reste));
        } catch {}
      }
      resolve({ code, stderr: erreurs });
    });
    if (entree != null) enfant.stdin.end(entree);
    else enfant.stdin.end();
  });
}

/** Lancer une commande courte et rendre sa sortie. */
export function sortieDe(exe, args, { timeoutMs = 15000, cwd } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let enfant;
    try {
      enfant = lancer(exe, args, { cwd });
    } catch (e) {
      resolve({ code: -1, out: "", err: String(e) });
      return;
    }
    const t = setTimeout(() => {
      try {
        enfant.kill();
      } catch {}
    }, timeoutMs);
    enfant.stdout?.on("data", (d) => (out += d));
    enfant.stderr?.on("data", (d) => (err += d));
    enfant.on("error", (e) => {
      clearTimeout(t);
      resolve({ code: -1, out, err: String(e) });
    });
    enfant.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
    enfant.stdin?.end();
  });
}

/**
 * Ouvrir un terminal visible qui lance `exe args` : la connexion à un compte
 * passe par le navigateur et demande parfois de taper quelque chose.
 */
export function ouvrirTerminal(titre, exe, args) {
  const ligne = [exe, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
  if (WINDOWS) {
    spawn("cmd.exe", ["/c", "start", `"${titre}"`, "cmd.exe", "/k", ligne], {
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: true,
    }).unref();
    return;
  }
  if (process.platform === "darwin") {
    spawn("osascript", ["-e", `tell application "Terminal" to do script "${ligne.replace(/"/g, '\\"')}"`], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return;
  }
  for (const t of ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]) {
    try {
      spawn(t, t === "gnome-terminal" ? ["--", "sh", "-c", ligne] : ["-e", ligne], {
        detached: true,
        stdio: "ignore",
      }).unref();
      return;
    } catch {}
  }
}

/** Libellé d'une fenêtre de quota d'après sa durée en minutes. */
export function libelleFenetre(minutes, id) {
  if (id === "five_hour" || minutes === 300) return "5 heures";
  if (id === "seven_day" || minutes === 10080) return "7 jours";
  if (id === "seven_day_opus") return "7 jours (Opus)";
  if (id === "seven_day_sonnet") return "7 jours (Sonnet)";
  if (typeof minutes === "number" && minutes > 0) {
    if (minutes % 1440 === 0) return `${minutes / 1440} jours`;
    if (minutes % 60 === 0) return `${minutes / 60} heures`;
    return `${minutes} min`;
  }
  return id ?? "Limite";
}

/** Une date de remise à zéro, quelle que soit sa forme (secondes, ISO…). */
export function dateDe(v, base = Date.now()) {
  if (v == null) return null;
  if (typeof v === "number") {
    // Secondes depuis l'époque, ou délai en secondes s'il est petit.
    const ms = v > 1e12 ? v : v > 1e9 ? v * 1000 : base + v * 1000;
    return new Date(ms).toISOString();
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
