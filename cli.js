#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

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
  const requiredKeys = ['id', 'topic', 'created', 'sourceContent'];
  const missingKeys = requiredKeys.filter(key => !(key in packetImage));
  if (missingKeys.length > 0) {
    errors.push(`Missing required top-level keys: ${missingKeys.join(', ')}.`);
  }

  // Check key types
  if (packetImage.id && typeof packetImage.id !== 'string') {
    errors.push('Key "id" must be a string.');
  }
  if (packetImage.topic && typeof packetImage.topic !== 'string') {
    errors.push('Key "topic" must be a string.');
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
 * Main function to handle command-line input.
 */
function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const filename = args[1];

  if (command !== 'validate' || !filename) {
    console.error('Usage: pkt validate <filename>');
    process.exit(1);
  }

  const filePath = path.resolve(filename);

  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found at ${filePath}`);
    process.exit(1);
  }

  try {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const packetImage = JSON.parse(fileContent);
    const errors = validatePacketSchema(packetImage);

    if (errors.length === 0) {
      console.log(`✅ Success: Packet image "${filename}" is well-formed and valid.`);
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