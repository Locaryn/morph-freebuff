// Freebuff : la version gratuite de Codebuff.
//
// À ce jour, le CLI `freebuff` est uniquement interactif : ni `--print`, ni
// sortie JSON, et une entrée par tuyau attend un terminal
// (github.com/CodebuffAI/freebuff/issues/947). Ce pont détecte à chaque
// démarrage si la version installée a gagné un mode non interactif ; tant que
// ce n'est pas le cas, le dossier le dit clairement plutôt que de faire
// semblant. La connexion au compte, elle, fonctionne déjà (`freebuff login`).

import path from "node:path";
import {
  dossierNeutre,
  executerJsonl,
  ouvrirTerminal,
  sortieDe,
  trouver,
} from "./cli.mjs";

const GATEWAY = process.env.BRIDGE_GATEWAY_DIR || "";

function exe() {
  return trouver("freebuff", [
    process.env.FREEBUFF_CLI_PATH,
    GATEWAY && path.join(GATEWAY, "node_modules", "freebuff", "index.js"),
  ]);
}

/** Les options que la version installée accepte, lues dans son aide. */
let capacites = null;
async function lireCapacites() {
  if (capacites) return capacites;
  const e = exe();
  if (!e) return { print: false, json: false };
  const r = await sortieDe(e, ["--help"], { timeoutMs: 15000 });
  const aide = `${r.out}\n${r.err}`;
  capacites = {
    print: /(^|\s)(-p|--print)\b/.test(aide),
    json: /--output-format|--json\b/.test(aide),
  };
  return capacites;
}

const PAS_ENCORE =
  "Freebuff ne propose pas encore de mode non interactif : le pont ne peut pas lui transmettre une " +
  "conversation. Suivez github.com/CodebuffAI/freebuff/issues/947 — dès qu'une version l'ajoute, " +
  "ce dossier l'utilisera sans mise à jour du morph.";

export default {
  id: "freebuff",
  label: "Freebuff",
  defaultPort: 20133,
  defaultContext: 200000,

  async models() {
    const c = await lireCapacites();
    return c.print
      ? [{ id: "freebuff", name: "Freebuff (gratuit)", context_length: 200000, description: "Le modèle choisi par Freebuff" }]
      : [];
  },

  async status() {
    const e = exe();
    if (!e) {
      return {
        installed: false,
        logged_in: false,
        detail: "Freebuff n'est pas installé. Locaryn peut l'installer depuis ce dossier (npm freebuff).",
      };
    }
    const c = await lireCapacites();
    return {
      installed: true,
      logged_in: null,
      headless: c.print,
      detail: c.print ? "Prêt." : PAS_ENCORE,
    };
  },

  async login() {
    const e = exe();
    if (!e) return { ok: false, detail: "Freebuff n'est pas installé." };
    ouvrirTerminal("Freebuff — connexion", e, ["login"]);
    return { ok: true, detail: "Une fenêtre s'est ouverte : terminez la connexion, puis revenez ici." };
  },

  async logout() {
    return { ok: false, detail: "Déconnectez-vous depuis Freebuff lui-même (commande /logout)." };
  },

  async usage() {
    // Freebuff est gratuit (financé par la publicité) : pas de quota publié.
    return { windows: [], note: null };
  },

  async run({ system, prompt, signal, onDelta }) {
    const e = exe();
    if (!e) throw new Error("Freebuff n'est pas installé.");
    const c = await lireCapacites();
    if (!c.print) throw new Error(PAS_ENCORE);
    const dir = dossierNeutre("freebuff");
    let texte = "";
    const args = ["--print"];
    if (c.json) args.push("--output-format", "stream-json");
    const r = await executerJsonl({
      exe: e,
      args,
      entree: [system, prompt].filter(Boolean).join("\n\n"),
      cwd: dir,
      signal,
      surLigne: (ev) => {
        const t = ev.text ?? ev.delta ?? ev.content ?? "";
        if (typeof t === "string" && t) {
          texte += t;
          onDelta(t);
        }
      },
    });
    if (!texte && r.code !== 0) throw new Error(r.stderr.trim() || `Freebuff s'est arrêté (code ${r.code}).`);
    return { text: texte, usage: null };
  },
};

