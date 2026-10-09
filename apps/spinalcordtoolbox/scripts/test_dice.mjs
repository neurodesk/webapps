#!/usr/bin/env node

// Hand-worked Dice cases. None of the expected values are computed by the
// function under test.

import assert from 'node:assert/strict';
import { diceCoefficient } from './lib/dice.mjs';

// {1,1,0,0} vs {1,0,0,0}: |A| = 2, |B| = 1, overlap 1, so 2*1 / (2+1) = 2/3.
const partial = diceCoefficient([1, 1, 0, 0], [1, 0, 0, 0]);
assert.equal(partial.referenceCount, 2);
assert.equal(partial.candidateCount, 1);
assert.equal(partial.intersection, 1);
assert.ok(Math.abs(partial.dice - 0.6666666666666666) < 1e-12, `expected 2/3, got ${partial.dice}`);

// Identical masks overlap completely.
assert.equal(diceCoefficient(new Uint8Array([0, 1, 1, 0]), new Uint8Array([0, 1, 1, 0])).dice, 1);

// Disjoint masks do not overlap at all.
assert.equal(diceCoefficient([1, 0, 0, 0], [0, 0, 0, 1]).dice, 0);

// Any positive label counts as foreground: {3,0,2,0} vs {1,1,0,0} is
// |A| = 2, |B| = 2, overlap 1, so 2*1 / (2+2) = 0.5.
assert.equal(diceCoefficient([3, 0, 2, 0], [1, 1, 0, 0]).dice, 0.5);

// A candidate that is empty against a non-empty reference scores zero.
assert.equal(diceCoefficient([1, 1, 0, 0], [0, 0, 0, 0]).dice, 0);

assert.throws(() => diceCoefficient([1, 0], [1, 0, 0]), /equal length/);
assert.throws(() => diceCoefficient([0, 0], [0, 0]), /undefined for two empty masks/);

console.log('Dice helper tests passed');
