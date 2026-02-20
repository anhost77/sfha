# Contribuer à sfha

Merci de votre intérêt pour contribuer à sfha ! 🎉

## 🇫🇷 Langue

Ce projet est développé principalement en français. Les commits, issues et PR peuvent être rédigés en français ou en anglais.

## 🚀 Comment contribuer

### Signaler un bug

1. Vérifiez que le bug n'a pas déjà été signalé dans les [Issues](https://github.com/serverflow/sfha/issues)
2. Créez une nouvelle issue avec le template "Bug Report"
3. Incluez :
   - Version de sfha (`sfha --version`)
   - Distribution et version (Debian 12, Ubuntu 24.04...)
   - Étapes pour reproduire
   - Comportement attendu vs observé
   - Logs pertinents (`journalctl -u sfha`)

### Proposer une fonctionnalité

1. Ouvrez une issue avec le template "Feature Request"
2. Décrivez le cas d'usage
3. Attendez la discussion avant de coder

### Soumettre du code

1. **Fork** le repository
2. **Clone** votre fork :
   ```bash
   git clone https://github.com/VOTRE-USER/sfha.git
   cd sfha
   ```
3. **Créez une branche** :
   ```bash
   git checkout -b feature/ma-super-feature
   # ou
   git checkout -b fix/correction-bug
   ```
4. **Installez les dépendances** :
   ```bash
   npm install
   ```
5. **Faites vos modifications**
6. **Testez** :
   ```bash
   npm run build
   npm test
   ```
7. **Commitez** avec un message clair :
   ```bash
   git commit -m "feat: ajout du driver STONITH IPMI"
   # ou
   git commit -m "fix: correction détection quorum"
   ```
8. **Push** :
   ```bash
   git push origin feature/ma-super-feature
   ```
9. **Ouvrez une Pull Request**

## 📝 Style de code

- **TypeScript** : Tout le code source est en TypeScript
- **Pas de `any`** : Typage strict
- **Fonctions pures** quand possible
- **Commentaires** en français ou anglais
- **Nommage** : camelCase pour les variables/fonctions, PascalCase pour les types/classes

### Structure des commits

Nous suivons [Conventional Commits](https://www.conventionalcommits.org/) :

```
type(scope): description courte

Corps optionnel avec plus de détails.
```

Types :
- `feat` : Nouvelle fonctionnalité
- `fix` : Correction de bug
- `docs` : Documentation
- `refactor` : Refactoring sans changement fonctionnel
- `test` : Ajout/modification de tests
- `chore` : Maintenance (deps, CI...)

## 🏗️ Architecture

```
src/
├── cli.ts        # Interface CLI (Commander.js)
├── daemon.ts     # Démon principal
├── control.ts    # Socket Unix de contrôle
├── corosync.ts   # Intégration Corosync
├── election.ts   # Élection du leader
├── vip.ts        # Gestion VIP
├── health.ts     # Health checks
├── resources.ts  # Services systemd
├── config.ts     # Parsing YAML
├── i18n.ts       # Internationalisation
├── mesh/         # Module mesh WireGuard
└── stonith/      # Module STONITH
    ├── index.ts      # FenceCoordinator
    └── drivers/      # Drivers (Proxmox, etc.)
```

## ✅ Checklist PR

- [ ] Le code compile (`npm run build`)
- [ ] Les tests passent (`npm test`)
- [ ] La documentation est à jour si nécessaire
- [ ] Les traductions FR/EN sont ajoutées si nouveaux messages CLI
- [ ] Le CHANGELOG.md est mis à jour

## 🙋 Questions ?

Ouvrez une issue avec le label `question` ou contactez-nous.

---

Merci de contribuer à rendre la HA plus simple ! 🚀
