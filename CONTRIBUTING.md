# Contributing to sfha

Thank you for your interest in contributing to sfha! 🎉

## 🌍 Language

This project is developed primarily in French. Commits, issues, and PRs can be written in French or English.

## 🚀 How to Contribute

### Reporting a Bug

1. Check if the bug hasn't already been reported in [Issues](https://github.com/anhost77/sfha/issues)
2. Create a new issue using the "Bug Report" template
3. Include:
   - sfha version (`sfha --version`)
   - Distribution and version (Debian 12, Ubuntu 24.04...)
   - Steps to reproduce
   - Expected vs observed behavior
   - Relevant logs (`journalctl -u sfha`)

### Proposing a Feature

1. Open an issue using the "Feature Request" template
2. Describe the use case
3. Wait for discussion before coding

### Submitting Code

1. **Fork** the repository
2. **Clone** your fork:
   ```bash
   git clone https://github.com/YOUR-USER/sfha.git
   cd sfha
   ```
3. **Create a branch**:
   ```bash
   git checkout -b feature/my-awesome-feature
   # or
   git checkout -b fix/bug-fix
   ```
4. **Install dependencies**:
   ```bash
   pnpm install
   ```
5. **Make your changes**
6. **Test**:
   ```bash
   pnpm build
   pnpm test
   ```
7. **Commit** with a clear message:
   ```bash
   git commit -m "feat: add IPMI STONITH driver"
   # or
   git commit -m "fix: correct quorum detection"
   ```
8. **Push**:
   ```bash
   git push origin feature/my-awesome-feature
   ```
9. **Open a Pull Request**

## 📝 Code Style

- **TypeScript**: All source code is TypeScript
- **No `any`**: Strict typing
- **Pure functions** when possible
- **Comments** in French or English
- **Naming**: camelCase for variables/functions, PascalCase for types/classes

### Commit Style

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): short description

Optional body with more details.
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation
- `refactor`: Refactoring without functional change
- `test`: Adding/modifying tests
- `chore`: Maintenance (deps, CI...)

## 🏗️ Architecture

```
src/
├── cli.ts        # CLI interface (Commander.js)
├── daemon.ts     # Main daemon
├── control.ts    # Unix control socket
├── corosync.ts   # Corosync integration
├── election.ts   # Leader election
├── vip.ts        # VIP management
├── health.ts     # Health checks
├── resources.ts  # Systemd services
├── config.ts     # YAML parsing
├── i18n.ts       # Internationalization
├── mesh/         # WireGuard mesh module
└── stonith/      # STONITH module
    ├── index.ts      # FenceCoordinator
    └── drivers/      # Drivers (Proxmox, etc.)
```

## ✅ PR Checklist

- [ ] Code compiles (`pnpm build`)
- [ ] Tests pass (`pnpm test`)
- [ ] Documentation updated if needed
- [ ] FR/EN translations added if new CLI messages
- [ ] CHANGELOG.md updated

## 🙋 Questions?

Open an issue with the `question` label or contact us.

---

Thanks for helping make HA simpler! 🚀
