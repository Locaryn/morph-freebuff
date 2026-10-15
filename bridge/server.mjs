// Pont local entre Locaryn et un assistant en ligne de commande (Claude Code,
// Codex, Freebuff).
//
// Locaryn parle le dialecte OpenAI (`/v1/models`, `/v1/chat/completions`) ;
// les CLI officiels, eux, s'utilisent avec le compte de la personne (son
// abonnement Claude, ChatGPT…). Ce serveur fait la traduction, sur la boucle
// locale uniquement :
//
// - la conversation est rendue en un texte que le CLI lit sur son entrée ;
// - les outils de Locaryn sont décrits au modèle, qui les appelle par des blocs
//   <tool_call>{…}</tool_call> — le pont les rend à Locaryn comme de vrais
//   `tool_calls`. Les outils propres du CLI sont coupés : c'est Locaryn qui
//   lit, écrit et exécute, avec ses permissions ;
// - `/v1/usage` publie les limites de l'abonnement (fenêtre de 5 h, semaine)
//   pour la jauge du chat ; `/props` publie la fenêtre de contexte ;
// - `/auth/status|login|logout` gèrent la connexion du compte.
//
// Aucune dépendance : Node 18+ suffit. Le comportement propre à chaque CLI vit
// dans `adapter.mjs`, à côté.

import http from "node:http";
import { randomUUID } from "node:crypto";
import adapter from "./adapter.mjs";

const PORT = Number(process.env.PORT || adapter.defaultPort);
const HOST = "127.0.0.1";

/** La dernière fenêtre de contexte annoncée, pour `/props`. */
let contexte = adapter.defaultContext ?? 200000;

function json(res, code, obj) {
  const corps = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(corps),
  });
  res.end(corps);
}

function erreur(res, code, message) {
  json(res, code, { error: { message, type: "bridge_error" } });
}

function lireCorps(req) {
  return new Promise((resolve, reject) => {
    const morceaux = [];
    req.on("data", (c) => morceaux.push(c));
    req.on("end", () => {
      try {
        const brut = Buffer.concat(morceaux).toString("utf8");
        resolve(brut ? JSON.parse(brut) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function texteDe(contenu) {
  if (contenu == null) return "";
  if (typeof contenu === "string") return contenu;
  if (Array.isArray(contenu)) {
    return contenu
      .map((p) => {
        if (typeof p === "string") return p;
        if (p?.type === "text") return p.text ?? "";
        if (p?.type === "image_url") return "[image jointe — non transmise par ce pont]";
        return "";
      })
      .join("\n");
  }
  return String(contenu);
}

function analyser(texte) {
  try {
    return JSON.parse(texte);
  } catch {
    return texte;
  }
}

/** Le mode d'emploi des outils, ajouté à la consigne système. */
function protocoleOutils(outils) {
  if (!Array.isArray(outils) || outils.length === 0) return "";
  const liste = outils
    .map((t) => {
      const f = t.function ?? t;
      return `- ${f.name}: ${(f.description ?? "").trim()}\n  arguments (JSON Schema): ${JSON.stringify(f.parameters ?? {})}`;
    })
    .join("\n");
  return [
    "",
    "# Tools",
    "You are connected to tools that run on the user's machine through Locaryn.",
    "To call a tool, write exactly one block per call, and nothing after the last block:",
    '<tool_call>{"name": "TOOL_NAME", "arguments": {"key": "value"}}</tool_call>',
    "You may write several blocks in a row. Then stop: the results come back in <tool_result> blocks in the next message. Never invent a result.",
    "When no tool is needed, answer normally without any block.",
    "Your own built-in tools are disabled here: use only the tools listed below.",
    "",
    "Available tools:",
    liste,
  ].join("\n");
}

/** La conversation, rendue en une consigne système et un texte d'entrée. */
export function rendre(messages, outils) {
  const systeme = [
    messages
      .filter((m) => m.role === "system" || m.role === "developer")
      .map((m) => texteDe(m.content))
      .join("\n\n"),
    protocoleOutils(outils),
  ]
    .filter((s) => s.trim())
    .join("\n");
  const reste = messages.filter((m) => m.role !== "system" && m.role !== "developer");
  if (reste.length === 1 && reste[0].role === "user") {
    return { systeme, entree: texteDe(reste[0].content) };
  }
  const blocs = reste.map((m) => {
    if (m.role === "user") return `<user>\n${texteDe(m.content)}\n</user>`;
    if (m.role === "tool") {
      return `<tool_result id="${m.tool_call_id ?? ""}">\n${texteDe(m.content)}\n</tool_result>`;
    }
    let t = texteDe(m.content);
    for (const tc of m.tool_calls ?? []) {
      const f = tc.function ?? {};
      t += `\n<tool_call>${JSON.stringify({ name: f.name, arguments: analyser(f.arguments ?? "{}") })}</tool_call>`;
    }
    return `<assistant>\n${t.trim()}\n</assistant>`;
  });
  return {
    systeme,
    entree: [
      "Here is the conversation so far. Continue it as the assistant: answer the last message.",
      "",
      ...blocs,
    ].join("\n\n"),
  };
}

/** Les appels d'outils écrits par le modèle, et le texte qui reste. */
export function extraireAppels(texte) {
  const appels = [];
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m;
  while ((m = re.exec(texte))) {
    const brut = m[1].replace(/^```(?:json)?\s*|\s*```$/g, "");
    try {
      const v = JSON.parse(brut);
      if (v && typeof v.name === "string") {
        appels.push({
          id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
          type: "function",
          function: {
            name: v.name,
            arguments: JSON.stringify(v.arguments ?? v.parameters ?? {}),
          },
        });
      }
    } catch {
      // Un bloc illisible reste du texte : mieux vaut le montrer que le perdre.
    }
  }
  const reste = appels.length ? texte.replace(re, "").trim() : texte;
  return { appels, reste };
}

/**
 * Filtre du flux : le texte passe tant qu'aucun bloc d'outil ne commence.
 * Un début de « <tool_call » coupé entre deux morceaux est retenu le temps de
 * savoir ce qu'il devient.
 */
function filtreFlux(emettre) {
  const MARQUE = "<tool_call";
  let tampon = "";
  let retenu = false;
  return {
    pousser(morceau) {
      if (retenu) return;
      tampon += morceau;
      const i = tampon.indexOf(MARQUE);
      if (i >= 0) {
        if (i > 0) emettre(tampon.slice(0, i));
        retenu = true;
        tampon = "";
        return;
      }
      let garde = 0;
      for (let k = Math.min(MARQUE.length - 1, tampon.length); k > 0; k--) {
        if (MARQUE.startsWith(tampon.slice(-k))) {
          garde = k;
          break;
        }
      }
      const sortie = tampon.slice(0, tampon.length - garde);
      if (sortie) emettre(sortie);
      tampon = tampon.slice(tampon.length - garde);
    },
    finir() {
      if (!retenu && tampon) emettre(tampon);
      tampon = "";
    },
  };
}

async function completions(req, res) {
  let corps;
  try {
    corps = await lireCorps(req);
  } catch {
    return erreur(res, 400, "corps JSON illisible");
  }
  const modeles = await adapter.models();
  const modele = corps.model || modeles[0]?.id || "default";
  const info = modeles.find((m) => m.id === modele);
  if (info?.context_length) contexte = info.context_length;
  const { systeme, entree } = rendre(corps.messages ?? [], corps.tools);
  const flux = corps.stream === true;
  const id = `chatcmpl-${randomUUID()}`;
  const cree = Math.floor(Date.now() / 1000);
  const arret = new AbortController();
  // La personne a cliqué sur Stop : Locaryn ferme la connexion, le CLI s'arrête.
  res.on("close", () => {
    if (!res.writableEnded) arret.abort();
  });

  const morceau = (delta, fin = null, extra = {}) => ({
    id,
    object: "chat.completion.chunk",
    created: cree,
    model: modele,
    choices: [{ index: 0, delta, finish_reason: fin }],
    ...extra,
  });

  if (flux) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const ecrire = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    ecrire(morceau({ role: "assistant", content: "" }));
    const filtre = filtreFlux((t) => ecrire(morceau({ content: t })));
    try {
      const r = await adapter.run({
        model: modele,
        system: systeme,
        prompt: entree,
        signal: arret.signal,
        onDelta: (t) => filtre.pousser(t),
      });
      filtre.finir();
      const { appels } = extraireAppels(r.text);
      if (appels.length) {
        ecrire(
          morceau({
            tool_calls: appels.map((a, index) => ({ index, ...a })),
          }),
        );
      }
      ecrire(
        morceau({}, appels.length ? "tool_calls" : "stop", {
          usage: r.usage ?? undefined,
        }),
      );
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (e) {
      if (!res.writableEnded) {
        ecrire(morceau({ content: `\n\n[${adapter.label}] ${e.message ?? e}` }, "stop"));
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }
    return;
  }

  try {
    const r = await adapter.run({
      model: modele,
      system: systeme,
      prompt: entree,
      signal: arret.signal,
      onDelta: () => {},
    });
    const { appels, reste } = extraireAppels(r.text);
    json(res, 200, {
      id,
      object: "chat.completion",
      created: cree,
      model: modele,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: reste,
            ...(appels.length ? { tool_calls: appels } : {}),
          },
          finish_reason: appels.length ? "tool_calls" : "stop",
        },
      ],
      usage: r.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (e) {
    erreur(res, 502, `${adapter.label} : ${e.message ?? e}`);
  }
}

const serveur = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const chemin = url.pathname.replace(/\/+$/, "") || "/";
  try {
    if (req.method === "GET" && (chemin === "/health" || chemin === "/")) {
      const etat = await adapter.status();
      return json(res, 200, { ok: true, provider: adapter.id, ...etat });
    }
    if (req.method === "GET" && chemin === "/v1/models") {
      const modeles = await adapter.models();
      return json(res, 200, {
        object: "list",
        data: modeles.map((m) => ({
          id: m.id,
          object: "model",
          owned_by: adapter.id,
          name: m.name ?? m.id,
          context_length: m.context_length ?? null,
          description: m.description ?? "",
          supports_tools: true,
        })),
      });
    }
    if (req.method === "GET" && (chemin === "/props" || chemin === "/v1/props")) {
      return json(res, 200, { default_generation_settings: { n_ctx: contexte }, n_ctx: contexte });
    }
    if (req.method === "GET" && (chemin === "/v1/usage" || chemin === "/usage")) {
      return json(res, 200, await adapter.usage());
    }
    if (req.method === "POST" && chemin === "/v1/chat/completions") {
      return await completions(req, res);
    }
    if (chemin === "/auth/status") return json(res, 200, await adapter.status());
    if (req.method === "POST" && chemin === "/auth/login") return json(res, 200, await adapter.login());
    if (req.method === "POST" && chemin === "/auth/logout") {
      return json(res, 200, await adapter.logout());
    }
    erreur(res, 404, `route inconnue : ${chemin}`);
  } catch (e) {
    if (!res.headersSent) erreur(res, 500, String(e?.message ?? e));
  }
});

serveur.listen(PORT, HOST, () => {
  console.log(`[${adapter.id}] pont à l'écoute sur http://${HOST}:${PORT}`);
});
