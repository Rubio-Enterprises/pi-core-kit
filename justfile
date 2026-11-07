set positional-arguments
set shell := ["bash", "-euo", "pipefail", "-c"]

export RUBIO_BUILD_GITHUB_TOKEN := env('GH_TOKEN', env('GITHUB_TOKEN', ''))
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
    docker compose run --rm -T dev /opt/standards/bin/install-hooks </dev/null

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
