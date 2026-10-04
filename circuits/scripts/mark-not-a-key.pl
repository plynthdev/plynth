#!/usr/bin/perl -p
# Appends the public-guard "// not-a-key" marker to lines holding 32-byte field constants
# (round constants, verification keys, hashes), which match the private-key pattern.
s{\s*$}{ // not-a-key\n} if m{0x[0-9a-fA-F]{64}} && !m{// (not-a-key|test-key)};
