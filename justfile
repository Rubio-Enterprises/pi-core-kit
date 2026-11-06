set positional-arguments
set shell := ["bash", "-euo", "pipefail", "-c"]

export REPO_DIR := justfile_directory()
export COMPOSE_PROJECT_NAME := "repo-" + sha256(justfile_directory())
export GIT_COMMON_DIR := `git rev-parse --path-format=absolute --git-common-dir`

# Show available recipes
_default:
    @just --list

# Build dev container image
build:
    @docker volume create rubio-uv-cache >/dev/null
    @docker volume create rubio-npm-cache >/dev/null
    @docker volume create rubio-gomod-cache >/dev/null
    @docker volume create rubio-cargo-registry >/dev/null
    @docker volume create rubio-coursier-cache >/dev/null
    docker compose build --pull dev

# Build the dev image, sync dependencies into volumes, and install git hooks
setup: build
    docker compose run --rm -T dev bin/setup.sh </dev/null
    @HOOKS_DIR="$(git rev-parse --git-path hooks)"; \
    mkdir -p "$HOOKS_DIR"; \
    rm -f "$HOOKS_DIR/post-checkout" "$HOOKS_DIR/post-merge" "$HOOKS_DIR/post-rewrite"; \
    for hook in pre-commit commit-msg pre-push; do \
        printf '#!/bin/sh\nset -eu\nREPO_DIR="$(git rev-parse --show-toplevel)"\nexport REPO_DIR\nexport GIT_COMMON_DIR="$(git -C "$REPO_DIR" rev-parse --path-format=absolute --git-common-dir)"\nexport COMPOSE_PROJECT_NAME="repo-$(printf %%s "$REPO_DIR" | shasum -a 256 | cut -d " " -f 1)"\ncd "$REPO_DIR" && exec docker compose run --rm -T dev lefthook run --no-auto-install %s "$@" </dev/null\n' "$hook" > "$HOOKS_DIR/$hook"; \
        chmod +x "$HOOKS_DIR/$hook"; \
    done

# Run standards checks inside the container
check:
    docker compose run --rm -T dev standards check </dev/null

# Run formatters and fixers inside the container
fmt:
    docker compose run --rm -T dev standards fmt </dev/null

# Run pull-request conventions check inside the container
check-pr:
    docker compose run --rm -T dev standards check-pr </dev/null

# Open interactive shell inside the dev container
shell:
    docker compose run --rm dev bash

# Execute arbitrary command inside the dev container
exec *args:
    docker compose run --rm -T dev "$@" </dev/null

test *args:
    docker compose run --rm -T dev bin/test.sh "$@" </dev/null

typecheck *args:
    docker compose run --rm -T dev bin/typecheck.sh "$@" </dev/null

setup-deps *args:
    docker compose run --rm -T dev bin/setup-deps.sh "$@" </dev/null
