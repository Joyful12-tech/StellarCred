// scripts/check-holder-size.js
const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, '../frontend/app/holder/HolderPageClient.tsx');
const MAX_LINES = 300;

try {
  const content = fs.readFileSync(targetFile, 'utf8');
  const lineCount = content.split('\n').length;

  console.log(`HolderPageClient.tsx current line count: ${lineCount} (Max allowed: ${MAX_LINES})`);

  if (lineCount > MAX_LINES) {
    console.error(`❌ Error: HolderPageClient.tsx has grown to ${lineCount} lines, exceeding the limit of ${MAX_LINES}. Please refactor logic into hooks and components.`);
    process.exit(1);
  } else {
    console.log('✅ HolderPageClient.tsx line count is within acceptable limits.');
    process.exit(0);
  }
} catch (error) {
  console.error('Failed to check HolderPageClient line count:', error);
  process.exit(1);
}