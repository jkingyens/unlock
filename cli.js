#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const crypto = require('crypto');

// --- Config File ---
const CONFIG_PATH = path.join(os.homedir(), '.unlockrc');

// --- ANSI Colors for Console Output ---
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  grey: "\x1b[90m"
};

/**
 * Reads and parses the JSON configuration from ~/.unlockrc.
 * @returns {object|null} The configuration object or null if not found/invalid.
 */
function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return null;
  }
  try {
    const configStr = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(configStr);
  } catch (error) {
    console.error(`${colors.red}Error reading or parsing config file at ${CONFIG_PATH}${colors.reset}`);
    console.error(error.message);
    return null;
  }
}

/**
 * Creates a template configuration file at ~/.unlockrc.
 */
function createTemplateConfig() {
    if (fs.existsSync(CONFIG_PATH)) {
        console.log(`${colors.yellow}⚠️  Configuration file already exists at:${colors.reset} ${CONFIG_PATH}`);
        console.log("   To create a new one, please remove the existing file first.");
        return;
    }

    const template = {
        s3Provider: {
            provider: "digitalocean",
            accessKeyId: "YOUR_S3_COMPATIBLE_ACCESS_KEY",
            secretAccessKey: "YOUR_S3_COMPATIBLE_SECRET_KEY",
            bucket: "your-bucket-or-space-name",
            region: "nyc3"
        },
        llmService: {
            provider: "openai",
            apiKey: "YOUR_LLM_API_KEY",
            model: "gpt-4o"
        }
    };

    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(template, null, 2), 'utf-8');
        console.log(`${colors.green}✅ Success! Template config file created at:${colors.reset} ${CONFIG_PATH}`);
        console.log("   Please edit this file to add your credentials.");
    } catch (error) {
        console.error(`${colors.red}Error creating config file:${colors.reset}`);
        console.error(error.message);
    }
}


/**
 * Validates a packet image object.
 * @param {object} packetImage The packet image object to validate.
 * @returns {Array<string>} An array of validation errors, or an empty array if valid.
 */
function validatePacketSchema(packetImage) {
  const errors = [];

  if (!packetImage || typeof packetImage !== 'object') {
    errors.push('Packet image is not a valid JSON object.');
    return errors;
  }

  // Check top-level keys
  const requiredKeys = ['id', 'title', 'created', 'sourceContent'];
  const missingKeys = requiredKeys.filter(key => !(key in packetImage));
  if (missingKeys.length > 0) {
    errors.push(`Missing required top-level keys: ${missingKeys.join(', ')}.`);
  }

  // Check key types
  if (packetImage.id && typeof packetImage.id !== 'string') {
    errors.push('Key "id" must be a string.');
  }
  if (packetImage.title && typeof packetImage.title !== 'string') {
    errors.push('Key "title" must be a string.');
  }
  if (packetImage.created && typeof packetImage.created !== 'string') {
    errors.push('Key "created" must be a string.');
  }
  if (!Array.isArray(packetImage.sourceContent)) {
    errors.push('Key "sourceContent" must be an array.');
  }

  // Check for duplicate URLs
  if (Array.isArray(packetImage.sourceContent)) {
    const urls = new Set();
    const duplicates = new Set();

    function checkDuplicates(contentArray) {
      for (const item of contentArray) {
        if (item.url) {
          if (urls.has(item.url)) {
            duplicates.add(item.url);
          } else {
            urls.add(item.url);
          }
        }
        if (item.type === 'alternative' && item.alternatives) {
          checkDuplicates(item.alternatives);
        }
      }
    }

    checkDuplicates(packetImage.sourceContent);

    if (duplicates.size > 0) {
      errors.push(`Found duplicate URLs in content: ${Array.from(duplicates).join(', ')}.`);
    }
  }

  return errors;
}

/**
 * Validates if a packet is "winnable" by ensuring all required items are reachable.
 * @param {object} packetImage The packet image object to validate.
 * @returns {Array<string>} An array of winnability errors, or an empty array if valid.
 */
function validatePacketWinnability(packetImage) {
    const errors = [];

    // Fallback case: If no checkpoints are defined, the packet is trivially winnable.
    if (!packetImage.checkpoints || packetImage.checkpoints.length === 0) {
        return errors;
    }

    // 1. Initialization
    const requiredItems = new Set();
    packetImage.checkpoints.forEach(cp => {
        cp.requiredItems.forEach(item => {
            requiredItems.add(item.url); // Now only uses URL
        });
    });

    const unlockedItems = new Set(
        packetImage.sourceContent
            .filter(item => typeof item.revealedByMoment !== 'number')
            .map(item => item.url)
            .filter(Boolean)
    );

    const trippedMoments = new Set();
    let progressMadeInLoop = true;

    // 2. The Unlocking Loop
    while (progressMadeInLoop) {
        progressMadeInLoop = false;
        const newlyVisitedItems = [];

        for (const required of requiredItems) {
            if (unlockedItems.has(required)) {
                newlyVisitedItems.push(required);
                progressMadeInLoop = true;
            }
        }

        if (newlyVisitedItems.length > 0) {
            newlyVisitedItems.forEach(visited => requiredItems.delete(visited));

            const momentsToTrip = (packetImage.moments || [])
                .filter(moment => newlyVisitedItems.includes(moment.sourceUrl) && !trippedMoments.has(moment.id));

            momentsToTrip.forEach(moment => {
                trippedMoments.add(moment.id);
                const momentIndex = packetImage.moments.indexOf(moment);

                packetImage.sourceContent
                    .filter(item => item.revealedByMoment === momentIndex)
                    .forEach(item => unlockedItems.add(item.url));
            });
        }
    }

    // 3. Determining the Result
    if (requiredItems.size > 0) {
        errors.push('Packet is not winnable. The following required items are unreachable:');
        requiredItems.forEach(item => errors.push(`- ${item}`));
    }

    return errors;
}

/**
 * Checks the status of a single URL.
 * @param {string} url - The URL to check.
 * @returns {Promise<object>} A promise that resolves with the status object.
 */
function checkUrlStatus(url) {
  return new Promise((resolve) => {
    const options = {
      method: 'HEAD',
      timeout: 5000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    };
    const req = https.request(url, options, (res) => {
      resolve({ url, statusCode: res.statusCode, statusMessage: res.statusMessage });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ url, statusCode: 0, statusMessage: 'Timeout' });
    });

    req.on('error', (e) => {
      resolve({ url, statusCode: 0, statusMessage: e.code || 'Request Error' });
    });

    req.end();
  });
}


/**
 * Checks all external links in a packet and reports their status.
 * @param {object} packetImage - The packet image object.
 */
async function validateExternalLinks(packetImage) {
    console.log(`\n🔍 Running health check for "${packetImage.title}"...`);
    const externalItems = packetImage.sourceContent.filter(item => item.origin === 'external' && item.url);

    if (externalItems.length === 0) {
        console.log(`${colors.yellow}⚠️ No external links found to check.${colors.reset}`);
        return;
    }

    const promises = externalItems.map(item => checkUrlStatus(item.url));
    const results = await Promise.all(promises);

    console.log("\n🔗 External Link Status:");
    results.forEach(({ url, statusCode }) => {
        let statusText = '';
        if (statusCode >= 200 && statusCode < 300) {
            statusText = `${colors.green}✔ OK (${statusCode})${colors.reset}`;
        } else if (statusCode === 401 || statusCode === 403) {
            statusText = `${colors.yellow}⚠️  Warn (${statusCode})${colors.reset}`;
        } else if (statusCode >= 400 || statusCode === 0) {
            statusText = `${colors.red}✖ Error (${statusCode})${colors.reset}`;
        } else if (statusCode >= 300 && statusCode < 400) {
            statusText = `${colors.grey}➜ Redirect (${statusCode})${colors.reset}`;
        } else {
            statusText = `${colors.grey}? Unknown (${statusCode})${colors.reset}`;
        }
        console.log(`  [${statusText}] ${url}`);
    });
}

/**
 * Tests the configured LLM credentials by making a simple API call.
 * @param {object} llmConfig - The LLM configuration object.
 */
async function testLlmCredentials(llmConfig) {
    process.stdout.write("⚡ Testing LLM credentials...");
    try {
        const { provider, apiKey, model } = llmConfig;
        if (!provider || !apiKey || !model) {
            throw new Error("Provider, API Key, and Model must be defined in config.");
        }

        const postData = JSON.stringify({
            model: model,
            messages: [{ role: "user", content: "test" }],
            max_tokens: 1
        });

        const options = {
            hostname: 'api.openai.com', // Most services use an OpenAI-compatible API
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        if (provider === 'anthropic') {
            options.hostname = 'api.anthropic.com';
            options.headers['x-api-key'] = apiKey;
            options.headers['anthropic-version'] = '2023-06-01';
            delete options.headers['Authorization'];
        }
        
        await new Promise((resolve, reject) => {
            const req = https.request(options, (res) => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve();
                } else {
                    reject(new Error(`API returned status ${res.statusCode}`));
                }
            });
            req.on('error', reject);
            req.write(postData);
            req.end();
        });

        console.log(`\r${colors.green}✔ Success: LLM credentials are valid.${colors.reset}`);
    } catch (error) {
        console.log(`\r${colors.red}✖ Failure: LLM credentials failed.${colors.reset}  `);
        console.error(`  ${colors.grey}> ${error.message}${colors.reset}`);
    }
}


/**
 * Tests the configured S3 credentials by attempting to list bucket contents.
 * @param {object} s3Config - The S3 configuration object.
 */
async function testS3Credentials(s3Config) {
    process.stdout.write("☁️  Testing S3 credentials...");
    try {
        const { provider, accessKeyId, secretAccessKey, bucket, region } = s3Config;
        if (!provider || !accessKeyId || !secretAccessKey || !bucket || !region) {
            throw new Error("Provider, keys, bucket, and region must be defined in config.");
        }

        let hostname = '';
        if (provider === 'digitalocean') hostname = `${bucket}.${region}.digitaloceanspaces.com`;
        else if (provider === 's3') hostname = `${bucket}.s3.${region}.amazonaws.com`;
        else if (provider === 'google') hostname = `storage.googleapis.com`;
        else throw new Error(`Unsupported S3 provider: ${provider}`);
        
        const amzDate = new Date().toISOString().replace(/[:\-]|\.\d{3}/g, '');
        const dateStamp = amzDate.substring(0, 8);
        const canonicalRequest = `GET\n/\n\nhost:${hostname}\nx-amz-date:${amzDate}\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`;
        const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${dateStamp}/${region}/s3/aws4_request\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;
        
        const kDate = crypto.createHmac('sha256', 'AWS4' + secretAccessKey).update(dateStamp).digest();
        const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
        const kService = crypto.createHmac('sha256', kRegion).update('s3').digest();
        const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
        const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

        const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${dateStamp}/${region}/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=${signature}`;

        const options = {
            hostname: hostname,
            path: '/',
            method: 'GET',
            headers: {
                'Authorization': authHeader,
                'x-amz-date': amzDate
            }
        };

        await new Promise((resolve, reject) => {
            const req = https.request(options, (res) => {
                if (res.statusCode === 200 || res.statusCode === 403) {
                    resolve();
                } else {
                    reject(new Error(`API returned status ${res.statusCode}`));
                }
            });
            req.on('error', reject);
            req.end();
        });

        console.log(`\r${colors.green}✔ Success: S3 credentials are valid.${colors.reset}   `);
    } catch (error) {
        console.log(`\r${colors.red}✖ Failure: S3 credentials failed.${colors.reset}     `);
        console.error(`  ${colors.grey}> ${error.message}${colors.reset}`);
    }
}

/**
 * Exports a packet image to the configured S3 provider.
 * @param {string} filePath - Path to the packet image JSON file.
 * @param {object} config - The loaded ~/.unlockrc configuration.
 */
async function exportPacket(filePath, config) {
    console.log(`\n📦 Exporting packet from "${path.basename(filePath)}"...`);
    try {
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const packetImage = JSON.parse(fileContent);
        
        const imageForExport = JSON.parse(JSON.stringify(packetImage));
        
        // --- START OF MODIFICATION: Handle local content ---
        for (const item of imageForExport.sourceContent) {
            if (item.origin === 'internal' && item.content) {
                const contentFilePath = path.resolve(path.dirname(filePath), item.content);
                if (fs.existsSync(contentFilePath)) {
                    const fileBuffer = fs.readFileSync(contentFilePath);
                    item.contentB64 = fileBuffer.toString('base64');
                    delete item.content; // Remove the local path field
                } else {
                    console.warn(`${colors.yellow}⚠️  Warning: Content file not found for item "${item.title}":${colors.reset} ${contentFilePath}`);
                }
            }
        }
        // --- END OF MODIFICATION ---

        const shareFileName = `shared/img_${imageForExport.id.replace(/^img_/, '')}_${Date.now()}.json`;
        const jsonString = JSON.stringify(imageForExport, null, 2);
        
        const { provider, accessKeyId, secretAccessKey, bucket, region } = config.s3Provider;
        let hostname = '';
        if (provider === 'digitalocean') hostname = `${bucket}.${region}.digitaloceanspaces.com`;
        else if (provider === 's3') hostname = `${bucket}.s3.${region}.amazonaws.com`;
        else if (provider === 'google') hostname = `storage.googleapis.com`;
        else throw new Error(`Unsupported S3 provider: ${provider}`);

        const amzDate = new Date().toISOString().replace(/[:\-]|\.\d{3}/g, '');
        const dateStamp = amzDate.substring(0, 8);
        const payloadHash = crypto.createHash('sha256').update(jsonString).digest('hex');
        const canonicalRequest = `PUT\n/${shareFileName}\n\ncontent-type:application/json\nhost:${hostname}\nx-amz-acl:public-read\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n\ncontent-type;host;x-amz-acl;x-amz-content-sha256;x-amz-date\n${payloadHash}`;
        const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${dateStamp}/${region}/s3/aws4_request\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;
        
        const kDate = crypto.createHmac('sha256', 'AWS4' + secretAccessKey).update(dateStamp).digest();
        const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
        const kService = crypto.createHmac('sha256', kRegion).update('s3').digest();
        const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
        const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

        const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${dateStamp}/${region}/s3/aws4_request, SignedHeaders=content-type;host;x-amz-acl;x-amz-content-sha256;x-amz-date, Signature=${signature}`;

        const options = {
            hostname,
            path: `/${shareFileName}`,
            method: 'PUT',
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(jsonString),
                'x-amz-acl': 'public-read',
                'x-amz-date': amzDate,
                'x-amz-content-sha256': payloadHash,
            }
        };

        await new Promise((resolve, reject) => {
            const req = https.request(options, (res) => {
                if (res.statusCode === 200) {
                    resolve();
                } else {
                    let body = '';
                    res.on('data', (chunk) => body += chunk);
                    res.on('end', () => reject(new Error(`API returned status ${res.statusCode}: ${body}`)));
                }
            });
            req.on('error', reject);
            req.write(jsonString);
            req.end();
        });

        let publicUrl = '';
        if (provider === 'digitalocean') publicUrl = `https://${bucket}.${region}.digitaloceanspaces.com/${shareFileName}`;
        else if (provider === 's3') publicUrl = `https://${bucket}.s3.${region}.amazonaws.com/${shareFileName}`;
        else if (provider === 'google') publicUrl = `https://storage.googleapis.com/${bucket}/${shareFileName}`;

        console.log(`${colors.green}✔ Success! Packet exported to:${colors.reset}`);
        console.log(`  ${publicUrl}`);

    } catch (error) {
        console.error(`${colors.red}✖ Export failed:${colors.reset}`);
        console.error(`  ${colors.grey}> ${error.message}${colors.reset}`);
    }
}

/**
 * Main function to handle command-line input.
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const filename = args[1];

  if (command === 'config' && !filename) {
    createTemplateConfig();
    process.exit(0);
  }

  const validCommands = ['validate', 'winnable', 'healthcheck', 'config', 'test-creds', 'export'];
  if (!validCommands.includes(command)) {
    console.error('Usage: pkt <validate|winnable|healthcheck|export> <filename>');
    console.error('       pkt <config|test-creds>');
    process.exit(1);
  }
  
  const config = readConfig();
  if (!config && (command === 'test-creds' || command === 'export')) {
      console.error(`${colors.red}Config file not found. Please run "pkt config" first.${colors.reset}`);
      process.exit(1);
  }

  if (command === 'test-creds') {
      await testS3Credentials(config.s3Provider);
      await testLlmCredentials(config.llmService);
      process.exit(0);
  }

  if (!filename) {
      console.error(`Error: The "${command}" command requires a filename.`);
      process.exit(1);
  }

  const filePath = path.resolve(filename);

  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found at ${filePath}`);
    process.exit(1);
  }
  
  if (command === 'export') {
      await exportPacket(filePath, config);
      process.exit(0);
  }

  try {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const packetImage = JSON.parse(fileContent);
    let errors = [];

    if (command === 'validate') {
        errors = validatePacketSchema(packetImage);
    } else if (command === 'winnable') {
        errors = validatePacketSchema(packetImage);
        if (errors.length === 0) {
            errors = validatePacketWinnability(packetImage);
        }
    } else if (command === 'healthcheck') {
        await validateExternalLinks(packetImage);
        process.exit(0);
    }

    if (errors.length === 0) {
      console.log(`✅ Success: Packet image "${filename}" is valid and completable.`);
      process.exit(0);
    } else {
      console.error(`❌ Validation failed for "${filename}":`);
      errors.forEach(err => console.error(`- ${err}`));
      process.exit(1);
    }
  } catch (parseError) {
    console.error(`Error: Could not parse file as JSON. ${parseError.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}