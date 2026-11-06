#!/bin/sh
set -eu
mkdir -p reports/test
bun test tests --reporter=junit --reporter-outfile=reports/test/junit.xml
