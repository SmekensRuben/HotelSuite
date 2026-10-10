import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'functions/src/moduleCatalog.json'), 'utf8'));
const permissions = JSON.parse(fs.readFileSync(path.join(root, 'functions/src/permissionCatalog.json'), 'utf8'));
const list = (values) => `[${values.map((value) => `'${value}'`).join(', ')}]`;
function block(storage) {
  const read = storage ? 'firestore.get(/databases/(default)/documents/hotelSubscriptions/$(hotelUid)).data' : 'get(/databases/$(database)/documents/hotelSubscriptions/$(hotelUid)).data';
  const active = storage ? '' : `subscription.status in ['active', 'trialing']\n        && ((subscription.status == 'active' && subscription.validUntil == null)\n          || (subscription.validUntil is timestamp && subscription.validUntil > request.time))\n        && `;
  let result = `    // BEGIN GENERATED MODULE POLICY: scripts/render-module-rules.mjs\n    function hasModule(${storage ? 'subscription' : 'hotelUid'}, moduleId) {\n${storage ? '' : `      let subscription = ${read};\n`}      let modules = subscription.modules;\n      return ${active}subscription.modulePolicyVersion == ${catalog.policyVersion}\n        && modules is list && modules.size() <= ${Object.keys(catalog.modules).length}\n        && modules.hasOnly(${list(Object.keys(catalog.modules))})\n        && modules.toSet().size() == modules.size()\n        && (moduleId == 'core' || moduleId in modules);\n    }\n`;
  if (!storage) {
    result += `    function licensedKeys(hotelUid, keys) {\n      let modules = ${read}.modules;\n      return keys\n`;
    for (const [id, module] of Object.entries(catalog.modules)) {
      const keys = module.features.flatMap((feature) => [...(permissions[feature] || permissions[Object.keys(permissions).find((key) => key.toLowerCase() === feature)]), '*'].map((action) => `${feature}.${action}`));
      result += `        .removeAll('${id}' in modules ? [] : ${list(keys)})\n`;
    }
    result += '        ;\n    }\n';
  }
  result += `    function featureModule(feature) {\n      return ${Object.entries(catalog.modules).map(([id, module]) => `feature in ${list(module.features)} ? '${id}' :`).join('\n        ')}\n        feature in ${list(catalog.coreFeatures)} ? 'core' : 'unsupported';\n    }\n`;
  return result + '    // END GENERATED MODULE POLICY\n';
}
let mismatch = false;
for (const [file, storage] of [['firebase/firestore.rules', false], ['firebase/storage.rules', true]]) {
  const filename = path.join(root, file);
  const current = fs.readFileSync(filename, 'utf8');
  const generated = block(storage);
  const marker = /    \/\/ BEGIN GENERATED MODULE POLICY[\s\S]*?    \/\/ END GENERATED MODULE POLICY\n/;
  const next = marker.test(current) ? current.replace(marker, generated) : current.replace('    function hasActiveSubscription(hotelUid) {', generated + '\n    function hasActiveSubscription(hotelUid) {');
  if (next !== current) {
    mismatch = true;
    if (!process.argv.includes('--check')) fs.writeFileSync(filename, next);
  }
}
if (process.argv.includes('--check') && mismatch) {
  console.error('Module catalog and generated Rules differ. Run node scripts/render-module-rules.mjs.');
  process.exitCode = 1;
}
