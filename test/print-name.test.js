'use strict';

const assert = require('node:assert/strict');
const { test } = require('bun:test');
const {
  cleanObjectName,
  isGenericPrintName,
  modelNameFromMetadata,
  objectNamesFromMetadata,
  preferredPrintName,
} = require('../print-name.js');

test('extracts, cleans, and deduplicates slicer object names', () => {
  const meta = {
    objects_info: JSON.stringify({ objects: [
      { name: 'C:\\models\\gridfinity-bin-bottom.stl' },
      { name: 'gridfinity-bin-bottom.STL' },
      { name: 'lid insert.step' },
    ] }),
  };

  assert.deepEqual(objectNamesFromMetadata(meta), [
    'gridfinity-bin-bottom',
    'lid insert',
  ]);
  assert.equal(modelNameFromMetadata(meta), 'gridfinity-bin-bottom + 1 more');
});

test('uses a model name only for known generic upstream labels', () => {
  assert.equal(preferredPrintName('Merged', 'gridfinity-bin-bottom.stl'), 'gridfinity-bin-bottom');
  assert.equal(preferredPrintName('MERGED~1', 'gridfinity-bin-bottom'), 'gridfinity-bin-bottom');
  assert.equal(preferredPrintName('', 'gridfinity-bin-bottom'), 'gridfinity-bin-bottom');
  assert.equal(preferredPrintName('My deliberate project name', 'source-model.stl'), 'My deliberate project name');
  assert.equal(
    preferredPrintName('Merged', null, 'Storage Bin Bottom'),
    'Storage Bin Bottom',
  );
  assert.equal(isGenericPrintName('Untitled (2)'), true);
  assert.equal(isGenericPrintName('merged bracket'), false);
});

test('handles malformed or generic objects without inventing a name', () => {
  assert.deepEqual(objectNamesFromMetadata({ objects_info: '{bad json' }), []);
  assert.deepEqual(objectNamesFromMetadata({ objects_info: { objects: [{ name: 'Merged.stl' }] } }), []);
  assert.equal(modelNameFromMetadata({}), null);
  assert.equal(preferredPrintName('Merged', null), 'Merged');
  assert.equal(cleanObjectName('folder/subfolder/model.3mf'), 'model');
});
