'use strict';

// PrusaSlicer can publish a generic project label (notably "Merged") even when
// the bgcode still contains the original model names in objects_info. Keep a
// deliberately small placeholder list so an intentional filename continues to
// win over embedded object metadata.
function isGenericPrintName(value) {
  const name = String(value || '').trim();
  if (!name) return true;
  return /^(?:merged|untitled|new[ _-]*project)(?:[ _~()-]*\d+[ _~()-]*)?$/i.test(name);
}

function cleanObjectName(value) {
  if (typeof value !== 'string') return '';
  const basename = value.replace(/\\/g, '/').split('/').pop() || '';
  return basename
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\.(?:stl|3mf|obj|step|stp|amf|dae)$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function objectNamesFromMetadata(meta) {
  const raw = meta && meta.objects_info;
  if (!raw) return [];
  let info = raw;
  if (typeof raw === 'string') {
    try { info = JSON.parse(raw); }
    catch { return []; }
  }
  if (!info || !Array.isArray(info.objects)) return [];

  const seen = new Set();
  const names = [];
  for (const object of info.objects) {
    const name = cleanObjectName(object && object.name);
    const key = name.toLocaleLowerCase();
    if (!name || isGenericPrintName(name) || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

function modelNameFromMetadata(meta) {
  const names = objectNamesFromMetadata(meta);
  if (!names.length) return null;
  if (names.length === 1) return names[0];
  return `${names[0]} + ${names.length - 1} more`.slice(0, 160);
}

function preferredPrintName(upstreamName, modelName, overrideName) {
  const override = typeof overrideName === 'string'
    ? overrideName.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
    : '';
  if (override) return override;
  const upstream = String(upstreamName || '').trim();
  const model = cleanObjectName(modelName);
  return isGenericPrintName(upstream) && model ? model : upstream;
}

module.exports = {
  cleanObjectName,
  isGenericPrintName,
  modelNameFromMetadata,
  objectNamesFromMetadata,
  preferredPrintName,
};
