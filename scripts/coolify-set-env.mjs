import fs from 'fs';
import path from 'path';

// Get configuration from process.env
const token = process.env.COOLIFY_API_TOKEN;
const resourceUuid = process.env.COOLIFY_RESOURCE_UUID;
const baseUrl = process.env.COOLIFY_URL || 'http://localhost:8000';

if (!token) {
  console.error("ERROR: COOLIFY_API_TOKEN environment variable is not set.");
  process.exit(1);
}
if (!resourceUuid) {
  console.error("ERROR: COOLIFY_RESOURCE_UUID environment variable is not set.");
  process.exit(1);
}

// Path to local envs
const envPath = path.resolve('.env.coolify.local');
if (!fs.existsSync(envPath)) {
  console.error(`ERROR: Local configuration file not found at: ${envPath}`);
  process.exit(1);
}

// Parse env variables
const fileContent = fs.readFileSync(envPath, 'utf8');
const envVars = [];
const lines = fileContent.split(/\r?\n/);

for (let line of lines) {
  line = line.trim();
  if (!line || line.startsWith('#')) continue;
  
  const equalsIndex = line.indexOf('=');
  if (equalsIndex === -1) continue;
  
  const key = line.substring(0, equalsIndex).trim();
  let value = line.substring(equalsIndex + 1).trim();
  
  // Strip quotes if present
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.substring(1, value.length - 1);
  }
  
  // NEXT_PUBLIC_* variables are needed at build time in Next.js
  const isBuildTime = key.startsWith('NEXT_PUBLIC_');
  
  envVars.push({ key, value, isBuildTime });
}

console.log(`Parsed ${envVars.length} environment variables from .env.coolify.local`);

// Helper to mask values in logs
function maskValue(key, val) {
  if (!val) return 'MISSING';
  const sensitiveKeys = [
    'PASSWORD', 'KEY', 'SECRET', 'TOKEN', 'DATABASE', 'REDIS', 'URL'
  ];
  const isSensitive = sensitiveKeys.some(s => key.toUpperCase().includes(s));
  if (isSensitive) {
    if (val.length <= 8) return '[MASKED]';
    return `${val.substring(0, 4)}...${val.substring(val.length - 4)}`;
  }
  return val;
}

// Execute sync
async function syncEnvs() {
  const apiBase = `${baseUrl.replace(/\/$/, '')}/api/v1`;
  
  console.log(`Connecting to Coolify API at: ${apiBase}`);
  console.log(`Target Application/Resource UUID: ${resourceUuid}`);
  console.log("--------------------------------------------------");
  
  // 1. Fetch existing env variables to check for keys
  let existingEnvs = [];
  try {
    const res = await fetch(`${apiBase}/applications/${resourceUuid}/envs`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      }
    });
    
    if (res.status === 200) {
      existingEnvs = await res.json();
      console.log(`Fetched ${existingEnvs.length} existing variables from Coolify.`);
    } else if (res.status === 404) {
      console.warn("WARNING: GET /envs returned 404. Proceeding to create all variables.");
    } else {
      const errText = await res.text();
      console.error(`ERROR: Failed to fetch existing env variables. Status: ${res.status}. Response: ${errText}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`ERROR: Network error during GET env variables: ${err.message}`);
    process.exit(1);
  }
  
  const existingMap = new Map(existingEnvs.map(e => [e.key || e.name, e]));
  
  // 2. Upsert each env variable
  for (const item of envVars) {
    const existing = existingMap.get(item.key);
    const maskedVal = maskValue(item.key, item.value);
    
    if (existing) {
      // Key exists. Let's update it using PATCH.
      // We check if value differs
      if (existing.value === item.value) {
        console.log(`[SKIPPED] ${item.key} is already up to date.`);
        continue;
      }
      
      console.log(`[UPDATING] ${item.key} -> ${maskedVal}...`);
      
      try {
        // Try PATCH to /applications/{uuid}/envs
        let patchRes = await fetch(`${apiBase}/applications/${resourceUuid}/envs`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            key: item.key,
            value: item.value,
            is_build_time: item.isBuildTime
          })
        });
        
        // If first attempt is not successful, attempt specific resource PATCH using env uuid
        if (patchRes.status !== 200 && patchRes.status !== 201 && patchRes.status !== 204 && existing.uuid) {
          patchRes = await fetch(`${apiBase}/applications/${resourceUuid}/envs/${existing.uuid}`, {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            body: JSON.stringify({
              value: item.value,
              is_build_time: item.isBuildTime
            })
          });
        }
        
        if (patchRes.status === 200 || patchRes.status === 201 || patchRes.status === 204) {
          console.log(`[SUCCESS] Updated ${item.key}`);
        } else {
          const errText = await patchRes.text();
          console.error(`[FAILED] Failed to update ${item.key}. Status: ${patchRes.status}. Error: ${errText}`);
        }
      } catch (err) {
        console.error(`[ERROR] Network error updating ${item.key}: ${err.message}`);
      }
      
    } else {
      // Key does not exist. Let's create it using POST.
      console.log(`[CREATING] ${item.key} -> ${maskedVal}...`);
      
      try {
        const postRes = await fetch(`${apiBase}/applications/${resourceUuid}/envs`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            key: item.key,
            value: item.value,
            is_build_time: item.isBuildTime,
            is_preview: false
          })
        });
        
        if (postRes.status === 200 || postRes.status === 201 || postRes.status === 204) {
          console.log(`[SUCCESS] Created ${item.key}`);
        } else {
          const errText = await postRes.text();
          console.error(`[FAILED] Failed to create ${item.key}. Status: ${postRes.status}. Error: ${errText}`);
        }
      } catch (err) {
        console.error(`[ERROR] Network error creating ${item.key}: ${err.message}`);
      }
    }
  }
  
  console.log("--------------------------------------------------");
  console.log("Sync process completed!");
}

syncEnvs();
