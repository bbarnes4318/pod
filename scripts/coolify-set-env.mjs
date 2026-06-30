import fs from 'fs';
import path from 'path';

// Helper to mask secrets in console logs
function maskValue(key, val) {
  if (!val) return 'MISSING';
  const sensitiveKeys = ['API_KEY', 'PASSWORD', 'SECRET', 'TOKEN', 'DATABASE_URL'];
  const isSensitive = sensitiveKeys.some(k => key.toUpperCase().includes(k));
  if (isSensitive) {
    if (val.length <= 8) return '[MASKED]';
    return `${val.slice(0, 4)}...${val.slice(-4)}`;
  }
  return val;
}

// Helper to check if a value is a placeholder
function isPlaceholderValue(val) {
  if (!val) return true;
  const normalized = val.trim().toUpperCase();
  return [
    'SET_IN_COOLIFY_ONLY',
    'CHANGE_ME',
    'CHANGE_ME_IN_COOLIFY_ONLY',
    'SET_YOUR_REAL_KEY_IN_COOLIFY',
    'SET_YOUR_REAL_SECRET_IN_COOLIFY',
    'YOUR_KEY_HERE',
    'YOUR_SECRET_HERE',
    'PASTE_KEY_HERE',
    'PASTE_SECRET_HERE'
  ].includes(normalized);
}

async function run() {
  const token = process.env.COOLIFY_API_TOKEN;
  const uuid = process.env.COOLIFY_RESOURCE_UUID;
  const baseUrl = process.env.COOLIFY_URL || 'http://localhost:8000';

  if (!token) {
    console.error('ERROR: COOLIFY_API_TOKEN environment variable is required.');
    process.exit(1);
  }
  if (!uuid) {
    console.error('ERROR: COOLIFY_RESOURCE_UUID environment variable is required.');
    process.exit(1);
  }

  // Normalize URL
  const normalizedUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;

  // Read .env.coolify.local
  const filePath = path.join(process.cwd(), '.env.coolify.local');
  if (!fs.existsSync(filePath)) {
    console.error(`ERROR: Config file not found at ${filePath}. Please copy .env.coolify.example to .env.coolify.local first.`);
    process.exit(1);
  }

  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const envVars = {};

  const lines = fileContent.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equalIndex = trimmed.indexOf('=');
    if (equalIndex === -1) continue;
    const key = trimmed.slice(0, equalIndex).trim();
    let value = trimmed.slice(equalIndex + 1).trim();
    
    // Remove wrapping quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    
    envVars[key] = value;
  }

  console.log(`Parsed ${Object.keys(envVars).length} environment variables from .env.coolify.local.`);
  console.log(`Connecting to Coolify API at: ${normalizedUrl}/api/v1 (Resource UUID: ${uuid})`);

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };

  // 1. Fetch current environment variables configured in Coolify
  let existingEnvs = [];
  try {
    const getRes = await fetch(`${normalizedUrl}/api/v1/applications/${uuid}/envs`, {
      method: 'GET',
      headers
    });
    if (!getRes.ok) {
      const errText = await getRes.text();
      throw new Error(`GET envs failed. HTTP ${getRes.status}: ${errText}`);
    }
    existingEnvs = await getRes.json();
    console.log(`Fetched ${existingEnvs.length} existing environment variables from the Coolify resource.`);
  } catch (err) {
    console.error('ERROR connecting to Coolify REST API:', err.message);
    process.exit(1);
  }

  const existingMap = {};
  for (const env of existingEnvs) {
    existingMap[env.key] = env;
  }

  let successCount = 0;
  let skipCount = 0;
  let failCount = 0;

  for (const [key, value] of Object.entries(envVars)) {
    // Skip if placeholder
    if (isPlaceholderValue(value)) {
      console.log(`[SKIP] ${key} uses a placeholder value "${value}".`);
      skipCount++;
      continue;
    }

    const isBuildTime = key.startsWith('NEXT_PUBLIC_');
    const existing = existingMap[key];

    try {
      if (existing) {
        // If key exists and values + type match, skip
        if (existing.value === value && existing.is_build_time === isBuildTime) {
          console.log(`[UP-TO-DATE] ${key} is already configured correctly.`);
          skipCount++;
          continue;
        }

        // Delete existing env to update it cleanly (bypasses payload differences in PATCH across versions)
        console.log(`[UPDATE] Re-syncing changed variable: ${key}...`);
        const delRes = await fetch(`${normalizedUrl}/api/v1/applications/${uuid}/envs/${existing.uuid}`, {
          method: 'DELETE',
          headers
        });
        if (!delRes.ok) {
          throw new Error(`Delete failed: HTTP ${delRes.status}`);
        }
      } else {
        console.log(`[CREATE] Adding new variable: ${key}...`);
      }

      // POST to create
      const postRes = await fetch(`${normalizedUrl}/api/v1/applications/${uuid}/envs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          key,
          value,
          is_build_time: isBuildTime,
          is_preview: false,
          is_shown_in_ui: true
        })
      });

      if (!postRes.ok) {
        const errText = await postRes.text();
        throw new Error(`Create failed: HTTP ${postRes.status} - ${errText}`);
      }

      console.log(`[SUCCESS] Set ${key} = ${maskValue(key, value)} (Build Time: ${isBuildTime})`);
      successCount++;
    } catch (err) {
      console.error(`[FAIL] ${key}:`, err.message);
      failCount++;
    }
  }

  console.log('\n=========================================');
  console.log('SYNC OPERATION SUMMARY:');
  console.log(`- Created/Updated: ${successCount}`);
  console.log(`- Skipped:         ${skipCount}`);
  console.log(`- Failed:          ${failCount}`);
  console.log('=========================================');

  if (failCount > 0) {
    process.exit(1);
  } else {
    console.log('Sync completed successfully!');
    process.exit(0);
  }
}

run();
