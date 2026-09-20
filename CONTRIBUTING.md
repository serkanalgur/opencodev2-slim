# Contributing to opencodev2-slim

Thank you for your interest in contributing! This document provides guidelines and information about contributing to this project.

## Getting Started

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/your-username/opencodev2-slim.git
   cd opencodev2-slim
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Create a branch for your changes:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development

### Running Tests

```bash
npm test
```

### Code Style

This project uses Prettier for code formatting. Before submitting a PR, please run:

```bash
npm run format
```

### Project Structure

- `src/` - Main source code
  - `index.ts` - Server plugin entry point
  - `tui.tsx` - TUI plugin for OpenCode v2
  - `lib/` - Shared libraries
- `tests/` - Test files

## Submitting Changes

1. Ensure all tests pass:
   ```bash
   npm test
   ```
2. Format your code:
   ```bash
   npm run format
   ```
3. Commit your changes with a clear message:
   ```bash
   git commit -m "feat: add new feature description"
   ```
4. Push to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```
5. Create a Pull Request on GitHub

### Commit Message Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting, etc.)
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks

## Reporting Issues

If you find a bug or have a feature request, please open an issue on GitHub with:

- A clear title and description
- Steps to reproduce (for bugs)
- Expected vs actual behavior
- Your environment (OS, Node.js version, OpenCode version)

## Code of Conduct

Please be respectful and constructive in all interactions. We are committed to providing a welcoming and inclusive experience for everyone.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
