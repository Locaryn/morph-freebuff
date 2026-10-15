/* Carte « compte » d'un fournisseur (Claude Code, Codex, Freebuff), posée
 * dans Réglages → Compte par le slot `account.connections`.
 *
 * Elle dit si le CLI est installé et connecté, et propose les gestes utiles :
 * installer, démarrer le pont, se connecter, se déconnecter. Tout passe par
 * l'hôte (`window.locaryn.providers`) : le panneau n'ouvre aucune connexion
 * lui-même et ne voit jamais de jeton.
 *
 * Configuré par les attributs de l'élément, posés depuis le manifeste via
 * `freebuff` et `Freebuff` remplacés à la construction du morph. */
(function () {
  "use strict";

  var PROVIDER = "freebuff";
  var LABEL = "Freebuff";
  var TAG = "locaryn-freebuff-account";

  function api() {
    return window.locaryn || window.LocarynPluginAPI || null;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function bouton(texte, primaire, action) {
    var b = el("button", primaire ? "locaryn-btn-primary" : "locaryn-btn-ghost", texte);
    b.type = "button";
    b.addEventListener("click", action);
    return b;
  }

  class Carte extends HTMLElement {
    constructor() {
      super();
      this.etat = null; // statut de la passerelle (en marche, installée)
      this.compte = null; // statut du compte (connecté…)
      this.occupe = false;
      this.message = null;
      this.erreur = null;
      this.minuteur = null;
      this.lien = null; // page de connexion, si le navigateur ne s'est pas ouvert
      this.attendCode = false; // la page affiche un code à coller ici
    }

    connectedCallback() {
      this.lire();
      var self = this;
      this.minuteur = window.setInterval(function () {
        if (!self.occupe) self.lire();
      }, 8000);
    }

    disconnectedCallback() {
      if (this.minuteur) window.clearInterval(this.minuteur);
    }

    async lire() {
      var a = api();
      if (!a || !a.providers) {
        this.erreur = "Cette version de Locaryn ne sait pas gérer ce compte.";
        this.dessiner();
        return;
      }
      try {
        this.etat = await a.providers.status(PROVIDER);
        this.compte = this.etat && this.etat.running ? await a.providers.account(PROVIDER, "status") : null;
        this.erreur = null;
      } catch (e) {
        this.erreur = String((e && e.message) || e);
      }
      this.dessiner();
    }

    async faire(etape) {
      var a = api();
      if (!a) return;
      this.occupe = true;
      this.erreur = null;
      this.message = null;
      this.dessiner();
      try {
        var r = await etape(a);
        if (r && typeof r === "object" && r.detail) this.message = r.detail;
        else if (typeof r === "string") this.message = r;
      } catch (e) {
        this.erreur = String((e && e.message) || e);
      } finally {
        this.occupe = false;
        await this.lire();
      }
    }

    dessiner() {
      this.textContent = "";
      var carte = el("div", "locaryn-card");
      carte.style.cssText = "padding:14px 16px";

      var tete = el("div");
      tete.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px";
      var titre = el("div");
      var h = el("strong", null, LABEL);
      h.style.fontSize = "14px";
      titre.appendChild(h);
      var sous = el("div", "locaryn-field-hint");
      sous.style.margin = "2px 0 0";
      var en = this.etat && this.etat.running;
      var connecte = this.compte && this.compte.logged_in === true;
      sous.textContent = !this.etat
        ? "Lecture…"
        : !this.etat.installed
          ? "Pas installé"
          : !en
            ? "Pont arrêté"
            : connecte
              ? this.compte.account
                ? "Connecté · " + this.compte.account
                : "Connecté"
              : "Pas connecté";
      titre.appendChild(sous);
      tete.appendChild(titre);

      var pastille = el("span");
      pastille.style.cssText =
        "width:9px;height:9px;border-radius:50%;flex:none;background:" +
        (connecte ? "var(--accent)" : en ? "var(--warn)" : "var(--text-faint)");
      tete.appendChild(pastille);
      carte.appendChild(tete);

      if (this.compte && this.compte.detail) {
        var d = el("p", "locaryn-field-hint", this.compte.detail);
        d.style.margin = "10px 0 0";
        carte.appendChild(d);
      } else if (this.etat && this.etat.detail && !en) {
        var d2 = el("p", "locaryn-field-hint", this.etat.detail);
        d2.style.margin = "10px 0 0";
        carte.appendChild(d2);
      }

      var actions = el("div", "locaryn-field-actions");
      actions.style.marginTop = "12px";
      var self = this;
      if (this.etat && !this.etat.installed) {
        actions.appendChild(
          bouton("Installer " + LABEL, true, function () {
            self.faire(function (a) {
              return a.providers.install(PROVIDER);
            });
          }),
        );
      } else if (this.etat && !en) {
        actions.appendChild(
          bouton("Démarrer", true, function () {
            self.faire(function (a) {
              return a.providers.start(PROVIDER);
            });
          }),
        );
      } else if (en && !connecte) {
        actions.appendChild(
          bouton("Se connecter", true, function () {
            self.faire(async function (a) {
              var r = await a.providers.account(PROVIDER, "login");
              if (r && r.ok === false) throw new Error(r.detail || "La connexion n'a pas démarré.");
              self.lien = (r && r.url) || null;
              self.attendCode = !!(r && r.needs_code);
              return r;
            });
          }),
        );
        if (this.lien) {
          var lienEl = el("a", null, "Ouvrir la page de connexion");
          lienEl.href = this.lien;
          lienEl.target = "_blank";
          lienEl.rel = "noopener noreferrer";
          lienEl.style.cssText = "align-self:center;font-size:12px";
          actions.appendChild(lienEl);
        }
      } else if (connecte) {
        actions.appendChild(
          bouton("Se déconnecter", false, function () {
            self.faire(function (a) {
              return a.providers.account(PROVIDER, "logout");
            });
          }),
        );
      }
      actions.appendChild(
        bouton("Actualiser", false, function () {
          self.lire();
        }),
      );
      Array.prototype.forEach.call(actions.querySelectorAll("button"), function (b) {
        b.disabled = self.occupe;
      });
      carte.appendChild(actions);

      // Le code que la page de connexion affiche (Claude) : collé ici, il
      // termine la connexion sans terminal.
      if (this.attendCode && en && !connecte) {
        var form = el("form");
        form.style.cssText = "display:flex;gap:8px;margin-top:10px";
        var champ = el("input", "locaryn-input");
        champ.placeholder = "Collez le code affiché après la connexion";
        champ.autocomplete = "off";
        champ.spellcheck = false;
        champ.style.flex = "1";
        var valider = el("button", "locaryn-btn-primary", "Valider");
        valider.type = "submit";
        valider.disabled = self.occupe;
        form.appendChild(champ);
        form.appendChild(valider);
        form.addEventListener("submit", function (ev) {
          ev.preventDefault();
          var code = champ.value.trim();
          if (!code) return;
          self.faire(async function (a) {
            var r = await a.providers.account(PROVIDER, "code", code);
            if (r && r.ok === false) throw new Error(r.detail || "Code refusé.");
            self.attendCode = false;
            self.lien = null;
            return "Connecté.";
          });
        });
        carte.appendChild(form);
      }

      if (this.message) {
        var m = el("p", "locaryn-field-hint", this.message);
        m.style.cssText = "margin:10px 0 0;color:var(--accent)";
        carte.appendChild(m);
      }
      if (this.erreur) {
        var e = el("p", "locaryn-field-hint", this.erreur);
        e.style.cssText = "margin:10px 0 0;color:var(--danger)";
        carte.appendChild(e);
      }
      var note = el(
        "p",
        "locaryn-field-hint",
        "Les modèles apparaissent dans « Mes modèles » et dans le sélecteur du chat, dans le dossier " +
          LABEL +
          ". Votre connexion reste celle du CLI officiel : Locaryn ne voit jamais vos identifiants.",
      );
      note.style.margin = "10px 0 0";
      carte.appendChild(note);
      this.appendChild(carte);
    }
  }

  if (!customElements.get(TAG)) customElements.define(TAG, Carte);
})();
