'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(min, Math.min(max, Math.round(number)))
    : fallback;
}

function analysisGroupName(name) {
  if (typeof name !== 'string' || !/%3a%3a/i.test(name)) return null;
  const match = /^(.*?\.json)(?:\.bak)?(?:\.corrupt-\d+)?$/i.exec(name);
  return match ? match[1] : null;
}

function pruneAnalysisCache(directory, options = {}) {
  const maxEntries = clampInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, 1, 1000);
  const maxBytes = clampInteger(options.maxBytes, DEFAULT_MAX_BYTES, 1024 * 1024, 1024 * 1024 * 1024);
  const protectedGroups = new Set(
    (options.protectedFiles || [])
      .map((file) => analysisGroupName(path.basename(String(file))))
      .filter(Boolean),
  );
  const groups = new Map();

  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return { removedFiles: 0, removedBytes: 0, keptEntries: 0, keptBytes: 0 };
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const groupName = analysisGroupName(entry.name);
    if (!groupName) continue;
    const file = path.join(directory, entry.name);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    const group = groups.get(groupName) || { name: groupName, files: [], bytes: 0, mtimeMs: 0 };
    group.files.push(file);
    group.bytes += stat.size;
    group.mtimeMs = Math.max(group.mtimeMs, stat.mtimeMs);
    groups.set(groupName, group);
  }

  const ordered = [...groups.values()].sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  let keptEntries = 0;
  let keptBytes = 0;
  let removedFiles = 0;
  let removedBytes = 0;

  for (const group of ordered) {
    const protectedEntry = protectedGroups.has(group.name);
    const fits = keptEntries < maxEntries && keptBytes + group.bytes <= maxBytes;
    if (protectedEntry || fits) {
      keptEntries += 1;
      keptBytes += group.bytes;
      continue;
    }
    for (const file of group.files) {
      try {
        const size = fs.statSync(file).size;
        fs.rmSync(file, { force: true });
        removedFiles += 1;
        removedBytes += size;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  return { removedFiles, removedBytes, keptEntries, keptBytes };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ENTRIES,
  analysisGroupName,
  pruneAnalysisCache,
};
